# Provider Abstraction Layer

This document describes the provider abstraction layer introduced in Phase 1 of the Universal Longjing implementation.

## Overview

The provider abstraction layer enables Longjing to support multiple external API services (Claude, OpenAI, Stripe, etc.) through a unified interface, while maintaining zero-knowledge privacy guarantees and hardcoded pricing configuration.

**Status**: Phase 1 & 2 Complete ✅
- Provider abstraction interface
- Pricing oracle with database backend and caching
- Generic usage metering
- Cost estimation endpoint
- Hardcoded pricing with auto-seeding
- **Claude provider implementation** (claude-fable-5-1 by default)
- Comprehensive test coverage (434 passing tests)

## Pricing Architecture

### Key Design Decision: Hardcoded Pricing

**Pricing is hardcoded in provider implementations** and automatically seeded to the database when providers are registered. This design was chosen for security and operational simplicity.

**Why Hardcoded?**

1. **No Admin Authentication Needed**: Phase 1 does not include admin authentication. Hardcoding pricing eliminates the security risk of unauthenticated pricing updates.

2. **Version Control & Audit Trail**: Pricing changes go through git history, code review, and standard deployment processes. This provides better auditability than runtime API calls.

3. **Atomic Deployment**: Provider code and pricing are deployed together, ensuring consistency. No coordination needed between code deployment and separate pricing configuration.

4. **Security**: Only developers with code deployment access can change pricing, not anyone who might access an admin API endpoint.

**How It Works:**

```typescript
// Pricing is defined in provider class
class ClaudeProvider extends BaseProvider {
  getPricingConfig(): PricingModel {
    return {
      providerId: 'claude',
      endpoint: '/v1/messages',
      pricingType: 'per-token',
      rates: [
        { type: 'per-token', rate: 0.003, unit: 'input_token' },
        { type: 'per-token', rate: 0.015, unit: 'output_token' },
      ],
      currency: 'USD',
      effectiveFrom: new Date(),
    };
  }
}

// Auto-seeded on registration
providerRegistry.register(claudeProvider);
// → Pricing automatically inserted into database with audit trail
```

**Database Still Used For:**
- Fast pricing lookups (1-hour cache)
- Historical pricing tracking
- Query optimization
- Supporting multiple pricing types (per-token, per-call, tiered, etc.)

## Architecture

### Core Components

```
┌─────────────────────────────────────────────────────────────┐
│                      Longjing Service                         │
│  (Proof Verification, Nullifier Checking, Refund Signing)  │
└────────────────┬────────────────────────────────────────────┘
                 │
                 v
┌─────────────────────────────────────────────────────────────┐
│                  Provider Registry                          │
│         (Routes requests to appropriate provider)           │
└────────┬──────────────────────────┬─────────────────────────┘
         │                          │
         v                          v
┌────────────────────┐    ┌────────────────────┐
│  Claude Provider   │    │  Future Providers  │
│  ✅ IMPLEMENTED    │    │  (OpenAI, etc.)    │
│  (Phase 2)         │    │                    │
└────────────────────┘    └────────────────────┘
         │                          │
         └──────────┬───────────────┘
                    v
         ┌─────────────────────┐
         │  Pricing Oracle     │
         │  (Dynamic Pricing)  │
         └─────────────────────┘
```

## Implemented Providers

### Claude Provider (Anthropic) ✅

The Claude provider is the reference implementation demonstrating all provider features.

**Details:**
- **Provider ID**: `claude`
- **Model**: `claude-fable-5-1` (default)
- **Supported Models**: exactly the models priced in [`src/pricing/claude-pricing.ts`](../src/pricing/claude-pricing.ts)
  - claude-fable-5-1
  - claude-opus-4-6
  - claude-sonnet-4-6
  - claude-haiku-4-5
- **Pricing**: per model, from the same table
  - Input and output tokens: the model's rates
  - Cache write: 1.25× the input rate
  - Cache read: 0.1× the input rate
