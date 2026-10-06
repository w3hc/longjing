import { Test, TestingModule } from '@nestjs/testing';
import { ClaudeProvider } from './claude.provider';
import Anthropic from '@anthropic-ai/sdk';

jest.mock('@anthropic-ai/sdk');

describe('ClaudeProvider', () => {
  let provider: ClaudeProvider;
  let mockAnthropic: jest.Mocked<Anthropic>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ClaudeProvider],
    }).compile();

    provider = module.get<ClaudeProvider>(ClaudeProvider);

    // Mock Anthropic client
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    mockAnthropic = {
      messages: {
        create: jest.fn(),
      },
    } as any;
  });

  describe('metadata', () => {
    it('should have correct provider metadata', () => {
      expect(provider.id).toBe('claude');
      expect(provider.name).toBe('Anthropic Claude API');
      expect(provider.version).toBe('1.0.0');
    });
  });

  describe('getPricingConfig', () => {
    it('should return pricing configuration', () => {
      const pricing = provider.getPricingConfig();

      expect(pricing.providerId).toBe('claude');
      expect(pricing.endpoint).toBe('/v1/messages');
      expect(pricing.pricingType).toBe('per-token');
      expect(pricing.rates).toHaveLength(4);

      // Check input token pricing
      const inputRate = pricing.rates.find((r) => r.unit === 'input_token');
      expect(inputRate).toBeDefined();
      expect(inputRate?.rate).toBe(0.01);

      // Check output token pricing
      const outputRate = pricing.rates.find((r) => r.unit === 'output_token');
      expect(outputRate).toBeDefined();
      expect(outputRate?.rate).toBe(0.05);
    });
  });

  describe('initialize', () => {
    it('should initialize with API key', async () => {
      await provider.initialize({
        apiKey: 'test-api-key',
        timeout: 60000,
        retries: 3,
      });

      expect(Anthropic).toHaveBeenCalledWith({
        apiKey: 'test-api-key',
        timeout: 60000,
        maxRetries: 3,
      });
    });

    it('should initialize without API key (mock mode)', async () => {
      await provider.initialize({});

      expect(Anthropic).toHaveBeenCalledWith({
        apiKey: 'mock-key',
        timeout: 120000,
        maxRetries: 2,
      });
    });
  });

  describe('getPricingConfig for a model', () => {
    it('derives every rate from the shared pricing table', () => {
      const rates = Object.fromEntries(
        provider
          .getPricingConfig('claude-haiku-4-5')
          .rates.map((r): [string, number] => [r.unit ?? '', r.rate]),
      );

      expect(rates).toEqual({
        input_token: 0.001,
        output_token: 0.005,
        cache_creation_input_token: 0.00125,
        cache_read_input_token: 0.0001,
      });
    });
  });

  describe('validateRequest', () => {
    beforeEach(async () => {
      await provider.initialize({ apiKey: 'test-key' });
    });

    it('should validate valid request', async () => {
      const request = {
        endpoint: '/v1/messages',
        method: 'POST' as const,
        body: {
          messages: [{ role: 'user', content: 'Hello' }],
          model: 'claude-sonnet-4-6',
          maxTokens: 1024,
        },
      };

      const result = await provider.validateRequest(request);

      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should reject a model with no pricing', async () => {
      const result = await provider.validateRequest({
        endpoint: '/v1/messages',
        method: 'POST' as const,
        body: {
          messages: [{ role: 'user', content: 'Hello' }],
          model: 'claude-3-opus-20240229',
        },
      });

      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toMatch(/^model must be one of/);
    });

    it('should reject request without messages', async () => {
      const request = {
        endpoint: '/v1/messages',
        method: 'POST' as const,
        body: {
          model: 'claude-sonnet-4-6',
        },
      };

      const result = await provider.validateRequest(request);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        'messages array is required and cannot be empty',
      );
    });

    it('should reject request with empty messages array', async () => {
      const request = {
        endpoint: '/v1/messages',
        method: 'POST' as const,
        body: {
          messages: [],
        },
      };

      const result = await provider.validateRequest(request);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        'messages array is required and cannot be empty',
      );
    });

    it('should reject request with invalid maxTokens', async () => {
      const request = {
        endpoint: '/v1/messages',
        method: 'POST' as const,
        body: {
          messages: [{ role: 'user', content: 'Hello' }],
          maxTokens: -1,
        },
      };

      const result = await provider.validateRequest(request);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('maxTokens must be a positive integer');
    });
  });

  describe('execute', () => {
    beforeEach(async () => {
      await provider.initialize({ apiKey: 'test-key' });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (provider as any).anthropic = mockAnthropic;
    });

    it('should execute successful API call', async () => {
      const mockResponse: Anthropic.Message = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello!' }],
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
        },
      };

      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      mockAnthropic.messages.create.mockResolvedValue(mockResponse);

      const request = {
        endpoint: '/v1/messages',
        method: 'POST' as const,
        body: {
          messages: [{ role: 'user', content: 'Hello' }],
          model: 'claude-sonnet-4-6',
          maxTokens: 1024,
        },
      };

      const response = await provider.execute(request);

      expect(response.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect(response.body.content).toEqual([{ type: 'text', text: 'Hello!' }]);
      expect(response.usage.units).toBe(15);
      expect(response.usage.unitType).toBe('tokens');
      expect(response.usage.breakdown?.input).toBe(10);
      expect(response.usage.breakdown?.output).toBe(5);
    });

    it('should calculate cost correctly', async () => {
      const mockResponse: Anthropic.Message = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello!' }],
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
        },
      };

      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      mockAnthropic.messages.create.mockResolvedValue(mockResponse);

      const request = {
        endpoint: '/v1/messages',
        method: 'POST' as const,
        body: {
          messages: [{ role: 'user', content: 'Hello' }],
          model: 'claude-sonnet-4-6',
        },
      };

      const response = await provider.execute(request);

      // Sonnet 4.6: $3 / $15 per million tokens
      const expectedCost = (1000 * 3 + 500 * 15) / 1_000_000;

      expect(response.usage.costUSD).toBeCloseTo(expectedCost, 10);
    });

    it('should handle cache tokens', async () => {
      const mockResponse: Anthropic.Message = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello!' }],
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 300,
        },
      };

      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      mockAnthropic.messages.create.mockResolvedValue(mockResponse);

      const request = {
        endpoint: '/v1/messages',
        method: 'POST' as const,
        body: {
          messages: [{ role: 'user', content: 'Hello' }],
          model: 'claude-sonnet-4-6',
        },
      };

      const response = await provider.execute(request);

      expect(response.usage.breakdown?.cacheWrite).toBe(200);
      expect(response.usage.breakdown?.cacheRead).toBe(300);

      // Cost should include cache pricing
      const expectedCost =
        (100 * 3 + 50 * 15 + 200 * 3.75 + 300 * 0.3) / 1_000_000;
      expect(response.usage.costUSD).toBeCloseTo(expectedCost, 10);
    });

    it('should throw error for invalid request', async () => {
      const request = {
        endpoint: '/v1/messages',
        method: 'POST' as const,
        body: {
          messages: [],
        },
      };

      await expect(provider.execute(request)).rejects.toThrow(
        'Invalid request',
      );
    });

    it('should throw error when not initialized', async () => {
      const uninitializedProvider = new ClaudeProvider();
      const request = {
        endpoint: '/v1/messages',
        method: 'POST' as const,
        body: {
          messages: [{ role: 'user', content: 'Hello' }],
        },
      };

      await expect(uninitializedProvider.execute(request)).rejects.toThrow(
        'Provider claude not initialized',
      );
    });
  });

  describe('estimateCost', () => {
    beforeEach(async () => {
      await provider.initialize({ apiKey: 'test-key' });
    });

    it('should estimate cost for simple message', async () => {
      const request = {
        endpoint: '/v1/messages',
        method: 'POST' as const,
        body: {
          messages: [{ role: 'user', content: 'Hello, how are you?' }],
          maxTokens: 1000,
        },
      };

      const estimate = await provider.estimateCost(request);

      expect(estimate.estimatedCostUSD).toBeGreaterThan(0);
      expect(estimate.minCostUSD).toBeLessThan(estimate.estimatedCostUSD);
      expect(estimate.maxCostUSD).toBeGreaterThan(estimate.estimatedCostUSD);
      expect(estimate.confidence).toBe(0.8);
      expect(estimate.breakdown).toBeDefined();
      expect(estimate.breakdown?.input).toBeGreaterThan(0);
      expect(estimate.breakdown?.output).toBeGreaterThan(0);
    });

    it('should price the estimate with the requested model', async () => {
      const estimate = await provider.estimateCost({
        endpoint: '/v1/messages',
        method: 'POST' as const,
        body: {
          messages: [],
          maxTokens: 1_000_000,
          model: 'claude-haiku-4-5',
        },
      });

      expect(estimate.breakdown?.output).toBeCloseTo(5, 10);
    });

    it('should reject an estimate for a model with no pricing', async () => {
      await expect(
        provider.estimateCost({
          endpoint: '/v1/messages',
          method: 'POST' as const,
          body: { messages: [], model: 'claude-3-opus-20240229' },
        }),
      ).rejects.toThrow('model must be one of');
    });
  });

  describe('getRateLimits', () => {
    it('should return rate limit configuration', () => {
      const rateLimits = provider.getRateLimits();

      expect(rateLimits.requestsPerMinute).toBe(50);
      expect(rateLimits.requestsPerDay).toBe(1000);
      expect(rateLimits.concurrentRequests).toBe(5);
    });
  });

  describe('calculateActualCost', () => {
    beforeEach(async () => {
      await provider.initialize({ apiKey: 'test-key' });
    });

    it('should return usage from response', async () => {
      const response = {
        status: 200,
        headers: {},
        body: {},
        usage: {
          units: 100,
          unitType: 'tokens' as const,
          costUSD: 0.00001,
          breakdown: {
            input: 60,
            output: 40,
          },
        },
      };

      const usage = await provider.calculateActualCost(response);

      expect(usage).toEqual(response.usage);
    });
  });
});
