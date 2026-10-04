import { Injectable, Logger } from '@nestjs/common';
import { ProviderRegistryService } from '../providers';
import { PricingOracleService } from '../pricing/pricing-oracle.service';
import { EthRateOracleService } from './eth-rate-oracle.service';
import {
  CostEstimateRequestDto,
  CostEstimateResponseDto,
} from './dto/cost-estimate.dto';

/**
 * Service for estimating API call costs before execution
 */
@Injectable()
export class CostEstimationService {
  private readonly logger = new Logger(CostEstimationService.name);
  private estimateCache = new Map<
    string,
    { estimate: CostEstimateResponseDto; expiry: number }
  >();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(
    private readonly providerRegistry: ProviderRegistryService,
    private readonly pricingOracle: PricingOracleService,
    private readonly ethRateOracle: EthRateOracleService,
  ) {}

  /**
   * Estimate cost for an API request
   */
  async estimateCost(
    request: CostEstimateRequestDto,
  ): Promise<CostEstimateResponseDto> {
    // Check cache first
    const cacheKey = this.getCacheKey(request);
    const cached = this.estimateCache.get(cacheKey);

    if (cached && cached.expiry > Date.now()) {
      this.logger.debug(`Cache hit for estimate: ${cacheKey}`);
      return cached.estimate;
    }

    // Get provider
    const provider = this.providerRegistry.get(request.provider);

    // Get provider-specific estimate (may be more accurate than simple unit multiplication)
    const providerEstimate = await provider.estimateCost({
      endpoint: request.endpoint ?? '',
      method: 'POST',
      metadata: {
        ...request.metadata,
        estimatedUnits: request.estimatedUnits,
        unitType: request.unitType,
      },
    });

    // Get pricing model for the provider
    const pricing = this.pricingOracle.getPricing(
      request.provider,
      request.endpoint,
    );

    // Calculate USD cost
    const costUSD = providerEstimate.estimatedCostUSD;

    // Convert to ETH
    const costWeiBigInt = await this.ethRateOracle.usdToWei(costUSD);

    // Add safety margin (20%)
    const recommendedDepositWei = (costWeiBigInt * 120n) / 100n;

    // Get current ETH rate
    const ethRateUSD = await this.ethRateOracle.getEthUsdRate();

    // Build response
    const estimate: CostEstimateResponseDto = {
      provider: request.provider,
      endpoint: request.endpoint,
      estimatedCostUSD: costUSD,
      estimatedCostWei: costWeiBigInt.toString(),
      recommendedDepositWei: recommendedDepositWei.toString(),
      breakdown: {
        baseCostUSD: costUSD,
        safetyMarginUSD: costUSD * 0.2,
        currentEthRateUSD: ethRateUSD,
      },
      confidence: providerEstimate.confidence,
      pricingModel: pricing.pricingType,
      timestamp: new Date(),
    };

    // Cache the result
    this.estimateCache.set(cacheKey, {
      estimate,
      expiry: Date.now() + this.CACHE_TTL_MS,
    });

    this.logger.log(
      `Estimated cost for ${request.provider}: $${costUSD.toFixed(4)} USD (${costWeiBigInt.toString()} wei)`,
    );

    return estimate;
  }

  /**
   * Generate cache key for estimate
   */
  private getCacheKey(request: CostEstimateRequestDto): string {
    return `${request.provider}:${request.endpoint ?? ''}:${request.estimatedUnits}:${request.unitType ?? ''}`;
  }
}
