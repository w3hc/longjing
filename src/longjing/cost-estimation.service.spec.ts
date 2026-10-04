import { Test, TestingModule } from '@nestjs/testing';
import { CostEstimationService } from './cost-estimation.service';
import {
  ProviderRegistryService,
  ApiProvider,
  CostEstimate,
} from '../providers';
import { PricingOracleService } from '../pricing/pricing-oracle.service';
import { EthRateOracleService } from './eth-rate-oracle.service';
import { CostEstimateRequestDto } from './dto/cost-estimate.dto';
import { PricingModel } from '../pricing/dto/pricing-model.dto';

describe('CostEstimationService', () => {
  let service: CostEstimationService;
  let providerRegistry: ProviderRegistryService;
  let pricingOracle: PricingOracleService;
  let ethRateOracle: EthRateOracleService;

  const mockProvider: Partial<ApiProvider> = {
    id: 'claude',
    name: 'Claude API',
    version: '1.0.0',
    estimateCost: jest.fn(),
  };

  const mockPricingModel: PricingModel = {
    providerId: 'claude',
    pricingType: 'per-token',
    rates: [
      { type: 'per-token', rate: 0.003, unit: 'input_token' },
      { type: 'per-token', rate: 0.015, unit: 'output_token' },
    ],
    currency: 'USD',
    effectiveFrom: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CostEstimationService,
        {
          provide: ProviderRegistryService,
          useValue: {
            get: jest.fn(),
          },
        },
        {
          provide: PricingOracleService,
          useValue: {
            getPricing: jest.fn(),
          },
        },
        {
          provide: EthRateOracleService,
          useValue: {
            usdToWei: jest.fn(),
            getEthUsdRate: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<CostEstimationService>(CostEstimationService);
    providerRegistry = module.get<ProviderRegistryService>(
      ProviderRegistryService,
    );
    pricingOracle = module.get<PricingOracleService>(PricingOracleService);
    ethRateOracle = module.get<EthRateOracleService>(EthRateOracleService);

    // Clear cache between tests
    service['estimateCache'].clear();
  });

  describe('estimateCost', () => {
    const request: CostEstimateRequestDto = {
      provider: 'claude',
      endpoint: '/v1/messages',
      estimatedUnits: 1000,
      unitType: 'tokens',
    };

    const mockCostEstimate: CostEstimate = {
      minCostUSD: 0.008,
      maxCostUSD: 0.012,
      estimatedCostUSD: 0.01,
      confidence: 0.85,
    };

    beforeEach(() => {
      jest.clearAllMocks();
      jest
        .spyOn(providerRegistry, 'get')
        .mockReturnValue(mockProvider as ApiProvider);
      jest
        .spyOn(mockProvider, 'estimateCost')
        .mockResolvedValue(mockCostEstimate);
      jest.spyOn(pricingOracle, 'getPricing').mockReturnValue(mockPricingModel);
      jest
        .spyOn(ethRateOracle, 'usdToWei')
        .mockResolvedValue(5000000000000000n); // 0.005 ETH
      jest.spyOn(ethRateOracle, 'getEthUsdRate').mockResolvedValue(2000);
    });

    it('should estimate cost with safety margin', async () => {
      const result = await service.estimateCost(request);

      expect(result.provider).toBe('claude');
      expect(result.endpoint).toBe('/v1/messages');
      expect(result.estimatedCostUSD).toBe(0.01);
      expect(result.estimatedCostWei).toBe('5000000000000000');
      // Safety margin: 5000000000000000 * 1.2 = 6000000000000000
      expect(result.recommendedDepositWei).toBe('6000000000000000');
      expect(result.confidence).toBe(0.85);
      expect(result.pricingModel).toBe('per-token');
    });

    it('should include cost breakdown', async () => {
      const result = await service.estimateCost(request);

      expect(result.breakdown).toBeDefined();
      expect(result.breakdown?.baseCostUSD).toBe(0.01);
      expect(result.breakdown?.safetyMarginUSD).toBe(0.002); // 20% of 0.01
      expect(result.breakdown?.currentEthRateUSD).toBe(2000);
    });

    it('should call provider with correct metadata', async () => {
      await service.estimateCost(request);

      expect(mockProvider.estimateCost).toHaveBeenCalledWith({
        endpoint: '/v1/messages',
        method: 'POST',
        metadata: {
          estimatedUnits: 1000,
          unitType: 'tokens',
        },
      });
    });

    it('should cache estimate results', async () => {
      // First call
      await service.estimateCost(request);
      // Second call
      await service.estimateCost(request);

      // Provider should only be called once (second is from cache)
      expect(mockProvider.estimateCost).toHaveBeenCalledTimes(1);
    });

    it('should use different cache for different requests', async () => {
      const request1: CostEstimateRequestDto = {
        provider: 'claude',
        estimatedUnits: 1000,
      };

      const request2: CostEstimateRequestDto = {
        provider: 'claude',
        estimatedUnits: 2000,
      };

      await service.estimateCost(request1);
      await service.estimateCost(request2);

      // Different estimated units = different cache entries
      expect(mockProvider.estimateCost).toHaveBeenCalledTimes(2);
    });

    it('should handle requests without endpoint', async () => {
      const requestWithoutEndpoint: CostEstimateRequestDto = {
        provider: 'claude',
        estimatedUnits: 1000,
      };

      const result = await service.estimateCost(requestWithoutEndpoint);

      expect(result.endpoint).toBeUndefined();
      expect(mockProvider.estimateCost).toHaveBeenCalledWith({
        endpoint: '',
        method: 'POST',
        metadata: {
          estimatedUnits: 1000,
          unitType: undefined,
        },
      });
    });

    it('should pass custom metadata to provider', async () => {
      const requestWithMetadata: CostEstimateRequestDto = {
        provider: 'claude',
        estimatedUnits: 1000,
        metadata: {
          model: 'claude-3-5-sonnet',
          maxTokens: 2048,
        },
      };

      await service.estimateCost(requestWithMetadata);

      expect(mockProvider.estimateCost).toHaveBeenCalledWith({
        endpoint: '',
        method: 'POST',
        metadata: {
          model: 'claude-3-5-sonnet',
          maxTokens: 2048,
          estimatedUnits: 1000,
          unitType: undefined,
        },
      });
    });

    it('should handle large cost estimates', async () => {
      const largeCostEstimate: CostEstimate = {
        minCostUSD: 100,
        maxCostUSD: 150,
        estimatedCostUSD: 125,
        confidence: 0.9,
      };

      jest
        .spyOn(mockProvider, 'estimateCost')
        .mockResolvedValue(largeCostEstimate);
      jest
        .spyOn(ethRateOracle, 'usdToWei')
        .mockResolvedValue(62500000000000000n); // 0.0625 ETH at $2000/ETH

      const result = await service.estimateCost(request);

      expect(result.estimatedCostUSD).toBe(125);
      expect(result.estimatedCostWei).toBe('62500000000000000');
      // 20% safety margin
      expect(result.recommendedDepositWei).toBe('75000000000000000');
    });

    it('should handle fractional cents', async () => {
      const smallCostEstimate: CostEstimate = {
        minCostUSD: 0.0001,
        maxCostUSD: 0.0003,
        estimatedCostUSD: 0.0002,
        confidence: 0.95,
      };

      jest
        .spyOn(mockProvider, 'estimateCost')
        .mockResolvedValue(smallCostEstimate);
      jest.spyOn(ethRateOracle, 'usdToWei').mockResolvedValue(100000000000000n); // Very small wei amount

      const result = await service.estimateCost(request);

      expect(result.estimatedCostUSD).toBe(0.0002);
      expect(BigInt(result.estimatedCostWei)).toBeGreaterThan(0n);
      expect(BigInt(result.recommendedDepositWei)).toBeGreaterThan(
        BigInt(result.estimatedCostWei),
      );
    });

    it('should propagate provider errors', async () => {
      jest
        .spyOn(mockProvider, 'estimateCost')
        .mockRejectedValue(new Error('Provider unavailable'));

      await expect(service.estimateCost(request)).rejects.toThrow(
        'Provider unavailable',
      );
    });

    it('should propagate pricing oracle errors', async () => {
      jest.spyOn(pricingOracle, 'getPricing').mockImplementation(() => {
        throw new Error('Pricing not found');
      });

      await expect(service.estimateCost(request)).rejects.toThrow(
        'Pricing not found',
      );
    });

    it('should log estimate results', async () => {
      const logSpy = jest.spyOn(service['logger'], 'log');

      await service.estimateCost(request);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Estimated cost for claude'),
      );
    });
  });
});