- **Rate Limits**:
  - 50 requests/minute
  - 1000 requests/day
  - 5 concurrent requests
- **Location**: `src/providers/claude/`
- **Tests**: 16 tests, all passing

**Getting Started:**
See [QUICK_START.md](./QUICK_START.md) for a step-by-step guide to adding new providers.

## Provider Interface

All API providers must implement the `ApiProvider` interface:

```typescript
interface ApiProvider {
  // Metadata
  readonly id: string;                    // 'claude' | 'openai' | 'stripe'
  readonly name: string;                  // 'Claude API'
  readonly version: string;               // '1.0.0'

  // Lifecycle
  initialize(config: ProviderConfig): Promise<void>;
  healthCheck(): Promise<ProviderHealth>;

  // Request handling
  validateRequest(request: ProviderRequest): Promise<ValidationResult>;
  execute(request: ProviderRequest): Promise<ProviderResponse>;

  // Cost calculation
  estimateCost(request: ProviderRequest): Promise<CostEstimate>;
  calculateActualCost(response: ProviderResponse): Promise<UsageMetrics>;

  // Rate limiting
  getRateLimits(): RateLimitConfig;
}
```

### Provider Implementation Example

```typescript
@Injectable()
export class ClaudeProvider extends BaseProvider implements ApiProvider {
  readonly id = 'claude';
  readonly name = 'Anthropic Claude API';
  readonly version = '1.0.0';

  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    // Provider-specific implementation
    const response = await this.anthropic.messages.create({...});

    return {
      status: 200,
      body: response,
      usage: this.extractUsage(response),
    };
  }

  // ... other methods
}
```

## Dynamic Pricing System

### Database Schema

Pricing is stored in SQLite with full history tracking:

```sql
CREATE TABLE pricing_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL,
  endpoint TEXT,                    -- NULL = applies to all endpoints
  pricing_type TEXT NOT NULL,       -- 'per-token' | 'per-call' | 'tiered'
  currency TEXT NOT NULL DEFAULT 'USD',
  rates TEXT NOT NULL,              -- JSON array of PricingRate
  effective_from DATETIME NOT NULL,
  effective_until DATETIME,         -- NULL = current
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE pricing_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL,
  endpoint TEXT,
  old_rates TEXT,
  new_rates TEXT,
  changed_by TEXT,
  changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  reason TEXT
);
```

### Pricing Types

1. **Per-Token** - Token-based pricing (LLMs)
   ```json
   {
     "rates": [
       { "type": "per-token", "rate": 0.003, "unit": "input_token" },
       { "type": "per-token", "rate": 0.015, "unit": "output_token" }
     ]
   }
   ```

2. **Per-Call** - Fixed cost per API call
   ```json
   {
     "rates": [{ "type": "per-call", "rate": 0.05 }]
   }
   ```

3. **Per-Unit** - Simple unit-based pricing
   ```json
   {
     "rates": [{ "type": "per-unit", "rate": 0.001 }]
   }
   ```

4. **Tiered** - Volume-based pricing
   ```json
   {
     "rates": [{
       "type": "tiered",
       "tiers": [
         { "from": 0, "to": 1000, "rate": 0.01 },
         { "from": 1000, "to": 5000, "rate": 0.008 },
         { "from": 5000, "rate": 0.005 }
       ]
     }]
   }
   ```

5. **Composite** - Multiple unit types
   ```json
   {
     "rates": [
       { "type": "composite", "rate": 0.001, "unit": "compute" },
       { "type": "composite", "rate": 0.0001, "unit": "storage" }
     ]
   }
   ```

### Pricing Oracle Service

The pricing oracle handles cost calculations with caching:

```typescript
// Get current pricing
const pricing = pricingOracle.getPricing('claude', '/v1/messages');

// Calculate cost from usage
const costUSD = pricingOracle.calculateCostUSD(usage, 'claude');

// Update pricing (admin only)
pricingOracle.updatePricing(newModel, 'admin@example.com', 'Price reduction');
```

