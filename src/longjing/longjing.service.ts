import {
  Injectable,
  Logger,
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { LongjingRequestDto } from './dto/api-request.dto';
import {
  LongjingResponseDto,
  SignedAccumulatorDto,
  UsageDto,
} from './dto/api-response.dto';
import { applyRefund } from './accumulator';
import { BlockchainService } from './blockchain.service';
import { NullifierStoreService } from './nullifier-store.service';
import { ProofVerifierService } from './proof-verifier.service';
import { EthRateOracleService } from './eth-rate-oracle.service';
import { RefundSignerService } from './refund-signer.service';
import { SlashingService } from './slashing.service';
import { quantizeCost, quantizeUnits } from './utils/cost-quantization.util';
import { padResponse } from './utils/response-padding.util';
import {
  parseFieldElement,
  signalXMatchesRequest,
} from './utils/payload-signal.util';
import {
  ClaudeModel,
  DEFAULT_CLAUDE_MODEL,
  MAX_OUTPUT_TOKENS,
  claudeCostUSD,
  isClaudeModel,
} from '../pricing/claude-pricing';

// Messages API framing adds a few tokens around the user's payload
const MESSAGE_OVERHEAD_TOKENS = 32;

/**
 * Main service for handling ZK-based API requests
 * Generic implementation that can be adapted to any API service
 * Claude API is provided as a reference implementation
 */
@Injectable()
export class LongjingService {
  private readonly logger = new Logger(LongjingService.name);
  private readonly anthropic: Anthropic;

  constructor(
    private readonly configService: ConfigService,
    private readonly nullifierStore: NullifierStoreService,
    private readonly proofVerifier: ProofVerifierService,
    private readonly ethRateOracle: EthRateOracleService,
    private readonly refundSigner: RefundSignerService,
    private readonly slashingService: SlashingService,
    private readonly blockchain: BlockchainService,
  ) {
    // Example: Initialize Claude API client
    // Replace with your own API service client initialization
    const apiKey = this.configService.get<string>('ANTHROPIC_API_KEY');
    if (!apiKey) {
      this.logger.warn(
        'ANTHROPIC_API_KEY not found. API calls will use mock responses.',
      );
    }
    this.anthropic = new Anthropic({ apiKey: apiKey || 'mock-key' });
  }

  /**
   * Serve one request (docs/SETTLEMENT.md): check the proof against a recent
   * root and C_MAX, record (N, x, y), call the provider, and return the next
   * accumulator A' = A_pub + v·G + J, signed. Nothing in the request or what
   * is stored identifies the note.
   */
  async handleRequest(req: LongjingRequestDto): Promise<LongjingResponseDto> {
    const model = req.model ?? DEFAULT_CLAUDE_MODEL;
    if (!isClaudeModel(model)) {
      throw new BadRequestException(`Unsupported model: ${model}`);
    }

    // Stored in canonical form, as the exit watcher stores exit nullifiers
    const nullifier = parseFieldElement(req.nullifier).toString();

    // 1. Check per-nullifier rate limit (before expensive operations)
    if (!this.nullifierStore.checkRateLimit(nullifier)) {
      throw new ForbiddenException(
        'Rate limit exceeded for this nullifier. Maximum 3 requests per minute.',
      );
    }

    // 2. Bind the signal to the payload: x = Poseidon(H(payload), ρ)
    if (!(await signalXMatchesRequest(req.signal.x, req.payload, req.nonce))) {
      throw new BadRequestException(
        'Signal x does not match the payload and nonce',
      );
    }

    // 3. Reject before anything is consumed if C_MAX can't cover the worst case
    const cMax = this.cMax();
    const worstCaseCost = await this.worstCaseCostInETH(req.payload, model);
    if (worstCaseCost > cMax) {
      throw new BadRequestException(
        `The worst-case cost of ${worstCaseCost} wei for ${model} exceeds C_MAX`,
      );
    }

    // 4. Verify the proof against a recent root, C_MAX and this server's key
    const valid = await this.proofVerifier.verify(req.proof, {
      nullifier: req.nullifier,
      signalY: req.signal.y,
      accumulatorX: req.accumulator.x,
      accumulatorY: req.accumulator.y,
      merkleRoot: req.merkleRoot,
      maxCost: cMax,
      signalX: req.signal.x,
    });
    if (!valid) {
      throw new UnauthorizedException('Invalid ZK proof');
    }

    // 5. Atomically record (N, x, y), in canonical form
    const signal = {
      x: parseFieldElement(req.signal.x).toString(),
      y: parseFieldElement(req.signal.y).toString(),
    };
    const existingSignal = this.nullifierStore.checkAndSet(nullifier, signal);

    if (existingSignal) {
      if (existingSignal.x !== signal.x) {
        // Two signals at one index reveal k, and knowing k is the slashing proof
        this.logger.error(
          `Double-spend detected for nullifier ${req.nullifier}`,
        );
        await this.slashingService.slashRevealed(existingSignal, signal);
        throw new ForbiddenException(
          'Double-spend detected. Your secret key has been extracted and you will be slashed.',
        );
      }

      // A retry of a request whose response was lost gets it back, once paid
      const cached = this.nullifierStore.recallResponse<
        LongjingResponseDto | BadGatewayException
      >(nullifier, signal);
      if (cached instanceof BadGatewayException) throw cached;
      if (cached) return cached;
      throw new ForbiddenException('Nullifier already used');
    }

    const publishedAccumulator = [
      parseFieldElement(req.accumulator.x),
      parseFieldElement(req.accumulator.y),
    ] as const;

    // 6. Execute API request (Claude example). If it fails, nothing was
    // served: refund all of C_MAX, so the note moves on without losing value.
    let response: Awaited<ReturnType<typeof this.executeClaudeRequest>>;
    try {
      response = await this.executeClaudeRequest(req.payload, model);
    } catch (error) {
      this.logger.error('Provider call failed, refunding C_MAX', error);
      const failure = new BadGatewayException({
        message: 'The provider call failed. The whole of C_MAX is refunded.',
        refund: cMax.toString(),
        accumulator: await this.nextAccumulator(publishedAccumulator, cMax),
      });
      this.nullifierStore.rememberResponse(nullifier, signal, failure);
      throw failure;
    }

    // 7. Calculate actual cost in ETH (internal only)
    const actualCost = await this.calculateCostInETH(
      response.usage._internalInputTokens ?? 0,
      response.usage._internalOutputTokens ?? 0,
      model,
    );

    // 8. v = C_MAX − C_actual, clamped to [0, C_MAX]
    const refund = actualCost < cMax ? cMax - actualCost : 0n;

    // Fixed: Remove internal fields before returning to client
    const sanitizedUsage: UsageDto = {
      unitClass: response.usage.unitClass,
      unitType: response.usage.unitType,
      costClass: response.usage.costClass,
      provider: response.usage.provider,
      endpoint: response.usage.endpoint,
      timestamp: response.usage.timestamp,
      // _internalUnits and _internalCostUSD are intentionally excluded
    };

    const result: LongjingResponseDto = {
      // Fixed: Apply response padding to prevent size-based linkability
      response: padResponse(response.content),
      refund: refund.toString(),
      accumulator: await this.nextAccumulator(publishedAccumulator, refund),
      usage: sanitizedUsage,
    };
    this.nullifierStore.rememberResponse(nullifier, signal, result);
    return result;
  }

  /** A' = A_pub + v·G + J, signed with the refund key */
  private async nextAccumulator(
    published: readonly [bigint, bigint],
    refund: bigint,
  ): Promise<SignedAccumulatorDto> {
    const next = applyRefund(published, refund);
    return {
      x: next[0].toString(),
      y: next[1].toString(),
      signature: await this.refundSigner.signAccumulator(next),
    };
  }

  /** C_MAX from the contract; requests can't be priced without it */
  private cMax(): bigint {
    try {
      return this.blockchain.getCMax();
    } catch (error) {
      this.logger.error('C_MAX unavailable', error);
      throw new ServiceUnavailableException(
        'Cannot read C_MAX from the contract',
      );
    }
  }

  /**
   * Upper bound on a request's cost in ETH (wei), known before the upstream call.
   * Every token covers at least one UTF-8 byte, so the byte length bounds the input.
   */
  private async worstCaseCostInETH(
    payload: string,
    model: ClaudeModel,
  ): Promise<bigint> {
    const inputTokens =
      Buffer.byteLength(payload, 'utf8') + MESSAGE_OVERHEAD_TOKENS;
    return this.calculateCostInETH(inputTokens, MAX_OUTPUT_TOKENS, model);
  }

  /**
   * Calculate cost in ETH (wei) for external API usage
   * Example implementation for Claude API - adapt for your external service
   */
  private async calculateCostInETH(
    inputTokens: number,
    outputTokens: number,
    model: ClaudeModel,
  ): Promise<bigint> {
    const costUSD = claudeCostUSD(model, inputTokens, outputTokens);

    // Convert to ETH (wei)
    const costWei = await this.ethRateOracle.usdToWei(costUSD);

    this.logger.debug(
      `Cost calculation: ${inputTokens} in + ${outputTokens} out = $${costUSD.toFixed(6)} = ${costWei} wei`,
    );

    return costWei;
  }

  /**
   * Execute external API request (Claude example)
   * Falls back to mock if ANTHROPIC_API_KEY is not configured
   * Replace this method with your own external API integration
   */
  private async executeClaudeRequest(
    payload: string,
    model: ClaudeModel,
  ): Promise<{ content: string; usage: UsageDto }> {
    const apiKey = this.configService.get<string>('ANTHROPIC_API_KEY');

    // Use mock response if no API key configured
    if (!apiKey) {
      return this.mockClaudeRequest(payload, model);
    }

    try {
      this.logger.debug(`Executing Claude API request with ${model}`);

      const message = await this.anthropic.messages.create({
        model: model,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [{ role: 'user', content: payload }],
      });

      // Extract text content from response
      const textContent = message.content
        .filter((block) => block.type === 'text')
        .map((block) => ('text' in block ? block.text : ''))
        .join('\n');

      const inputTokens = message.usage.input_tokens;
      const outputTokens = message.usage.output_tokens;
      const totalTokens = inputTokens + outputTokens;

      // Fixed: Calculate actual cost (internal only)
      const actualCostUSD = claudeCostUSD(model, inputTokens, outputTokens);

      // Fixed: Quantize units and cost
      const { unitClass } = quantizeUnits(totalTokens);
      const { costClass } = quantizeCost(actualCostUSD);

      return {
        content: textContent,
        usage: {
          unitClass,
          unitType: 'tokens',
          costClass,
          // Internal fields for billing (not exposed to client)
          _internalUnits: totalTokens,
          _internalCostUSD: actualCostUSD,
          // Store individual token counts for cost calculation
          _internalInputTokens: inputTokens,
          _internalOutputTokens: outputTokens,
        },
      };
    } catch (error) {
      this.logger.error('Claude API request failed', error);
      throw new Error('Failed to execute Claude API request', {
        cause: error,
      });
    }
  }

  /**
   * Mock API response for development/testing
   * Example implementation for Claude - adapt for your external service
   */
  private mockClaudeRequest(
    payload: string,
    model: ClaudeModel,
  ): { content: string; usage: UsageDto } {
    this.logger.debug(`Using mock Claude API response for ${model}`);

    // Simulate API call
    const inputTokens = Math.ceil(payload.length / 4); // Rough estimate
    const outputTokens = Math.floor(Math.random() * 500) + 100; // Random response size
    const totalTokens = inputTokens + outputTokens;

    const mockResponse = `This is a mock Claude ${model} response to: "${payload.slice(0, 50)}..."`;

    // Fixed: Calculate actual cost (internal only)
    const actualCostUSD = claudeCostUSD(model, inputTokens, outputTokens);

    // Fixed: Quantize units and cost
    const { unitClass } = quantizeUnits(totalTokens);
    const { costClass } = quantizeCost(actualCostUSD);

    return {
      content: mockResponse,
      usage: {
        unitClass,
        unitType: 'tokens',
        costClass,
        // Internal fields for billing (not exposed to client)
        _internalUnits: totalTokens,
        _internalCostUSD: actualCostUSD,
        // Store individual token counts for cost calculation
        _internalInputTokens: inputTokens,
        _internalOutputTokens: outputTokens,
      },
    };
  }

  /**
   * Get server's public key for client-side signature verification
   */
  async getServerPublicKey(): Promise<{ x: string; y: string }> {
    return this.refundSigner.getPublicKey();
  }
}
