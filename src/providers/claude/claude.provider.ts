import { Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { BaseProvider } from '../core/base.provider';
import {
  ApiProvider,
  ProviderConfig,
  ProviderRequest,
  ProviderResponse,
  CostEstimate,
  UsageMetrics,
  RateLimitConfig,
  ValidationResult,
  ProviderHealth,
} from '../core/provider.interface';
import { PricingModel } from '../../pricing/dto/pricing-model.dto';

/**
 * Claude API Provider
 * Implements Anthropic's Claude API as a provider in the universal Longjing proxy
 */
@Injectable()
export class ClaudeProvider extends BaseProvider implements ApiProvider {
  readonly id = 'claude';
  readonly name = 'Anthropic Claude API';
  readonly version = '1.0.0';

  private anthropic?: Anthropic;

  /**
   * Get hardcoded pricing configuration for Claude API
   * Based on Anthropic's pricing as of March 2026
   */
  getPricingConfig(): PricingModel {
    return {
      providerId: 'claude',
      endpoint: '/v1/messages',
      pricingType: 'per-token',
      rates: [
        {
          type: 'per-token',
          rate: 0.003, // $3 per million input tokens
          unit: 'input_token',
        },
        {
          type: 'per-token',
          rate: 0.015, // $15 per million output tokens
          unit: 'output_token',
        },
        {
          type: 'per-token',
          rate: 0.00375, // $3.75 per million cache write tokens (25% markup)
          unit: 'cache_creation_input_token',
        },
        {
          type: 'per-token',
          rate: 0.0003, // $0.30 per million cache read tokens (90% discount)
          unit: 'cache_read_input_token',
        },
      ],
      currency: 'USD',
      effectiveFrom: new Date('2025-01-01'),
    };
  }

  /**
   * Initialize Claude API client
   */
  initialize(config: ProviderConfig): Promise<void> {
    this.config = config;

    if (!config.apiKey) {
      this.logger.warn(
        'ANTHROPIC_API_KEY not provided. API calls will fail or use mock responses.',
      );
    }

    this.anthropic = new Anthropic({
      apiKey: config.apiKey || 'mock-key',
      timeout: config.timeout || 120000,
      maxRetries: config.retries || 2,
    });

    this.logger.log(`Claude provider initialized (v${this.version})`);

    return Promise.resolve();
  }

  /**
   * Validate Claude API request
   */
  async validateRequest(request: ProviderRequest): Promise<ValidationResult> {
    const baseValidation = await super.validateRequest(request);
    if (!baseValidation.valid) {
      return baseValidation;
    }

    const errors: string[] = [];

    // Validate Claude-specific fields
    if (!request.body) {
      errors.push('request body is required');
      return { valid: false, errors };
    }

    const { messages, model, maxTokens } = request.body as Record<string, any>;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      errors.push('messages array is required and cannot be empty');
    }

    if (model && typeof model !== 'string') {
      errors.push('model must be a string');
    }

    if (
      maxTokens !== undefined &&
      (!Number.isInteger(maxTokens) || maxTokens <= 0)
    ) {
      errors.push('maxTokens must be a positive integer');
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  /**
   * Execute Claude API request
   */
  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    this.ensureInitialized();

    if (!this.anthropic) {
      throw new Error('Anthropic client not initialized');
    }

    // Validate request
    const validation = await this.validateRequest(request);
    if (!validation.valid) {
      throw new Error(`Invalid request: ${validation.errors?.join(', ')}`);
    }

    // Extract Claude-specific parameters

    const {
      messages,
      model = 'claude-sonnet-4-5-20250929',
      maxTokens = 8192,
      temperature = 1.0,
      system,
      topP,
      topK,
      stopSequences,
      metadata,
      stream = false,
    } = request.body as Record<string, any>;

    try {
      this.logRequest(request);

      // Call Claude API

      const response = await this.anthropic.messages.create({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        model,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        max_tokens: maxTokens,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        temperature,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        system,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        messages,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        top_p: topP,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        top_k: topK,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        stop_sequences: stopSequences,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        metadata,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        stream,
      });

      // Extract usage metrics
      const usage = this.extractUsage(response);

      return {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
        body: {
          id: response.id,
          type: response.type,
          role: response.role,
          content: response.content,
          model: response.model,
          stopReason: response.stop_reason,
          stopSequence: response.stop_sequence,
        },
        usage,
        metadata: {
          model: response.model,
          responseId: response.id,
        },
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Claude API error: ${errorMessage}`);

      // Check if error is retryable
      if (this.isRetryableError(error)) {
        throw new Error(`Retryable error from Claude API: ${errorMessage}`, {
          cause: error,
        });
      }

      throw new Error(`Claude API error: ${errorMessage}`, { cause: error });
    }
  }

  /**
   * Estimate cost before request execution
   */
  estimateCost(request: ProviderRequest): Promise<CostEstimate> {
    const { messages, maxTokens = 1024 } = (request.metadata ||
      request.body ||
      {}) as Record<string, any>;

    // Estimate input tokens based on message length
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const estimatedInputTokens = this.estimateTokenCount(messages || []);
    const estimatedOutputTokens = maxTokens as number;

    // Get pricing rates
    const pricing = this.getPricingConfig();
    const inputRate =
      pricing.rates.find((r) => r.unit === 'input_token')?.rate || 0.003;
    const outputRate =
      pricing.rates.find((r) => r.unit === 'output_token')?.rate || 0.015;

    // Calculate costs (rates are per token, need to divide by 1M)
    const inputCostUSD = (estimatedInputTokens * inputRate) / 1_000_000;
    const outputCostUSD = (estimatedOutputTokens * outputRate) / 1_000_000;
    const estimatedCostUSD = inputCostUSD + outputCostUSD;

    return Promise.resolve({
      minCostUSD: estimatedCostUSD * 0.7, // -30% for cache hits and shorter responses
      maxCostUSD: estimatedCostUSD * 1.5, // +50% for longer responses
      estimatedCostUSD,
      confidence: 0.8,
      breakdown: {
        input: inputCostUSD,
        output: outputCostUSD,
      },
    });
  }

  /**
   * Calculate actual cost from response
   */
  calculateActualCost(response: ProviderResponse): Promise<UsageMetrics> {
    return Promise.resolve(response.usage);
  }

  /**
   * Get rate limit configuration
   */
  getRateLimits(): RateLimitConfig {
    return {
      requestsPerMinute: 50,
      requestsPerDay: 1000,
      concurrentRequests: 5,
    };
  }

  /**
   * Perform health check by calling the API
   */
  async healthCheck(): Promise<ProviderHealth> {
    this.ensureInitialized();

    if (!this.anthropic) {
      return {
        status: 'down',
        lastCheck: new Date(),
        message: 'Anthropic client not initialized',
      };
    }

    try {
      const start = Date.now();

      // Make a minimal API call to check health
      await this.anthropic.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'ping' }],
      });

      const latencyMs = Date.now() - start;

      return {
        status: 'healthy',
        latencyMs,
        lastCheck: new Date(),
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        status: 'down',
        lastCheck: new Date(),
        message,
      };
    }
  }

  /**
   * Extract usage metrics from Claude API response
   */
  private extractUsage(response: Anthropic.Message): UsageMetrics {
    const { usage } = response;

    // Get pricing rates
    const pricing = this.getPricingConfig();
    const inputRate =
      pricing.rates.find((r) => r.unit === 'input_token')?.rate || 0.003;
    const outputRate =
      pricing.rates.find((r) => r.unit === 'output_token')?.rate || 0.015;
    const cacheWriteRate =
      pricing.rates.find((r) => r.unit === 'cache_creation_input_token')
        ?.rate || 0.00375;
    const cacheReadRate =
      pricing.rates.find((r) => r.unit === 'cache_read_input_token')?.rate ||
      0.0003;

    // Calculate individual costs (rates are per token, divide by 1M)
    const inputCost = (usage.input_tokens * inputRate) / 1_000_000;
    const outputCost = (usage.output_tokens * outputRate) / 1_000_000;
    const cacheWriteCost =
      ((usage.cache_creation_input_tokens || 0) * cacheWriteRate) / 1_000_000;
    const cacheReadCost =
      ((usage.cache_read_input_tokens || 0) * cacheReadRate) / 1_000_000;

    const totalCostUSD =
      inputCost + outputCost + cacheWriteCost + cacheReadCost;

    // Total tokens
    const totalTokens =
      usage.input_tokens +
      usage.output_tokens +
      (usage.cache_creation_input_tokens || 0) +
      (usage.cache_read_input_tokens || 0);

    return {
      units: totalTokens,
      unitType: 'tokens',
      costUSD: totalCostUSD,
      breakdown: {
        input: usage.input_tokens,
        output: usage.output_tokens,
        cacheWrite: usage.cache_creation_input_tokens || 0,
        cacheRead: usage.cache_read_input_tokens || 0,
      },
    };
  }

  /**
   * Estimate token count from messages
   * Rough estimate: ~4 characters per token for English text
   */
  private estimateTokenCount(messages: any[]): number {
    if (!Array.isArray(messages)) {
      return 0;
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const totalChars = messages.reduce((sum: number, msg: any) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (!msg || !msg.content) {
        return sum;
      }

      let contentStr = '';
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (typeof msg.content === 'string') {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        contentStr = msg.content;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      } else if (Array.isArray(msg.content)) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        contentStr = (msg.content as any[])
          // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
          .map((c: any) => (typeof c === 'string' ? c : c.text || ''))

          .join('');
      }

      return sum + contentStr.length;
    }, 0);

    // Rough estimate: 4 characters per token
    return Math.ceil(totalChars / 4);
  }
}
