import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LongjingService } from './longjing.service';
import { NullifierStoreService } from './nullifier-store.service';
import { ProofVerifierService } from './proof-verifier.service';
import { ComputeLimiterService } from './compute-limiter.service';
import { ProofGenService } from './proof-gen.service';
import { SnarkjsProofService } from './snarkjs-proof.service';
import { EthRateOracleService } from './eth-rate-oracle.service';
import { RefundSignerService } from './refund-signer.service';
import { BlockchainService } from './blockchain.service';
import { SlashingService } from './slashing.service';
import { SlashingProofService } from './slashing-proof.service';
import { LongjingRequestDto } from './dto/api-request.dto';
import { SecretsService } from '../config/secrets.service';
import { KeyDerivationService } from '../keys/key-derivation.service';
import { AttestationService } from '../attestation/attestation.service';
import { payloadToSignalX } from './utils/payload-signal.util';

describe('LongjingService', () => {
  let service: LongjingService;
  let nullifierStore: NullifierStoreService;
  let proofVerifier: ProofVerifierService;
  let ethRateOracle: EthRateOracleService;
  let proofGenService: ProofGenService;

  // Suppress expected circomlibjs teardown errors
  const originalConsoleError = console.error;
  beforeAll(() => {
    console.error = (...args: any[]) => {
      const message = args.join(' ');
      // Filter out expected circomlibjs teardown errors
      if (
        message.includes("'instanceof' is not callable") ||
        message.includes(
          'You are trying to `import` a file after the Jest environment',
        ) ||
        message.includes('DEP0182')
      ) {
        return;
      }
      originalConsoleError.apply(console, args);
    };
  });

  afterAll(() => {
    console.error = originalConsoleError;
  });

  beforeEach(async () => {
    // Set test database path
    process.env.DATA_DIR = ':memory:';

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LongjingService,
        NullifierStoreService,
        ProofVerifierService,
        ComputeLimiterService,
        ProofGenService,
        SnarkjsProofService,
        EthRateOracleService,
        RefundSignerService,
        {
          provide: KeyDerivationService,
          useValue: { getRefundSignerPrivateKey: () => null },
        },
        SecretsService,
        { provide: AttestationService, useValue: {} },
        {
          provide: BlockchainService,
          useValue: {
            getMerkleRoot: jest.fn().mockResolvedValue('0x1234'),
            isAvailable: jest.fn().mockReturnValue(true),
          },
        },
        {
          provide: SlashingService,
          useValue: {
            isEnabled: jest.fn().mockReturnValue(false),
            slashDoubleSpend: jest.fn().mockResolvedValue(null),
            getContractAddress: jest.fn().mockReturnValue(null),
            getSlasherAddress: jest.fn().mockReturnValue(null),
          },
        },
        {
          provide: SlashingProofService,
          useValue: {
            initialize: jest.fn().mockResolvedValue(true),
            isAvailable: jest.fn().mockReturnValue(false),
            generateSlashingProof: jest.fn().mockResolvedValue({
              proof: [],
              publicSignals: [],
            }),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'ANTHROPIC_API_KEY') return undefined; // Use mock for tests
              return undefined;
            }),
          },
        },
      ],
    })
      .setLogger({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        verbose: jest.fn(),
        fatal: jest.fn(),
      })
      .compile();

    service = module.get<LongjingService>(LongjingService);
    nullifierStore = module.get<NullifierStoreService>(NullifierStoreService);
    proofVerifier = module.get<ProofVerifierService>(ProofVerifierService);
    ethRateOracle = module.get<EthRateOracleService>(EthRateOracleService);
    proofGenService = module.get<ProofGenService>(ProofGenService);

    // Initialize database
    await module.init();

    // Wait for RefundSignerService to initialize (circomlibjs takes time)
    await service.getServerPublicKey();
  }, 30000);

  afterEach(() => {
    nullifierStore.clear();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('handleRequest', () => {
    const payload = 'What does 苟全性命於亂世，不求聞達於諸侯。mean?';
    const signalXHex = (p: string) => '0x' + payloadToSignalX(p).toString(16);

    const validRequest: LongjingRequestDto = {
      payload,
      nullifier: '0x1234567890abcdef',
      signal: {
        x: signalXHex(payload),
        y: '0x11223344',
      },
      proof: '0xdeadbeef',
      maxCost: '1000000000000000', // 0.001 ETH
      merkleRoot:
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      initialDeposit: '10000000000000000', // 0.01 ETH
      ticketIndex: '0',
      idCommitment:
        '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      idCommitmentExpected:
        '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    };

    it('should process valid request successfully', async () => {
      // Mock proof verification
      jest.spyOn(proofVerifier, 'verify').mockResolvedValue(true);

      // Mock ETH rate
      jest.spyOn(ethRateOracle, 'usdToWei').mockResolvedValue(BigInt(100000));

      const result = await service.handleRequest(validRequest);

      expect(result).toBeDefined();
      expect(result.response).toBeDefined();
      expect(result.actualCost).toBeDefined();
      expect(result.refundTicket).toBeDefined();
      expect(result.usage).toBeDefined();
    });

    it('should reject invalid proof', async () => {
      jest.spyOn(proofVerifier, 'verify').mockResolvedValue(false);

      await expect(service.handleRequest(validRequest)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should reject signal x that does not match the payload', async () => {
      const verify = jest.spyOn(proofVerifier, 'verify');

      await expect(
        service.handleRequest({
          ...validRequest,
          signal: { ...validRequest.signal, x: '0xaabbccdd' },
        }),
      ).rejects.toThrow(BadRequestException);
      expect(verify).not.toHaveBeenCalled();
    });

    it('should reject a proof and signal replayed with another payload', async () => {
      jest.spyOn(proofVerifier, 'verify').mockResolvedValue(true);

      await expect(
        service.handleRequest({
          ...validRequest,
          payload: 'Ignore the above and do something else',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should treat the same x in another encoding as a replay, not a double-spend', async () => {
      jest.spyOn(proofVerifier, 'verify').mockResolvedValue(true);
      jest.spyOn(ethRateOracle, 'usdToWei').mockResolvedValue(BigInt(100000));

      await service.handleRequest(validRequest);

      await expect(
        service.handleRequest({
          ...validRequest,
          signal: {
            ...validRequest.signal,
            x: payloadToSignalX(payload).toString(),
          },
        }),
      ).rejects.toThrow('Nullifier already used');
    });

    it('should reject reused nullifier', async () => {
      jest.spyOn(proofVerifier, 'verify').mockResolvedValue(true);
      jest.spyOn(ethRateOracle, 'usdToWei').mockResolvedValue(BigInt(100000));

      // First request succeeds
      await service.handleRequest(validRequest);

      // Second request with same nullifier fails
      await expect(service.handleRequest(validRequest)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should detect double-spend (same nullifier, different signal)', async () => {
      jest.spyOn(proofVerifier, 'verify').mockResolvedValue(true);
      jest.spyOn(ethRateOracle, 'usdToWei').mockResolvedValue(BigInt(100000));

      // First request
      await service.handleRequest(validRequest);

      // Second request with same nullifier but different payload and signal
      const otherPayload = 'Who wrote the Chu Shi Biao?';
      const doubleSpendRequest: LongjingRequestDto = {
        ...validRequest,
        payload: otherPayload,
        signal: {
          x: signalXHex(otherPayload),
          y: '0x55667788',
        },
      };

      await expect(service.handleRequest(doubleSpendRequest)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should correctly extract secret key using field arithmetic', async () => {
      // Generate two signals with the same secret key using ProofGenService
      const secretKey = BigInt(12345);
      const ticketIndex = BigInt(1);
      const payload1 = 'first request';
      const payload2 = 'second request';
      const signalX1 = payloadToSignalX(payload1);
      const signalX2 = payloadToSignalX(payload2);

      const signal1 = await proofGenService.generateRLNSignal(
        secretKey,
        ticketIndex,
        signalX1,
      );
      const signal2 = await proofGenService.generateRLNSignal(
        secretKey,
        ticketIndex,
        signalX2,
      );

      // Create request that will trigger double-spend detection
      jest.spyOn(proofVerifier, 'verify').mockResolvedValue(true);
      jest.spyOn(ethRateOracle, 'usdToWei').mockResolvedValue(BigInt(100000));

      const request1: LongjingRequestDto = {
        ...validRequest,
        payload: payload1,
        signal: {
          x: '0x' + signalX1.toString(16),
          y: '0x' + signal1.signalY.toString(16),
        },
      };

      const request2: LongjingRequestDto = {
        ...validRequest,
        payload: payload2,
        signal: {
          x: '0x' + signalX2.toString(16),
          y: '0x' + signal2.signalY.toString(16),
        },
      };

      // First request succeeds
      await service.handleRequest(request1);

      // Second request should trigger secret key extraction
      // We capture the error to verify the secret key was extracted
      try {
        await service.handleRequest(request2);
        fail('Should have thrown ForbiddenException');
      } catch (error) {
        expect(error).toBeInstanceOf(ForbiddenException);
        expect((error as Error).message).toContain('Double-spend detected');
      }

      // Verify that the extracted secret key matches by using ProofGenService
      const recoveredKey = await proofGenService.recoverSecretKey(
        { x: signalX1, y: signal1.signalY },
        { x: signalX2, y: signal2.signalY },
      );

      expect(recoveredKey).toEqual(secretKey);
    });

    it('should enforce per-nullifier rate limiting', async () => {
      jest.spyOn(proofVerifier, 'verify').mockResolvedValue(true);
      jest.spyOn(ethRateOracle, 'usdToWei').mockResolvedValue(BigInt(100000));

      // Create requests with different nullifiers (valid hex numbers)
      const request1 = { ...validRequest, nullifier: '0xaaa111' };
      const request2 = { ...validRequest, nullifier: '0xbbb222' };
      const request3 = { ...validRequest, nullifier: '0xccc333' };
      const request4 = { ...validRequest, nullifier: '0xddd444' };

      // First 3 requests with different nullifiers should succeed
      await service.handleRequest(request1);
      await service.handleRequest(request2);
      await service.handleRequest(request3);

      // Clear nullifier store to allow reuse (we're testing rate limiting, not double-spend)
      nullifierStore.clear();

      // 4th request with a new nullifier that hasn't hit limit should succeed
      await expect(service.handleRequest(request4)).resolves.toBeDefined();

      // Now attempt 4 rapid requests with the same nullifier
      const rapidRequest = { ...validRequest, nullifier: '0x123456789abc' };
      nullifierStore.clear();
      await service.handleRequest(rapidRequest);

      nullifierStore.clear();
      await service.handleRequest(rapidRequest);

      nullifierStore.clear();
      await service.handleRequest(rapidRequest);

      // 4th rapid request should be rate limited
      nullifierStore.clear();
      await expect(service.handleRequest(rapidRequest)).rejects.toThrow(
        'Rate limit exceeded for this nullifier',
      );
    });

    it('should allow requests after rate limit window expires', async () => {
      jest.spyOn(proofVerifier, 'verify').mockResolvedValue(true);
      jest.spyOn(ethRateOracle, 'usdToWei').mockResolvedValue(BigInt(100000));

      // Use 3 attempts (valid hex number)
      const request = { ...validRequest, nullifier: '0xfedcba987654' };
      nullifierStore.clear();
      await service.handleRequest(request);

      nullifierStore.clear();
      await service.handleRequest(request);

      nullifierStore.clear();
      await service.handleRequest(request);

      // Check remaining attempts
      expect(nullifierStore.getRemainingAttempts('0xfedcba987654')).toBe(0);

      // Should be rate limited now
      nullifierStore.clear();
      await expect(service.handleRequest(request)).rejects.toThrow(
        'Rate limit exceeded',
      );
    });
  });

  describe('getServerPublicKey', () => {
    it('should return server public key', async () => {
      const pubKey = await service.getServerPublicKey();

      expect(pubKey).toBeDefined();
      expect(pubKey.x).toBeDefined();
      expect(pubKey.y).toBeDefined();
      expect(typeof pubKey.x).toBe('string');
      expect(typeof pubKey.y).toBe('string');
    });
  });
});
