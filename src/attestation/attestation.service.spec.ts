import { ConfigService } from '@nestjs/config';
import { AttestationService } from './attestation.service';
import { AttestationQuote } from './attestation.types';
import { PhalaPlatform, tdxQuoteReportData } from './platforms/phala.platform';
import { MockPlatform } from './platforms/mock.platform';
import { buildReportData, encodeRefundSignerPublicKey } from './report-data';
import { TeeKeyManagerService } from './tee-key-manager.service';
import { KeyDerivationService } from '../keys/key-derivation.service';

const MLKEM_PUBLIC_KEY = Buffer.alloc(1568, 7);
const IDENTITY_PUBLIC_KEY = new Uint8Array([4, ...new Uint8Array(64).fill(2)]);
const REFUND_SIGNER = { x: '0x' + '03'.repeat(32), y: '0x' + '04'.repeat(32) };

const expectedReportData = (nonce?: Buffer) =>
  buildReportData(
    {
      mlkemPublicKey: MLKEM_PUBLIC_KEY,
      identityPublicKey: IDENTITY_PUBLIC_KEY,
      refundSignerPublicKey: encodeRefundSignerPublicKey(REFUND_SIGNER),
    },
    nonce,
  );

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
      {
        getIdentityPublicKey: () => IDENTITY_PUBLIC_KEY,
        getRefundSignerPublicKey: () => REFUND_SIGNER,
      } as unknown as KeyDerivationService,
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

    it('commits to every key and the nonce', async () => {
      const generateQuote = jest.spyOn(MockPlatform.prototype, 'generateQuote');
      const service = createService('mock');
      await service.onModuleInit();
      const nonce = Buffer.alloc(32, 0x7f);

      await service.getAttestation(nonce);

      expect(generateQuote).toHaveBeenCalledWith(expectedReportData(nonce));
    });

    it('rejects a nonce that is not 32 bytes', async () => {
      const service = createService('mock');
      await service.onModuleInit();

      await expect(service.getAttestation(Buffer.alloc(16))).rejects.toThrow(
        'Nonce must be 32 bytes',
      );
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