**Features:**
- 1-hour cache TTL for fast lookups
- Historical pricing tracking
- Automatic cache invalidation on updates
- Support for endpoint-specific pricing

## Generic Usage Metering

The `UsageDto` has been generalized to support any unit type:

```typescript
export class UsageDto {
  // Universal fields
  units: number;                  // Total billable units
  unitType: 'tokens' | 'calls' | 'bytes' | 'seconds' | 'images' | 'custom';
  costUSD: number;

  // Optional breakdown
  breakdown?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    storage?: number;
    [key: string]: number | undefined;
  };

  // Deprecated (backwards compatibility)
  inputTokens?: number;
  outputTokens?: number;
}
```

**Example Usage:**

```typescript
// Token-based (Claude)
{
  units: 3000,
  unitType: 'tokens',
  costUSD: 0.021,
  breakdown: { input: 2000, output: 1000 }
}

// API call-based (Stripe)
{
  units: 1,
  unitType: 'calls',
  costUSD: 0.05
}

// Storage-based
{
  units: 1000,
  unitType: 'bytes',
  costUSD: 0.001
}
```

## Cost Estimation Endpoint

New public endpoint for estimating costs before making requests:

### `POST /longjing/estimate-cost`

**Request:**
```json
{
  "provider": "claude",
  "endpoint": "/v1/messages",
  "estimatedUnits": 1000,
  "unitType": "tokens",
  "metadata": {
    "model": "claude-3-5-sonnet",
    "maxTokens": 2048
  }
}
```

**Response:**
```json
{
  "provider": "claude",
  "endpoint": "/v1/messages",
  "estimatedCostUSD": 0.01,
  "estimatedCostWei": "5000000000000000",
  "recommendedDepositWei": "6000000000000000",  // +20% safety margin
  "breakdown": {
    "baseCostUSD": 0.01,
    "safetyMarginUSD": 0.002,
    "currentEthRateUSD": 2000
  },
  "confidence": 0.85,
  "pricingModel": "per-token",
  "timestamp": "2026-04-06T20:00:00Z"
}
```

**Features:**
- No authentication required
- 5-minute cache for identical requests
- Returns recommended deposit with 20% safety margin
- Provider-specific estimation logic

**Security Note:** ⚠️ Rate limiting recommended for production (not implemented in Phase 1)

## Provider Registry

Manages all registered providers:

```typescript
@Injectable()
export class ProviderRegistryService {
  // Register a provider
  register(provider: ApiProvider): void;

  // Get provider by ID
  get(providerId: string): ApiProvider;

  // Check if provider exists
  has(providerId: string): boolean;

  // List all providers
  list(): ApiProvider[];

  // Health check all providers
  async healthCheckAll(): Promise<Map<string, ProviderHealth>>;
}
```

**Usage:**
```typescript
// Register provider
providerRegistry.register(new ClaudeProvider());

// Route request
const provider = providerRegistry.get('claude');
const response = await provider.execute(request);
```

## Security Considerations

### Implemented Protections

✅ **SQL Injection**: All queries use prepared statements
✅ **Header Sanitization**: API keys removed from logs
✅ **Input Validation**: DTOs validated with class-validator
✅ **Error Handling**: Errors don't leak sensitive information
✅ **ZK Integrity**: No changes to proof verification or nullifier checking

### Production Hardening Needed

⚠️ **Rate Limiting**: Cost estimation endpoint is public (add 10 req/min limit)
⚠️ **Cache Size**: No max cache size (implement LRU with 1000 entry limit)
✅ **Pricing Security**: Pricing is hardcoded in provider code and auto-seeded on registration (no admin endpoint needed)
⚠️ **Bounds Validation**: Add limits on monetary values ($0.000001 - $1000)
⚠️ **Audit Logging**: Log pricing changes with IP addresses

