import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'crypto';
import { LongjingRequestDto } from './dto/api-request.dto';
import { LongjingResponseDto, UsageDto } from './dto/api-response.dto';
import { NullifierStoreService } from './nullifier-store.service';
import { ProofVerifierService } from './proof-verifier.service';
import { EthRateOracleService } from './eth-rate-oracle.service';
import { RefundSignerService } from './refund-signer.service';
import { SlashingService } from './slashing.service';
import { SlashingProofService } from './slashing-proof.service';
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

/**
 * Main service for handling ZK-based API requests
 * Generic implementation that can be adapted to any API service
 * Claude API is provided as a reference implementation
 */
@Injectable()
export class LongjingService {
  private readonly logger = new Logger(LongjingService.name);
  private readonly anthropic: Anthropic;
  private poseidon: any;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly nullifierStore: NullifierStoreService,
    private readonly proofVerifier: ProofVerifierService,
    private readonly ethRateOracle: EthRateOracleService,
    private readonly refundSigner: RefundSignerService,
    private readonly slashingService: SlashingService,
    private readonly slashingProofService: SlashingProofService,
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
   * Initialize Poseidon hash (lazy initialization)
   */
  private async initialize() {
    if (this.poseidon) {
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      try {
        // Use require instead of dynamic import to avoid ESM issues
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
        const circomlibjs = require('circomlibjs');
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        this.poseidon = await circomlibjs.buildPoseidon();
        this.logger.debug(
          'Poseidon hash initialized for secret key extraction',
        );
      } catch (error) {
        this.logger.error('Failed to initialize Poseidon hash', error);
        throw error;
      }
    })();

    return this.initPromise;
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

    // 4. Atomically check nullifier and insert if new
    // This prevents TOCTOU race conditions in concurrent scenarios
    const payloadHash = this.hashPayload(req.payload);
    const existingSignal = this.nullifierStore.checkAndSet(req.nullifier, {
      ...req.signal,
      payloadHash,
      ticketIndex: req.ticketIndex,
      idCommitment: req.idCommitment,
    });

    if (existingSignal) {
      // Nullifier already used
      if (
        parseFieldElement(existingSignal.x) !== parseFieldElement(req.signal.x)
      ) {
        // Double-spend detected! Two different signals with same nullifier
        this.logger.error(
          `Double-spend detected for nullifier ${req.nullifier}`,
        );

        // Extract secret key from two signals using field arithmetic
        const secretKey = await this.extractSecretKey(
          existingSignal,
          req.signal,
        );

        // Submit slashing transaction to smart contract
        this.logger.warn(`Secret key extracted: ${secretKey.slice(0, 10)}...`);

        if (this.slashingService.isEnabled()) {
          try {
            // Get metadata from stored signal
            const ticketIndex =
              existingSignal.ticketIndex || req.ticketIndex || '0';
            const idCommitment =
              existingSignal.idCommitment || req.idCommitment;

            if (!idCommitment) {
              throw new Error(
                'Missing idCommitment - cannot generate slashing proof',
              );
            }

            // Strip 0x prefix from hex strings for circuit input
            const stripHex = (hex: string) =>
              hex.startsWith('0x') ? hex.slice(2) : hex;

            // Generate ZK proof of correct secret key extraction
            this.logger.log('Generating slashing proof...');
            const { proof, publicSignals } =
              await this.slashingProofService.generateSlashingProof({
                signal1_x: existingSignal.x,
                signal1_y: existingSignal.y,
                signal2_x: req.signal.x,
                signal2_y: req.signal.y,
                secretKey: stripHex(secretKey),
                nullifier: stripHex(req.nullifier),
                ticketIndex: ticketIndex,
              });

            this.logger.log('Slashing proof generated successfully');

            // Submit transaction with proof
            const txHash = await this.slashingService.slashDoubleSpend(
              secretKey,
              req.nullifier,
              idCommitment,
              existingSignal,
              req.signal,
              ticketIndex,
              proof,
              publicSignals,
            );
            this.logger.log(
              `Slashing transaction submitted: ${txHash || 'disabled'}`,
            );
          } catch (error) {
            this.logger.error('Failed to submit slashing transaction', error);
            // Continue to reject the request even if slashing fails
          }
        } else {
          this.logger.warn(
            'Slashing disabled - no contract or transaction signer (see docs/LOCAL_SETUP.md)',
          );
        }

        throw new ForbiddenException(
          'Double-spend detected. Your secret key has been extracted and you will be slashed.',
        );
      }

      // Same nullifier with same signal = replay attack
      throw new ForbiddenException('Nullifier already used');
    }

    // 5. Execute API request (Claude example)
    const response = await this.executeClaudeRequest(req.payload, model);

    // 6. Calculate actual cost in ETH (internal only)
    const actualCost = await this.calculateCostInETH(
      response.usage._internalInputTokens ?? 0,
      response.usage._internalOutputTokens ?? 0,
      model,
    );

    // 7. Generate refund ticket
    const refundValue = BigInt(req.maxCost) - actualCost;
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
   * Extract secret key from two RLN signals using field arithmetic
   * Given: y1 = k + a*x1 and y2 = k + a*x2
   * Solve: k = (x2*y1 - x1*y2) / (x2 - x1) mod p
   */
  private async extractSecretKey(
    signal1: { x: string; y: string },
    signal2: { x: string; y: string },
  ): Promise<string> {
    await this.initialize();

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const F = this.poseidon.F;

    // Convert hex strings to BigInt (handle both with and without 0x prefix)
    const toBigInt = (value: string): bigint => {
      const str = value.trim();
      if (str.startsWith('0x') || str.startsWith('-0x')) {
        return BigInt(str);
      }
      if (/^-?\d+$/.test(str)) {
        return BigInt(str);
      }
      return BigInt('0x' + str);
    };

    const x1 = toBigInt(signal1.x);
    const y1 = toBigInt(signal1.y);
    const x2 = toBigInt(signal2.x);
    const y2 = toBigInt(signal2.y);

    // Prevent division by zero
    if (x2 === x1) {
      throw new Error('Invalid signals: x values are identical');
    }

    // Field arithmetic: k = (x2*y1 - x1*y2) / (x2 - x1) mod p
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const numerator = F.sub(F.mul(F.e(x2), F.e(y1)), F.mul(F.e(x1), F.e(y2)));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const denominator = F.sub(F.e(x2), F.e(x1));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const k = F.div(numerator, denominator);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    return '0x' + F.toObject(k).toString(16).padStart(64, '0');
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

  /**
   * Hash payload for policy violation evidence
   * Uses SHA256 to create a deterministic hash of the request payload
   */
  private hashPayload(payload: string): string {
    const hash = createHash('sha256').update(payload).digest('hex');
    return '0x' + hash;
  }
}
