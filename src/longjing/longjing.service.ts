import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { LongjingRequestDto } from './dto/api-request.dto';
import { LongjingResponseDto, UsageDto } from './dto/api-response.dto';
import { NullifierStoreService } from './nullifier-store.service';
import { ProofVerifierService } from './proof-verifier.service';
import { EthRateOracleService } from './eth-rate-oracle.service';
import { RefundSignerService } from './refund-signer.service';
import { SlashingService } from './slashing.service';
import { quantizeCost, quantizeUnits } from './utils/cost-quantization.util';
import { padResponse } from './utils/response-padding.util';
import {
  parseFieldElement,
  signalXMatchesPayload,
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
   * Handle a Longjing request
   * Implements the full protocol: nullifier check, proof verification, API call, refund
   */
  async handleRequest(req: LongjingRequestDto): Promise<LongjingResponseDto> {
    const model = req.model ?? DEFAULT_CLAUDE_MODEL;
    if (!isClaudeModel(model)) {
      throw new BadRequestException(`Unsupported model: ${model}`);
    }

    // 1. Check per-nullifier rate limit (before expensive operations)
    if (!this.nullifierStore.checkRateLimit(req.nullifier)) {
      throw new ForbiddenException(
        'Rate limit exceeded for this nullifier. Maximum 3 requests per minute.',
      );
    }

    // 2. Bind the signal to the payload: x must equal Hash(payload)
    if (!signalXMatchesPayload(req.signal.x, req.payload)) {
      throw new BadRequestException('Signal x does not match payload hash');
    }

    // 3. Verify ZK proof with cryptographic verification and public inputs
    // Do this BEFORE nullifier check to prevent timing leaks
    const valid = await this.proofVerifier.verify(req.proof, {
      merkleRoot: req.merkleRoot,
      maxCost: req.maxCost,
      initialDeposit: req.initialDeposit,
      signalX: req.signal.x,
      nullifier: req.nullifier,
      signalY: req.signal.y,
      idCommitment: req.idCommitment,
      idCommitmentExpected: req.idCommitmentExpected,
    });
    if (!valid) {
      throw new UnauthorizedException('Invalid ZK proof');
    }

    // 4. Reject before the nullifier is consumed if maxCost can't cover the worst case
    const maxCost = parseFieldElement(req.maxCost);
    const worstCaseCost = await this.worstCaseCostInETH(req.payload, model);
    if (maxCost < worstCaseCost) {
      throw new BadRequestException(
        `maxCost is below the worst-case cost of ${worstCaseCost} wei for ${model}`,
      );
    }

    // 5. Atomically check nullifier and insert if new
    // This prevents TOCTOU race conditions in concurrent scenarios
    const existingSignal = this.nullifierStore.checkAndSet(req.nullifier, {
      x: req.signal.x,
      y: req.signal.y,
    });

    if (existingSignal) {
      if (
        parseFieldElement(existingSignal.x) !== parseFieldElement(req.signal.x)
      ) {
        // Two signals at one index reveal k, and knowing k is the slashing proof
        this.logger.error(
          `Double-spend detected for nullifier ${req.nullifier}`,
        );
        await this.slashRevealedKey(existingSignal, req.signal);
        throw new ForbiddenException(
          'Double-spend detected. Your secret key has been extracted and you will be slashed.',
        );
      }

      // Same nullifier with same signal = replay attack
      throw new ForbiddenException('Nullifier already used');
    }

    // 6. Execute API request (Claude example); if it fails, nothing was served,
    // so give the ticket index back instead of burning it
    let response: Awaited<ReturnType<typeof this.executeClaudeRequest>>;
    try {
      response = await this.executeClaudeRequest(req.payload, model);
    } catch (error) {
      this.nullifierStore.release(req.nullifier, req.signal.x);
      throw error;
    }

    // 7. Calculate actual cost in ETH (internal only)
    const actualCost = await this.calculateCostInETH(
      response.usage._internalInputTokens ?? 0,
      response.usage._internalOutputTokens ?? 0,
      model,
    );

    // 8. Generate refund ticket, never negative
    const refundValue = maxCost > actualCost ? maxCost - actualCost : 0n;
    const refundTicket = await this.refundSigner.signRefund({
      idCommitment: req.idCommitment,
      nullifier: req.nullifier,
      value: refundValue.toString(),
      timestamp: Date.now(),
    });

    this.logger.log(
      `Request processed. Cost: ${actualCost} wei, Refund: ${refundValue} wei`,
    );

    // Fixed: Apply response padding to prevent size-based linkability
    const paddedResponse = padResponse(response.content);

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

    return {
      response: paddedResponse,
      actualCost: actualCost.toString(),
      refundTicket,
      usage: sanitizedUsage,
    };
  }

  /**
   * Recovers k from two signals that share a nullifier and slashes its note.
   * A failed transaction is logged: the request is rejected either way.
   */
  private async slashRevealedKey(
    signal1: { x: string; y: string },
    signal2: { x: string; y: string },
  ): Promise<void> {
    if (!this.slashingService.isEnabled()) {
      this.logger.warn(
        'Slashing disabled - no contract or transaction signer (see docs/LOCAL_SETUP.md)',
      );
      return;
    }
    try {
      const secretKey = SlashingService.recoverSecretKey(
        {
          x: parseFieldElement(signal1.x),
          y: parseFieldElement(signal1.y),
        },
        {
          x: parseFieldElement(signal2.x),
          y: parseFieldElement(signal2.y),
        },
      );
      await this.slashingService.slash(secretKey);
    } catch (error) {
      this.logger.error('Failed to slash the double-spent note', error);
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