See [Security Risk Assessment](#security-risk-assessment) section below.

## Testing

Comprehensive test suite with 96%+ coverage:

```bash
# Run all tests
npm test

# Run provider tests
npm test src/providers/

# Run pricing tests
npm test src/pricing/

# Check coverage
npm test -- --coverage
```

**Coverage:**
- Provider Registry: 100%
- Pricing Repository: 100%
- Pricing Oracle: 94.8%
- Cost Estimation: Well covered
- Database Service: 95.65%

## Adding New Providers

**📖 See [QUICK_START.md](./QUICK_START.md) for a comprehensive step-by-step guide.**

The QUICK_START guide includes:
- Complete code templates
- Testing examples
- Common patterns for different API types
- Troubleshooting tips
- Reference to the Claude provider implementation

## Usage Examples

### Complete Workflow: Adding a New Provider

**Example:** Adding Claude API support to Longjing (IMPLEMENTED ✅)

#### Step 1: Implement Provider with Hardcoded Pricing

```typescript
// src/providers/claude/claude.provider.ts
import { Injectable } from '@nestjs/common';
import { BaseProvider, ApiProvider } from '../core';
import { PricingModel } from '../../pricing/dto/pricing-model.dto';
import Anthropic from '@anthropic-ai/sdk';

@Injectable()
export class ClaudeProvider extends BaseProvider implements ApiProvider {
  readonly id = 'claude';
  readonly name = 'Anthropic Claude API';
  readonly version = '1.0.0';

  private anthropic: Anthropic;

  constructor(private readonly pricingOracle: PricingOracleService) {
    super();
  }

  /**
   * Hardcoded pricing configuration - auto-seeded on registration
   * To update pricing, modify this code and redeploy
   */
  getPricingConfig(): PricingModel {
    return {
      providerId: 'claude',
      endpoint: '/v1/messages',
      pricingType: 'per-token',
      currency: 'USD',
      rates: [
        { type: 'per-token', rate: 0.003, unit: 'input_token' },
        { type: 'per-token', rate: 0.015, unit: 'output_token' },
      ],
      effectiveFrom: new Date(),
    };
  }

  async initialize(config: ProviderConfig): Promise<void> {
    this.anthropic = new Anthropic({
      apiKey: config.apiKey,
    });
  }

  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    const response = await this.anthropic.messages.create({
      model: request.body.model || 'claude-sonnet-4-20250514',
      messages: request.body.messages,
      max_tokens: request.body.max_tokens || 4096,
    });

    // Use pricing oracle to calculate cost (NOT hardcoded values)
    const usage = {
      units: response.usage.input_tokens + response.usage.output_tokens,
      unitType: 'tokens' as const,
      breakdown: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
      },
    };

    const costUSD = await this.pricingOracle.calculateCostUSD(
      usage,
      'claude',
      request.endpoint,
    );

    return {
      status: 200,
      headers: {},
      body: response,
      usage: { ...usage, costUSD },
    };
  }

  async estimateCost(request: ProviderRequest): Promise<CostEstimate> {
    // Get current pricing from oracle (uses hardcoded config)
    const pricing = await this.pricingOracle.getPricing('claude', '/v1/messages');

    // Rough estimate: 1 token ≈ 4 characters
    const estimatedInputTokens = Math.ceil(
      JSON.stringify(request.body.messages).length / 4
    );
    const estimatedOutputTokens = request.body.max_tokens || 1024;

    const estimatedCostUSD = await this.pricingOracle.calculateCostUSD(
      {
        units: estimatedInputTokens + estimatedOutputTokens,
        unitType: 'tokens',
        breakdown: {
          input: estimatedInputTokens,
          output: estimatedOutputTokens,
        },
      },
      'claude',
      request.endpoint,
    );

    return {
      minCostUSD: estimatedCostUSD * 0.5,
      maxCostUSD: estimatedCostUSD * 2.0,
      estimatedCostUSD,
      confidence: 0.6,
    };
  }

  async calculateActualCost(response: ProviderResponse): Promise<UsageMetrics> {
    return response.usage;
  }

  getRateLimits(): RateLimitConfig {
    return { requestsPerMinute: 50 };
  }

  async healthCheck(): Promise<ProviderHealth> {
    try {
      // Simple health check - could ping a test endpoint
      return { status: 'healthy', latencyMs: 20, lastCheck: new Date() };
    } catch (error) {
      return {
        status: 'down',
        message: error.message,
        lastCheck: new Date(),
      };
    }
  }
}
```

#### Step 2: Register Provider (Pricing Auto-Seeded)

```typescript
// src/providers/claude/claude.module.ts
import { Module, OnModuleInit } from '@nestjs/common';
import { ClaudeProvider } from './claude.provider';
import { ProviderRegistryService } from '../registry';

@Module({
  providers: [ClaudeProvider],
  exports: [ClaudeProvider],
})
export class ClaudeModule implements OnModuleInit {
  constructor(
    private readonly registry: ProviderRegistryService,
    private readonly claudeProvider: ClaudeProvider,
  ) {}

  async onModuleInit() {
    // Initialize provider
    await this.claudeProvider.initialize({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    // Register provider - pricing is auto-seeded here!
    this.registry.register(this.claudeProvider);

    // Logs output:
    // [ProviderRegistryService] Registered provider: Anthropic Claude API (claude) v1.0.0
    // [ProviderRegistryService] Seeded pricing for provider: claude
  }
}
```

**What happens on registration:**
1. `ProviderRegistryService.register()` calls `provider.getPricingConfig()`
2. Pricing is inserted into database via `pricingOracle.updatePricing()`
3. Audit trail created: `changedBy: 'system', reason: 'Auto-seeded from provider claude v1.0.0'`
4. Provider is now ready to use!

#### Step 3: Users Make Requests (No Additional Setup)

```typescript
// User estimates cost
const estimate = await fetch('https://api.example.com/longjing/estimate-cost', {
  method: 'POST',
  body: JSON.stringify({
    provider: 'claude',
    endpoint: '/v1/messages',
    estimatedUnits: 2000,
    unitType: 'tokens',
  }),
});

// Returns: recommendedDepositWei based on hardcoded pricing

// User makes Longjing call
const result = await longjing.call({
  provider: 'claude',
  endpoint: '/v1/messages',
  body: {
    model: 'claude-sonnet-4-20250514',
    messages: [{ role: 'user', content: 'Explain quantum computing' }],
    max_tokens: 1024,
  },
  proof: zkProof,
});
```

#### Step 4: Update Pricing (Redeploy)

When Anthropic announces a price change:

```typescript
// Update getPricingConfig() in claude.provider.ts
getPricingConfig(): PricingModel {
  return {
    providerId: 'claude',
    endpoint: '/v1/messages',
    pricingType: 'per-token',
    rates: [
      { type: 'per-token', rate: 0.0025, unit: 'input_token' },  // Updated!
      { type: 'per-token', rate: 0.0125, unit: 'output_token' }, // Updated!
    ],
    effectiveFrom: new Date(),
  };
}

// Commit, push, deploy
// On app restart:
// - Provider re-registers
// - Pricing auto-updates in database
// - Old pricing marked as effectiveUntil: NOW()
// - New pricing marked as effectiveFrom: NOW()
// - Full audit trail in pricing_history table
```

### Example: Simple Per-Call Provider

```typescript
@Injectable()
export class StripeProvider extends BaseProvider implements ApiProvider {
  readonly id = 'stripe';
  readonly name = 'Stripe Payment API';
  readonly version = '1.0.0';

  getPricingConfig(): PricingModel {
    return {
      providerId: 'stripe',
      pricingType: 'per-call',
      rates: [{ type: 'per-call', rate: 0.05 }],
      currency: 'USD',
      effectiveFrom: new Date(),
    };
  }

  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    const result = await this.stripe.charges.create(request.body);

    const costUSD = await this.pricingOracle.calculateCostUSD(
      { units: 1, unitType: 'calls' },
      'stripe',
    );

    return {
      status: 200,
      body: result,
      usage: { units: 1, unitType: 'calls', costUSD },
    };
  }

  // ... other methods
}
```

### Estimating Costs (User-Facing)

```typescript
// Client-side usage
const estimate = await fetch('https://api.example.com/longjing/estimate-cost', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    provider: 'claude',
    estimatedUnits: 5000,
    unitType: 'tokens',
  }),
});

const { recommendedDepositWei } = await estimate.json();

// Use recommendedDepositWei for smart contract deposit
await longjingContract.deposit(idCommitment, { value: recommendedDepositWei });
```

## Migration Guide

### For Existing Deployments

Phase 1 is **100% backwards compatible**. No breaking changes to:
- API endpoints
- Request/response formats
- ZK proof verification
- Smart contracts

**Optional Migrations:**

1. **Seed Pricing Database** (if using Claude API)
   ```typescript
   await pricingOracle.updatePricing({
     providerId: 'claude',
     pricingType: 'per-token',
     rates: [
       { type: 'per-token', rate: 0.003, unit: 'input_token' },
       { type: 'per-token', rate: 0.015, unit: 'output_token' },
     ],
     currency: 'USD',
     effectiveFrom: new Date(),
   }, 'system', 'Initial migration');
   ```

2. **Update Usage Tracking** (optional)
   ```typescript
   // Old format (still works)
   { inputTokens: 1000, outputTokens: 500 }

   // New format (recommended)
   {
     units: 1500,
     unitType: 'tokens',
     costUSD: 0.01,
     breakdown: { input: 1000, output: 500 },
     inputTokens: 1000,  // Backwards compat
     outputTokens: 500,
   }
   ```

## Roadmap

### Phase 1: Core Abstraction ✅
- [x] Provider interface
- [x] Provider registry with auto-seeding
- [x] Hardcoded pricing configuration
- [x] Pricing oracle with database backend
- [x] Generic usage metering
- [x] Cost estimation endpoint

### Phase 2: Reference Implementation ✅
- [x] Claude provider using new abstraction
  - Model: claude-fable-5-1 by default
  - Full Anthropic SDK integration
  - Pricing: per model, from `src/pricing/claude-pricing.ts`
  - Cache pricing support (90% discount for reads)
  - 16 comprehensive tests
- [ ] Conversation management (multi-turn chat) - **Future**
- [ ] Full e2e tests with real API - **Future**

### Phase 3: w3pk Integration
- [ ] ML-KEM encrypted context support
- [ ] Private document injection
- [ ] TEE key management

### Future Phases
- [ ] OpenAI provider
- [ ] Multi-provider support in clients
- [ ] Generic HTTP proxy mode
- [ ] Provider marketplace

## Security Risk Assessment

### Risk Level: 🟡 MEDIUM

**Critical Recommendations Before Production:**

1. **Add Rate Limiting**
   ```typescript
   @Throttle(10, 60)  // 10 requests per minute
   @Post('estimate-cost')
   async estimateCost(@Body() request: CostEstimateRequestDto) { ... }
   ```

2. **~~Add Admin Authorization~~** (Not needed - pricing is hardcoded in provider code)

3. **Add Cache Size Limits**
   ```typescript
   // Use LRU cache instead of Map
   private estimateCache = new LRUCache<string, CostEstimate>({ max: 1000 });
   ```

4. **Add Bounds Validation**
   ```typescript
   if (rate < 0.000001 || rate > 1000) {
     throw new Error('Rate must be between $0.000001 and $1000');
   }
   ```

5. **~~Add Audit Logging~~** (Already implemented - pricing changes tracked in `pricing_history` table with git history)

## References

- [OVERVIEW.md](./OVERVIEW.md) - System architecture and implementation status
- [API Reference](./API_REFERENCE.md)
- [Testing Guide](./TESTING_GUIDE.md)
- [SQLite Documentation](./SQLITE3.md)

## Support

For questions or issues related to the provider abstraction layer:
- GitHub Issues: https://github.com/your-org/longjing/issues
- Documentation: See [OVERVIEW.md](./OVERVIEW.md) for system architecture

## License

MIT License - see LICENSE file for details
