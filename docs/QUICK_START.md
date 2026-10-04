# Quick Start: Adding a New Provider

This guide walks you through adding a new API provider to the Longjing system. We'll use the Claude provider implementation as a reference example.

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Step-by-Step Guide](#step-by-step-guide)
- [Testing Your Provider](#testing-your-provider)
- [Common Patterns](#common-patterns)
- [Troubleshooting](#troubleshooting)

## Overview

Adding a new provider involves:

1. Creating a provider implementation that extends `BaseProvider`
2. Implementing required interface methods (pricing, execution, validation)
3. Creating DTOs for request/response validation
4. Registering the provider in the module system
5. Writing comprehensive tests

**Time estimate:** 2-4 hours for a simple provider

## Prerequisites

- Node.js 24+ installed
- Familiarity with NestJS and TypeScript
- API credentials for the service you're integrating
- Understanding of the provider's pricing model

## Step-by-Step Guide

### Step 1: Create Provider Directory Structure

```bash
mkdir -p src/providers/YOUR_PROVIDER/dto
touch src/providers/YOUR_PROVIDER/your-provider.provider.ts
touch src/providers/YOUR_PROVIDER/your-provider.config.ts
touch src/providers/YOUR_PROVIDER/dto/your-provider-request.dto.ts
touch src/providers/YOUR_PROVIDER/dto/your-provider-response.dto.ts
touch src/providers/YOUR_PROVIDER/your-provider.provider.spec.ts
touch src/providers/YOUR_PROVIDER/index.ts
```

**Example structure:**
```
src/providers/
├── claude/
│   ├── dto/
│   │   ├── claude-request.dto.ts
│   │   └── claude-response.dto.ts
│   ├── claude.config.ts
│   ├── claude.provider.spec.ts
│   ├── claude.provider.ts
│   └── index.ts
├── core/
└── registry/
```

### Step 2: Define Provider Configuration

Create a configuration file with constants for your provider.

**File:** `src/providers/YOUR_PROVIDER/your-provider.config.ts`

```typescript
/**
 * Your Provider configuration
 */
export const YOUR_PROVIDER_CONFIG = {
  /**
   * Default model/variant to use when not specified
   */
  DEFAULT_MODEL: 'your-default-model',

  /**
   * Supported models/variants
   */
  SUPPORTED_MODELS: [
    'model-1',
    'model-2',
    'model-3',
  ] as const,

  /**
   * Default request parameters
   */
  DEFAULTS: {
    timeout: 120000, // 2 minutes
    retries: 2,
  },

  /**
   * Rate limits (per provider account)
   */
  RATE_LIMITS: {
    requestsPerMinute: 50,
    requestsPerDay: 1000,
    concurrentRequests: 5,
  },
};

export type YourProviderModel = typeof YOUR_PROVIDER_CONFIG.SUPPORTED_MODELS[number];
```

**Real example from Claude provider:**

```typescript
export const CLAUDE_CONFIG = {
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  SUPPORTED_MODELS: [
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
  ] as const,
  DEFAULTS: {
    maxTokens: 8192,
    temperature: 1.0,
    timeout: 120000,
    retries: 2,
  },
  RATE_LIMITS: {
    requestsPerMinute: 50,
    requestsPerDay: 1000,
    concurrentRequests: 5,
  },
};
```

### Step 3: Create Request/Response DTOs

Define validation DTOs for your provider's API.

**File:** `src/providers/YOUR_PROVIDER/dto/your-provider-request.dto.ts`

```typescript
import {
  IsString,
  IsArray,
  IsOptional,
  IsNumber,
  Min,
  Max,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class YourProviderRequestDto {
  @ApiProperty({ description: 'Required field from API' })
  @IsString()
  requiredField: string;

  @ApiPropertyOptional({ description: 'Optional parameter', example: 'value' })
  @IsOptional()
  @IsString()
  optionalField?: string;

  @ApiPropertyOptional({ description: 'Numeric parameter', example: 100 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(10000)
  numericField?: number;
}
```

**File:** `src/providers/YOUR_PROVIDER/dto/your-provider-response.dto.ts`

```typescript
import { ApiProperty } from '@nestjs/swagger';

export class YourProviderResponseDto {
  @ApiProperty({ description: 'Response ID' })
  id: string;

  @ApiProperty({ description: 'Result data' })
  data: any;

  @ApiProperty({ description: 'Status' })
  status: string;
}
```

### Step 4: Implement Provider Class

This is the core implementation. You must implement all methods from the `ApiProvider` interface.

**File:** `src/providers/YOUR_PROVIDER/your-provider.provider.ts`

```typescript
import { Injectable } from '@nestjs/common';
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
 * Your Provider Implementation
 */
@Injectable()
export class YourProvider extends BaseProvider implements ApiProvider {
  readonly id = 'your-provider';
  readonly name = 'Your Provider Name';
  readonly version = '1.0.0';

  private client?: any; // Your API client

  /**
   * Step 4a: Define Hardcoded Pricing
   * This configuration is automatically seeded to the database when the provider registers.
   * To update pricing, modify this code and redeploy the application.
   */
  getPricingConfig(): PricingModel {
    return {
      providerId: 'your-provider',
      endpoint: '/v1/your-endpoint',
      pricingType: 'per-unit', // or 'per-token', 'per-call', 'tiered', 'composite'
      rates: [
        {
          type: 'per-unit',
          rate: 0.001, // USD per unit
          unit: 'request',
        },
      ],
      currency: 'USD',
      effectiveFrom: new Date('2025-01-01'),
    };
  }

  /**
   * Step 4b: Initialize Provider
   * Set up API client with credentials and configuration.
   */
  initialize(config: ProviderConfig): Promise<void> {
    this.config = config;

    if (!config.apiKey) {
      this.logger.warn('API key not provided. API calls may fail.');
    }

    // Initialize your API client
    this.client = new YourApiClient({
      apiKey: config.apiKey || 'mock-key',
      timeout: config.timeout || 120000,
      maxRetries: config.retries || 2,
    });

    this.logger.log(`${this.name} provider initialized (v${this.version})`);

    return Promise.resolve();
  }

  /**
   * Step 4c: Validate Requests
   * Check that incoming requests have all required fields.
   */
  async validateRequest(request: ProviderRequest): Promise<ValidationResult> {
    const baseValidation = await super.validateRequest(request);
    if (!baseValidation.valid) {
      return baseValidation;
    }

    const errors: string[] = [];

    if (!request.body) {
      errors.push('request body is required');
      return { valid: false, errors };
    }

    // Add provider-specific validation
    const { requiredField } = request.body as Record<string, any>;

    if (!requiredField) {
      errors.push('requiredField is required');
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  /**
   * Step 4d: Execute API Requests
   * Call the external API and return a standardized response.
   */
  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    this.ensureInitialized();

    if (!this.client) {
      throw new Error('API client not initialized');
    }

    // Validate request
    const validation = await this.validateRequest(request);
    if (!validation.valid) {
      throw new Error(`Invalid request: ${validation.errors?.join(', ')}`);
    }

    // Extract parameters from request body
    const { requiredField, optionalField } = request.body as Record<string, any>;

    try {
      this.logRequest(request);

      // Call your API
      const response = await this.client.makeRequest({
        field: requiredField,
        optional: optionalField,
      });

      // Calculate usage metrics
      const usage = this.extractUsage(response);

      return {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
        body: {
          id: response.id,
          data: response.data,
          status: response.status,
        },
        usage,
        metadata: {
          requestId: response.id,
        },
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`API error: ${errorMessage}`);

      if (this.isRetryableError(error)) {
        throw new Error(`Retryable error: ${errorMessage}`, { cause: error });
      }

      throw new Error(`API error: ${errorMessage}`, { cause: error });
    }
  }

  /**
   * Step 4e: Estimate Costs
   * Provide cost estimates before the user makes a request.
   */
  estimateCost(request: ProviderRequest): Promise<CostEstimate> {
    const { estimatedUnits = 1 } = (request.metadata || request.body || {}) as Record<string, any>;

    // Get pricing rates
    const pricing = this.getPricingConfig();
    const rate = pricing.rates[0]?.rate || 0.001;

    // Calculate estimated cost
    const estimatedCostUSD = (estimatedUnits as number) * rate;

    return Promise.resolve({
      minCostUSD: estimatedCostUSD * 0.8, // -20% for best case
      maxCostUSD: estimatedCostUSD * 1.2, // +20% for worst case
      estimatedCostUSD,
      confidence: 0.85,
      breakdown: {
        units: estimatedCostUSD,
      },
    });
  }

  /**
   * Step 4f: Calculate Actual Costs
   * Return the actual usage metrics from the response.
   */
  calculateActualCost(response: ProviderResponse): Promise<UsageMetrics> {
    return Promise.resolve(response.usage);
  }

  /**
   * Step 4g: Define Rate Limits
   * Specify rate limits for this provider.
   */
  getRateLimits(): RateLimitConfig {
    return {
      requestsPerMinute: 50,
      requestsPerDay: 1000,
      concurrentRequests: 5,
    };
  }

  /**
   * Step 4h: Health Check
   * Verify that the provider is operational.
   */
  async healthCheck(): Promise<ProviderHealth> {
    this.ensureInitialized();

    if (!this.client) {
      return {
        status: 'down',
        lastCheck: new Date(),
        message: 'API client not initialized',
      };
    }

    try {
      const start = Date.now();

      // Make a minimal API call to check health
      await this.client.ping();

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
   * Helper: Extract usage metrics from API response
   */
  private extractUsage(response: any): UsageMetrics {
    const pricing = this.getPricingConfig();
    const rate = pricing.rates[0]?.rate || 0.001;

    // Adjust based on your API's response structure
    const units = response.unitsUsed || 1;
    const costUSD = units * rate;

    return {
      units,
      unitType: 'calls', // or 'tokens', 'bytes', 'seconds', 'images', 'custom'
      costUSD,
      breakdown: {
        units,
      },
    };
  }
}
```

### Step 5: Create Index File

Export all provider components for easy imports.

**File:** `src/providers/YOUR_PROVIDER/index.ts`

```typescript
export * from './your-provider.provider';
export * from './your-provider.config';
export * from './dto/your-provider-request.dto';
export * from './dto/your-provider-response.dto';
```

### Step 6: Register Provider in Module

Update the LongjingModule to initialize and register your provider.

**File:** `src/longjing/longjing.module.ts`

```typescript
import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { YourProvider } from '../providers/your-provider'; // Add this import
// ... other imports

@Module({
  controllers: [LongjingController],
  providers: [
    // ... existing providers
    YourProvider, // Add your provider
  ],
  exports: [
    LongjingService,
    ProofGenService,
    BlockchainService,
    MerkleTreeService,
  ],
})
export class LongjingModule implements OnModuleInit {
  constructor(
    private readonly providerRegistry: ProviderRegistryService,
    private readonly yourProvider: YourProvider, // Add this
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Initialize your provider
    const apiKey = this.configService.get<string>('YOUR_API_KEY_ENV_VAR');
    await this.yourProvider.initialize({
      apiKey,
      timeout: 120000,
      retries: 2,
    });

    // Register your provider (pricing auto-seeds here!)
    this.providerRegistry.register(this.yourProvider);
  }
}
```

### Step 7: Update Provider Index

Add your provider to the main providers index.

**File:** `src/providers/index.ts`

```typescript
export * from './core';
export * from './registry';
export * from './claude';
export * from './your-provider'; // Add this line
```

## Testing Your Provider

### Step 8: Write Comprehensive Tests

Create a test file with comprehensive coverage.

**File:** `src/providers/YOUR_PROVIDER/your-provider.provider.spec.ts`

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { YourProvider } from './your-provider.provider';

// Mock your API client
jest.mock('your-api-client-package');

describe('YourProvider', () => {
  let provider: YourProvider;
  let mockClient: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [YourProvider],
    }).compile();

    provider = module.get<YourProvider>(YourProvider);

    // Mock API client
    mockClient = {
      makeRequest: jest.fn(),
      ping: jest.fn(),
    };
  });

  describe('metadata', () => {
    it('should have correct provider metadata', () => {
      expect(provider.id).toBe('your-provider');
      expect(provider.name).toBe('Your Provider Name');
      expect(provider.version).toBe('1.0.0');
    });
  });

  describe('getPricingConfig', () => {
    it('should return pricing configuration', () => {
      const pricing = provider.getPricingConfig();

      expect(pricing.providerId).toBe('your-provider');
      expect(pricing.pricingType).toBe('per-unit');
      expect(pricing.rates).toBeDefined();
      expect(pricing.rates[0].rate).toBeGreaterThan(0);
    });
  });

  describe('initialize', () => {
    it('should initialize with API key', async () => {
      await provider.initialize({
        apiKey: 'test-api-key',
        timeout: 60000,
        retries: 3,
      });

      // Verify initialization
      expect(provider['client']).toBeDefined();
    });
  });

  describe('validateRequest', () => {
    beforeEach(async () => {
      await provider.initialize({ apiKey: 'test-key' });
    });

    it('should validate valid request', async () => {
      const request = {
        endpoint: '/v1/endpoint',
        method: 'POST' as const,
        body: {
          requiredField: 'value',
        },
      };

      const result = await provider.validateRequest(request);

      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should reject request without required field', async () => {
      const request = {
        endpoint: '/v1/endpoint',
        method: 'POST' as const,
        body: {},
      };

      const result = await provider.validateRequest(request);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('requiredField is required');
    });
  });

  describe('execute', () => {
    beforeEach(async () => {
      await provider.initialize({ apiKey: 'test-key' });
      (provider as any).client = mockClient;
    });

    it('should execute successful API call', async () => {
      const mockResponse = {
        id: 'test-123',
        data: { result: 'success' },
        status: 'completed',
        unitsUsed: 10,
      };

      mockClient.makeRequest.mockResolvedValue(mockResponse);

      const request = {
        endpoint: '/v1/endpoint',
        method: 'POST' as const,
        body: {
          requiredField: 'value',
        },
      };

      const response = await provider.execute(request);

      expect(response.status).toBe(200);
      expect(response.body.id).toBe('test-123');
      expect(response.usage.units).toBe(10);
      expect(response.usage.costUSD).toBeGreaterThan(0);
    });

    it('should throw error for invalid request', async () => {
      const request = {
        endpoint: '/v1/endpoint',
        method: 'POST' as const,
        body: {},
      };

      await expect(provider.execute(request)).rejects.toThrow('Invalid request');
    });
  });

  describe('estimateCost', () => {
    it('should estimate cost', async () => {
      const request = {
        endpoint: '/v1/endpoint',
        method: 'POST' as const,
        metadata: {
          estimatedUnits: 100,
        },
      };

      const estimate = await provider.estimateCost(request);

      expect(estimate.estimatedCostUSD).toBeGreaterThan(0);
      expect(estimate.minCostUSD).toBeLessThan(estimate.estimatedCostUSD);
      expect(estimate.maxCostUSD).toBeGreaterThan(estimate.estimatedCostUSD);
      expect(estimate.confidence).toBeGreaterThan(0);
    });
  });

  describe('healthCheck', () => {
    beforeEach(async () => {
      await provider.initialize({ apiKey: 'test-key' });
      (provider as any).client = mockClient;
    });

    it('should return healthy status', async () => {
      mockClient.ping.mockResolvedValue(true);

      const health = await provider.healthCheck();

      expect(health.status).toBe('healthy');
      expect(health.latencyMs).toBeDefined();
      expect(health.lastCheck).toBeInstanceOf(Date);
    });

    it('should return down status on error', async () => {
      mockClient.ping.mockRejectedValue(new Error('Connection failed'));

      const health = await provider.healthCheck();

      expect(health.status).toBe('down');
      expect(health.message).toContain('Connection failed');
    });
  });

  describe('getRateLimits', () => {
    it('should return rate limit configuration', () => {
      const rateLimits = provider.getRateLimits();

      expect(rateLimits.requestsPerMinute).toBeDefined();
      expect(rateLimits.requestsPerDay).toBeDefined();
    });
  });
});
```

### Step 9: Run Tests

```bash
# Run your provider tests
npm test -- your-provider.provider.spec

