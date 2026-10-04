import { Test, TestingModule } from '@nestjs/testing';
import { EthRateOracleService } from './eth-rate-oracle.service';

describe('EthRateOracleService', () => {
  let service: EthRateOracleService;

  beforeEach(async () => {
    // Set in-memory DB for testing
    process.env.DATA_DIR = ':memory:';

    const module: TestingModule = await Test.createTestingModule({
      providers: [EthRateOracleService],
    }).compile();

    service = module.get<EthRateOracleService>(EthRateOracleService);
    service.onModuleInit();
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getEthUsdRate', () => {
    it('should fetch ETH/USD rate', async () => {
      const rate = await service.getEthUsdRate();

      expect(rate).toBeGreaterThan(0);
      expect(typeof rate).toBe('number');
    }, 10000);

    it('should cache rate for 1 minute', async () => {
      const rate1 = await service.getEthUsdRate();
      const rate2 = await service.getEthUsdRate();

      expect(rate1).toBe(rate2);
    }, 10000);
  });

  describe('usdToWei', () => {
    it('should convert USD to wei', async () => {
      const usdAmount = 10; // $10
      const wei = await service.usdToWei(usdAmount);

      expect(wei).toBeGreaterThan(BigInt(0));
      expect(typeof wei).toBe('bigint');
    }, 10000);
  });

  describe('weiToUsd', () => {
    it('should convert wei to USD', async () => {
      const wei = BigInt('1000000000000000000'); // 1 ETH
      const usd = await service.weiToUsd(wei);

      expect(usd).toBeGreaterThan(0);
      expect(typeof usd).toBe('number');
    }, 10000);
  });

  describe('database persistence', () => {
    it('should save rate to database when fetched from Kraken', async () => {
      const rate = await service.getEthUsdRate();
      expect(rate).toBeGreaterThan(0);

      // Rate should be saved to DB
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      const dbRate = (service as any).getLatestRateFromDb() as {
        rate: number;
        source: string;
        timestamp: number;
      } | null;
      expect(dbRate).toBeTruthy();
      expect(dbRate?.rate).toBe(rate);
      expect(dbRate?.source).toBe('kraken');
    }, 10000);
  });

  describe('fallback mechanisms', () => {
    it('should fallback to Chainlink when Kraken fails', async () => {
      // Suppress expected error logs

      jest.spyOn(service['logger'], 'error').mockImplementation();

      // Mock Kraken to fail
      jest
        .spyOn(global, 'fetch')
        .mockRejectedValueOnce(new Error('Network error'));

      // Mock Chainlink to return a valid rate

      jest
        .spyOn(service as any, 'fetchFromChainlink')
        .mockResolvedValueOnce(2500);

      const rate = await service.getEthUsdRate();

      expect(rate).toBe(2500);
      expect(typeof rate).toBe('number');

      // Should have saved Chainlink rate
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      const dbRate = (service as any).getLatestRateFromDb() as {
        rate: number;
        source: string;
        timestamp: number;
      } | null;
      expect(dbRate?.source).toBe('chainlink');
    }, 30000);

    it('should use database cache if less than 1 hour old', async () => {
      // First, get a rate from Kraken
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            error: [],
            result: {
              XETHZUSD: {
                c: ['2500.00', '1.0'],
              },
            },
          }),
      } as Response);

      const rate1 = await service.getEthUsdRate();
      expect(rate1).toBe(2500);

      // Clear memory cache to force DB lookup
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (service as any).cache = null;

      // Suppress expected error logs

      jest.spyOn(service['logger'], 'error').mockImplementation();

      // Mock Kraken to fail this time
      jest
        .spyOn(global, 'fetch')
        .mockRejectedValueOnce(new Error('Network error'));

      // Should use DB cache (less than 1 hour old)
      const rate2 = await service.getEthUsdRate();
      expect(rate2).toBe(2500);
    }, 10000);

    it('should reject stale database cache older than 1 hour', async () => {
      // Manually insert old rate (> 1 hour ago)
      const oneHourAgo = Date.now() - 61 * 60 * 1000; // 61 minutes
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      (service as any).db

        .prepare(
          'INSERT INTO eth_rates (rate, source, timestamp) VALUES (?, ?, ?)',
        )
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        .run(1800, 'kraken', oneHourAgo);

      // Clear memory cache
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (service as any).cache = null;

      // Suppress expected error logs

      jest.spyOn(service['logger'], 'error').mockImplementation();

      // Mock Kraken to fail
      jest
        .spyOn(global, 'fetch')
        .mockRejectedValueOnce(new Error('Network error'));

      // Mock Chainlink to return a valid rate

      jest
        .spyOn(service as any, 'fetchFromChainlink')
        .mockResolvedValueOnce(3000);

      // Should fall back to Chainlink, not use stale DB cache
      const rate = await service.getEthUsdRate();
      expect(rate).toBe(3000);
      expect(rate).not.toBe(1800); // Should not be the old cached value

      // Check that Chainlink was used
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      const dbRate = (service as any).getLatestRateFromDb() as {
        rate: number;
        source: string;
        timestamp: number;
      } | null;
      expect(dbRate?.source).toBe('chainlink');
    }, 30000);
  });
});
