import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { AttestationService } from './attestation.service';
import { AttestationQuote } from './attestation.types';
import { PhalaPlatform, tdxQuoteReportData } from './platforms/phala.platform';
import { TeeKeyManagerService } from './tee-key-manager.service';

const MLKEM_PUBLIC_KEY = Buffer.alloc(1568, 7);

const expectedReportData = () =>
  Buffer.concat([
    createHash('sha256').update(MLKEM_PUBLIC_KEY).digest(),
    Buffer.alloc(32),
  ]);

const tdxQuote = (reportData: Buffer) => {
  const quote = Buffer.alloc(1024);
  reportData.copy(quote, 568);
  return quote;
};

const quoteResult = (quote: Buffer): AttestationQuote => ({
  platform: 'phala',
  quote: quote.toString('base64'),
  reportData: '',
  measurement: '',
  timestamp: new Date().toISOString(),
});

describe('AttestationService', () => {
  const env = { ...process.env };

  const createService = (teePlatform?: string) =>
    new AttestationService(
      { get: () => teePlatform } as unknown as ConfigService,
      {
        getPublicKeyBytes: () => MLKEM_PUBLIC_KEY,
      } as unknown as TeeKeyManagerService,
    );

  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  describe('in production', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
      delete process.env.DSTACK_SIMULATOR_ENDPOINT;
    });

    it('selects dstack when the socket is available', async () => {
      jest
        .spyOn(PhalaPlatform.prototype, 'isAvailable')
        .mockResolvedValue(true);
      const service = createService();

      await service.onModuleInit();

      expect(service.getPlatform()).toBe('phala');
    });

    it('refuses to start without the dstack socket', async () => {
      jest
        .spyOn(PhalaPlatform.prototype, 'isAvailable')
        .mockResolvedValue(false);

      await expect(createService().onModuleInit()).rejects.toThrow(
        'without the dstack socket',
      );
    });

    it('refuses to start when the simulator endpoint is set', async () => {
      process.env.DSTACK_SIMULATOR_ENDPOINT = 'http://localhost:8090';
      jest
        .spyOn(PhalaPlatform.prototype, 'isAvailable')
        .mockResolvedValue(true);

      await expect(createService().onModuleInit()).rejects.toThrow(
        'DSTACK_SIMULATOR_ENDPOINT must not be set in production',
      );
    });

    it.each(['mock', 'intel-tdx', 'amd-sev-snp', 'aws-nitro', 'unknown'])(
      'refuses TEE_PLATFORM=%s',
      async (teePlatform) => {
        jest
          .spyOn(PhalaPlatform.prototype, 'isAvailable')
          .mockResolvedValue(true);

        await expect(createService(teePlatform).onModuleInit()).rejects.toThrow(
          `TEE_PLATFORM=${teePlatform} is not allowed in production`,
        );
      },
    );

    it('accepts a first quote carrying the requested report_data', async () => {
      jest
        .spyOn(PhalaPlatform.prototype, 'isAvailable')
        .mockResolvedValue(true);
      jest
        .spyOn(PhalaPlatform.prototype, 'generateQuote')
        .mockResolvedValue(quoteResult(tdxQuote(expectedReportData())));
      const service = createService();
      await service.onModuleInit();

      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    });

    it('refuses to start when the first quote fails', async () => {
      jest
        .spyOn(PhalaPlatform.prototype, 'isAvailable')
        .mockResolvedValue(true);
      jest
        .spyOn(PhalaPlatform.prototype, 'generateQuote')
        .mockRejectedValue(new Error('GetQuote failed'));
      const service = createService();
      await service.onModuleInit();

      await expect(service.onApplicationBootstrap()).rejects.toThrow(
        'first quote failed',
      );
    });

    it('refuses to start when the quote carries other report_data', async () => {
      jest
        .spyOn(PhalaPlatform.prototype, 'isAvailable')
        .mockResolvedValue(true);
      jest
        .spyOn(PhalaPlatform.prototype, 'generateQuote')
        .mockResolvedValue(quoteResult(tdxQuote(Buffer.alloc(64, 1))));
      const service = createService();
      await service.onModuleInit();

      await expect(service.onApplicationBootstrap()).rejects.toThrow(
        'does not carry the requested report_data',
      );
    });
  });

  describe('in development', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'development';
    });

    it('allows the mock platform', async () => {
      const service = createService('mock');

      await service.onModuleInit();

      expect(service.getPlatform()).toBe('mock');
    });

    it('refuses an unknown TEE_PLATFORM', async () => {
      await expect(createService('unknown').onModuleInit()).rejects.toThrow(
        'Unknown TEE_PLATFORM: unknown',
      );
    });

    it('skips the first quote check', async () => {
      const generateQuote = jest.spyOn(
        PhalaPlatform.prototype,
        'generateQuote',
      );
      const service = createService('mock');
      await service.onModuleInit();

      await service.onApplicationBootstrap();

      expect(generateQuote).not.toHaveBeenCalled();
    });
  });
});

describe('tdxQuoteReportData', () => {
  it('reads the 64 bytes of report_data from a TDX quote', () => {
    const reportData = Buffer.alloc(64, 9);

    expect(tdxQuoteReportData(tdxQuote(reportData))).toEqual(reportData);
  });

  it('rejects a truncated quote', () => {
    expect(() => tdxQuoteReportData(Buffer.alloc(600))).toThrow(
      'TDX quote too short',
    );
  });
});