# Run all tests
npm test

# Check coverage
npm test -- --coverage
```

### Step 10: Build and Lint

```bash
# Build the project
npm run build

# Run linter
npm run lint

# Fix linting issues automatically
npm run lint -- --fix
```

## Common Patterns

### Token-Based Pricing (LLMs)

```typescript
getPricingConfig(): PricingModel {
  return {
    providerId: 'your-llm',
    pricingType: 'per-token',
    rates: [
      { type: 'per-token', rate: 0.003, unit: 'input_token' },
      { type: 'per-token', rate: 0.015, unit: 'output_token' },
    ],
    currency: 'USD',
    effectiveFrom: new Date(),
  };
}
```

### Per-Call Pricing

```typescript
getPricingConfig(): PricingModel {
  return {
    providerId: 'your-api',
    pricingType: 'per-call',
    rates: [
      { type: 'per-call', rate: 0.05 },
    ],
    currency: 'USD',
    effectiveFrom: new Date(),
  };
}
```

### Tiered Pricing

```typescript
getPricingConfig(): PricingModel {
  return {
    providerId: 'your-service',
    pricingType: 'tiered',
    rates: [
      {
        type: 'tiered',
        tiers: [
          { from: 0, to: 1000, rate: 0.01 },
          { from: 1000, to: 5000, rate: 0.008 },
          { from: 5000, rate: 0.005 },
        ],
      },
    ],
    currency: 'USD',
    effectiveFrom: new Date(),
  };
}
```

### Handling Streaming Responses

```typescript
async execute(request: ProviderRequest): Promise<ProviderResponse> {
  // For streaming APIs, you may need to buffer the full response
  const stream = await this.client.streamRequest(request.body);

  let fullResponse = '';
  for await (const chunk of stream) {
    fullResponse += chunk;
  }

  // Return complete response with usage
  return {
    status: 200,
    body: { content: fullResponse },
    usage: this.extractUsage(fullResponse),
  };
}
```

## Troubleshooting

### Common Issues

**1. "Provider not initialized" error**

Make sure you call `await provider.initialize()` before registering:

```typescript
await this.yourProvider.initialize({ apiKey });
this.providerRegistry.register(this.yourProvider);
```

**2. Pricing not seeding**

Check that `getPricingConfig()` returns a valid `PricingModel`:
- `providerId` must match your provider's `id`
- `rates` array must not be empty
- `effectiveFrom` must be a valid Date

**3. Tests failing with "Cannot read property of undefined"**

Make sure to initialize mocks in `beforeEach`:

```typescript
beforeEach(async () => {
  await provider.initialize({ apiKey: 'test-key' });
  (provider as any).client = mockClient;
});
```

**4. Linting errors with `any` types**

Add ESLint disable comments for unavoidable `any` usage:

```typescript
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { field } = request.body as Record<string, any>;
```

**5. TypeScript errors with Promise returns**

Ensure methods return `Promise.resolve()` even if synchronous:

```typescript
calculateActualCost(response: ProviderResponse): Promise<UsageMetrics> {
  return Promise.resolve(response.usage);
}
```

### Debugging Tips

1. **Enable verbose logging:**
   ```typescript
   this.logger.debug(`Request: ${JSON.stringify(request)}`);
   ```

2. **Use health checks to verify connectivity:**
   ```bash
   curl http://localhost:3000/health
   ```

3. **Test pricing calculations manually:**
   ```typescript
   const pricing = provider.getPricingConfig();
   console.log('Pricing:', pricing);
   ```

4. **Check provider registration:**
   ```typescript
   console.log('Registered providers:', providerRegistry.getProviderIds());
   ```

## Next Steps

After implementing your provider:

1. **Update Documentation:** Add your provider to [PROVIDERS.md](./PROVIDERS.md)
2. **Add Integration Tests:** Create e2e tests with real API calls (optional)
3. **Update API Reference:** Document new endpoints in [API_REFERENCE.md](./API_REFERENCE.md)
4. **Add Environment Variables:** Document required env vars in `.env.example`

## Additional Resources

- [Provider Architecture](./PROVIDERS.md) - Detailed architecture documentation
- [API Reference](./API_REFERENCE.md) - Complete API documentation
- [Testing Guide](./TESTING_GUIDE.md) - Comprehensive testing strategies
- [OVERVIEW.md](./OVERVIEW.md) - System architecture and roadmap

## Example: Claude Provider

The complete Claude provider implementation is available at:
- Implementation: [src/providers/claude/claude.provider.ts](../src/providers/claude/claude.provider.ts)
- Tests: [src/providers/claude/claude.provider.spec.ts](../src/providers/claude/claude.provider.spec.ts)
- Configuration: [src/providers/claude/claude.config.ts](../src/providers/claude/claude.config.ts)

This is the reference implementation that demonstrates all best practices.

## Support

For questions or issues:
- GitHub Issues: https://github.com/your-org/longjing/issues
- Check existing providers in `src/providers/` for examples
- Review [PROVIDERS.md](./PROVIDERS.md) for architecture details

---

**Happy coding! 🚀**
