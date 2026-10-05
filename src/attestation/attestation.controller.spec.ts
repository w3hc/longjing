import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AttestationController } from './attestation.controller';
import { AttestationService } from './attestation.service';
import { KeyDerivationService } from '../keys/key-derivation.service';

describe('AttestationController', () => {
  let controller: AttestationController;
  let attestationService: AttestationService;
  let keyDerivation: Record<string, jest.Mock>;

  const mockAttestationQuote = {
    platform: 'mock' as const,
    quote: 'mock-quote-base64',
    reportData: '0'.repeat(128), // 64 bytes hex
    measurement: 'mock-measurement',
    timestamp: '2026-03-17T00:00:00.000Z',
    nonce: null,
    keys: {
      mlkemPublicKey: 'AQI=',
      identityPublicKey: null,
      refundSignerPublicKey: null,
      tlsCertificate: null,
    },
  };

  beforeEach(async () => {
    keyDerivation = {
      getKeyManifest: jest.fn().mockReturnValue(null),
      getMlKemPublicKey: jest.fn().mockReturnValue(new Uint8Array([1, 2])),
      getIdentityAddress: jest.fn().mockReturnValue('0xabc'),
      getIdentityPublicKey: jest.fn().mockReturnValue(new Uint8Array([4])),
      getIdentitySignatureChain: jest
        .fn()
        .mockReturnValue([new Uint8Array([5])]),
      getRefundSignerPublicKey: jest
        .fn()
        .mockReturnValue({ x: '0x01', y: '0x02' }),
      getRefundSignerSignatureChain: jest
        .fn()
        .mockReturnValue([new Uint8Array([6])]),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AttestationController],
      providers: [
        {
          provide: AttestationService,
          useValue: {
            getAttestation: jest.fn().mockResolvedValue(mockAttestationQuote),
            getPlatform: jest.fn().mockReturnValue('mock'),
            isInTee: jest.fn().mockReturnValue(false),
          },
        },
        { provide: KeyDerivationService, useValue: keyDerivation },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('mock'),
          },
        },
      ],
    }).compile();

    controller = module.get<AttestationController>(AttestationController);
    attestationService = module.get<AttestationService>(AttestationService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getKeyManifest', () => {
    it('returns 503 when the keys were not derived', () => {
      expect(() => controller.getKeyManifest()).toThrow('no key manifest');
    });

    it('serves the signed manifest with public keys and signature chains', () => {
      const signed = { manifest: { epoch: 1 }, signature: '0xsig' };
      keyDerivation.getKeyManifest.mockReturnValue(signed);

      const result = controller.getKeyManifest();

      expect(result).toMatchObject({
        ...signed,
        domain: { name: 'Longjing', version: '1' },
        mlkemPublicKey: 'AQI=',
        identity: {
          address: '0xabc',
          publicKey: '0x04',
          signatureChain: ['0x05'],
        },
        refundSigner: { x: '0x01', y: '0x02', signatureChain: ['0x06'] },
      });
    });
  });

  describe('getAttestation', () => {
    it('should return attestation with instructions for mock platform', async () => {
      const result = await controller.getAttestation();

      expect(result).toHaveProperty('platform', 'mock');
      expect(result).toHaveProperty('quote', 'mock-quote-base64');
      expect(result).toHaveProperty('reportData');
      expect(result).toHaveProperty('measurement', 'mock-measurement');
      expect(result).toHaveProperty('timestamp');
      expect(result).toHaveProperty('instructions');
      expect(result.instructions).toContain('WARNING');
      expect(result.instructions).toContain('MOCK');
    });

    it('should call attestation service to generate attestation', async () => {
      const getAttestationSpy = jest.spyOn(
        attestationService,
        'getAttestation',
      );

      await controller.getAttestation();

      expect(getAttestationSpy).toHaveBeenCalledWith(undefined);
    });

    it('passes the client nonce to the attestation service', async () => {
      const getAttestationSpy = jest.spyOn(
        attestationService,
        'getAttestation',
      );

      await controller.getAttestation('0x' + '11'.repeat(32));

      expect(getAttestationSpy).toHaveBeenCalledWith(Buffer.alloc(32, 0x11));
    });

    it('rejects a malformed nonce with 400', async () => {
      await expect(controller.getAttestation('1234')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should return Phala verification instructions', async () => {
      const phalaQuote = {
        ...mockAttestationQuote,
        platform: 'phala' as const,
      };
      jest
        .spyOn(attestationService, 'getAttestation')
        .mockResolvedValue(phalaQuote);

      const result = await controller.getAttestation();

      expect(result.platform).toBe('phala');
      expect(result.instructions).toContain('Phala');
      expect(result.instructions).toContain('RTMR');
      expect(result.instructions).toContain('verifier.phala.network');
    });

    it('should return AMD SEV-SNP verification instructions', async () => {
      const sevQuote = {
        ...mockAttestationQuote,
        platform: 'amd-sev-snp' as const,
      };
      jest
        .spyOn(attestationService, 'getAttestation')
        .mockResolvedValue(sevQuote);

      const result = await controller.getAttestation();

      expect(result.platform).toBe('amd-sev-snp');
      expect(result.instructions).toContain('SEV-SNP');
      expect(result.instructions).toContain('AMD');
      expect(result.instructions).toContain('kdsintf.amd.com');
    });

    it('should return Intel TDX verification instructions', async () => {
      const tdxQuote = {
        ...mockAttestationQuote,
        platform: 'intel-tdx' as const,
      };
      jest
        .spyOn(attestationService, 'getAttestation')
        .mockResolvedValue(tdxQuote);

      const result = await controller.getAttestation();

      expect(result.platform).toBe('intel-tdx');
      expect(result.instructions).toContain('TDX');
      expect(result.instructions).toContain('Intel');
      expect(result.instructions).toContain('MRTD');
      expect(result.instructions).toContain('trustedservices.intel.com');
    });

    it('should return AWS Nitro verification instructions', async () => {
      const nitroQuote = {
        ...mockAttestationQuote,
        platform: 'aws-nitro' as const,
      };
      jest
        .spyOn(attestationService, 'getAttestation')
        .mockResolvedValue(nitroQuote);

      const result = await controller.getAttestation();

      expect(result.platform).toBe('aws-nitro');
      expect(result.instructions).toContain('Nitro');
      expect(result.instructions).toContain('PCR0');
      expect(result.instructions).toContain('aws-nitro-enclaves-cose');
    });

    it('should handle errors from AttestationService', async () => {
      jest
        .spyOn(attestationService, 'getAttestation')
        .mockRejectedValue(new Error('TEE error'));

      await expect(controller.getAttestation()).rejects.toThrow('TEE error');
    });
  });
});
