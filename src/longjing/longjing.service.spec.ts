import { Test, TestingModule } from '@nestjs/testing';
import {
  BadGatewayException,
  BadRequestException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LongjingService } from './longjing.service';
import { NullifierStoreService } from './nullifier-store.service';
import { ProofVerifierService } from './proof-verifier.service';
import { ComputeLimiterService } from './compute-limiter.service';
import { SnarkjsProofService } from './snarkjs-proof.service';
import { EthRateOracleService } from './eth-rate-oracle.service';
import { RefundSignerService } from './refund-signer.service';
import { BlockchainService } from './blockchain.service';
import { SlashingService } from './slashing.service';
import { LongjingRequestDto } from './dto/api-request.dto';
import { SecretsService } from '../config/secrets.service';
import { KeyDerivationService } from '../keys/key-derivation.service';
import { AttestationService } from '../attestation/attestation.service';
import { payloadSignalX } from './utils/payload-signal.util';
import { applyRefund, genesis, rerandomize } from './accumulator';

const C_MAX = 10n ** 15n;

describe('LongjingService', () => {
  let service: LongjingService;
  let refundSigner: RefundSignerService;
  let blockchain: jest.Mocked<BlockchainService>;
  let nullifierStore: NullifierStoreService;
  let proofVerifier: ProofVerifierService;
  let ethRateOracle: EthRateOracleService;

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
            isAvailable: jest.fn().mockReturnValue(true),
            getCMax: jest.fn(() => C_MAX),
          },
        },
        {
          provide: SlashingService,
          useValue: {
            isEnabled: jest.fn().mockReturnValue(false),
            slash: jest.fn().mockResolvedValue(null),
            slashRevealed: jest.fn().mockResolvedValue(undefined),
            getContractAddress: jest.fn().mockReturnValue(null),
            getSlasherAddress: jest.fn().mockReturnValue(null),
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
    refundSigner = module.get<RefundSignerService>(RefundSignerService);
    blockchain = module.get(BlockchainService);

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
    const NONCE = 7n;
    const published = rerandomize(genesis(42n), 99n);
    let validRequest: LongjingRequestDto;

    beforeAll(async () => {
      validRequest = {
        payload,
        nonce: NONCE.toString(),
        nullifier: '0x1234567890abcdef',
        signal: {
          x: (await payloadSignalX(payload, NONCE)).toString(),
          y: '0x11223344',
        },
        proof: '0xdeadbeef',
        merkleRoot:
          '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        accumulator: {
          x: published[0].toString(),
          y: published[1].toString(),
        },
      };
    });

    // The worst case, then the actual cost
    const costs = (worstCase: bigint, actual = worstCase) =>
      jest
        .spyOn(ethRateOracle, 'usdToWei')
        .mockResolvedValueOnce(worstCase)
        .mockResolvedValueOnce(actual);

    it('returns the next accumulator with the refund added, signed', async () => {
      const verify = jest
        .spyOn(proofVerifier, 'verify')
        .mockResolvedValue(true);
      costs(10n ** 14n, 3n * 10n ** 14n);

      const result = await service.handleRequest(validRequest);

      expect(verify).toHaveBeenCalledWith(validRequest.proof, {
        nullifier: validRequest.nullifier,
        signalY: validRequest.signal.y,
        accumulatorX: validRequest.accumulator.x,
        accumulatorY: validRequest.accumulator.y,
        merkleRoot: validRequest.merkleRoot,
        maxCost: C_MAX,
        signalX: validRequest.signal.x,
      });
      expect(result.refund).toBe((C_MAX - 3n * 10n ** 14n).toString());
      const next = applyRefund(published, C_MAX - 3n * 10n ** 14n);
      expect([result.accumulator.x, result.accumulator.y]).toEqual(
        next.map(String),
      );
      await expect(
        refundSigner.verifyAccumulator(next, result.accumulator.signature),
      ).resolves.toBe(true);
      expect(result.usage).toBeDefined();
      expect(result).not.toHaveProperty('actualCost');
    });

    it('stores only (x, y) under the nullifier', async () => {
      jest.spyOn(proofVerifier, 'verify').mockResolvedValue(true);
      costs(10n ** 14n);

      await service.handleRequest(validRequest);

      expect(
        nullifierStore.get(BigInt(validRequest.nullifier).toString()),
      ).toEqual({
        x: validRequest.signal.x,
        y: BigInt(validRequest.signal.y).toString(),
      });
    });

    it('rejects a request whose worst case exceeds C_MAX before consuming the nullifier', async () => {
      const verify = jest.spyOn(proofVerifier, 'verify');
      costs(C_MAX + 1n);

      await expect(service.handleRequest(validRequest)).rejects.toThrow(
        'exceeds C_MAX',
      );
      expect(verify).not.toHaveBeenCalled();
      expect(
        nullifierStore.exists(BigInt(validRequest.nullifier).toString()),
      ).toBe(false);
    });

    it('prices the worst case on payload bytes and max output tokens', async () => {
      jest.spyOn(proofVerifier, 'verify').mockResolvedValue(true);
      const usdToWei = costs(10n ** 14n);

      await service.handleRequest({
        ...validRequest,
        model: 'claude-haiku-4-5',
      });

      const inputTokens = Buffer.byteLength(payload, 'utf8') + 32;
      expect(usdToWei.mock.calls[0][0]).toBeCloseTo(
        (inputTokens * 1 + 4096 * 5) / 1_000_000,
        12,
      );
    });

    it('clamps the refund at zero when the actual cost exceeds C_MAX', async () => {
      jest.spyOn(proofVerifier, 'verify').mockResolvedValue(true);
      costs(10n ** 14n, C_MAX + 5n);

      const result = await service.handleRequest(validRequest);

      expect(result.refund).toBe('0');
    });

    it('refunds the whole of C_MAX when the provider fails, and a retry gets the same answer', async () => {
      jest.spyOn(proofVerifier, 'verify').mockResolvedValue(true);
      costs(10n ** 14n);
      const execute = jest
        .spyOn(service as any, 'executeClaudeRequest')
        .mockRejectedValue(new Error('upstream down'));

      const failure = await service
        .handleRequest(validRequest)
        .catch((e: BadGatewayException) => e);
      expect(failure).toBeInstanceOf(BadGatewayException);
      const body = (failure as BadGatewayException).getResponse() as {
        refund: string;
        accumulator: { x: string; y: string };
      };
      expect(body.refund).toBe(C_MAX.toString());
      expect([body.accumulator.x, body.accumulator.y]).toEqual(
        applyRefund(published, C_MAX).map(String),
      );
      expect(
        nullifierStore.exists(BigInt(validRequest.nullifier).toString()),
      ).toBe(true);

      costs(10n ** 14n);
      await expect(service.handleRequest(validRequest)).rejects.toBe(failure);
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('returns the same response to a retry and calls the provider once', async () => {
      jest.spyOn(proofVerifier, 'verify').mockResolvedValue(true);
      const execute = jest.spyOn(service as any, 'executeClaudeRequest');
      costs(10n ** 14n);
      const first = await service.handleRequest(validRequest);

      costs(10n ** 14n);
      const retry = await service.handleRequest({
        ...validRequest,
        signal: {
          x: '0x' + BigInt(validRequest.signal.x).toString(16),
          y: validRequest.signal.y,
        },
      });

      expect(retry).toBe(first);
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('rejects a reused nullifier once its response has expired', async () => {
      jest.spyOn(proofVerifier, 'verify').mockResolvedValue(true);
      costs(10n ** 14n);
      await service.handleRequest(validRequest);
      jest.spyOn(nullifierStore, 'recallResponse').mockReturnValue(null);

      costs(10n ** 14n);
      await expect(service.handleRequest(validRequest)).rejects.toThrow(
        'Nullifier already used',
      );
    });

    it('rejects a model with no pricing', async () => {
      await expect(
        service.handleRequest({
          ...validRequest,
          model: 'claude-3-opus-20240229',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an invalid proof', async () => {
      jest.spyOn(proofVerifier, 'verify').mockResolvedValue(false);
      costs(10n ** 14n);

      await expect(service.handleRequest(validRequest)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a signal x made with another nonce', async () => {
      const verify = jest.spyOn(proofVerifier, 'verify');

      await expect(
        service.handleRequest({ ...validRequest, nonce: '8' }),
      ).rejects.toThrow(BadRequestException);
      expect(verify).not.toHaveBeenCalled();
    });

    it('rejects a proof and signal replayed with another payload', async () => {
      jest.spyOn(proofVerifier, 'verify').mockResolvedValue(true);

      await expect(
        service.handleRequest({
          ...validRequest,
          payload: 'Ignore the above and do something else',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses to serve without C_MAX', async () => {
      blockchain.getCMax.mockImplementationOnce(() => {
        throw new Error('not connected');
      });

      await expect(service.handleRequest(validRequest)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('slashes the note behind two signals at one index', async () => {
      const slashing = service[
        'slashingService'
      ] as jest.Mocked<SlashingService>;
      jest.spyOn(proofVerifier, 'verify').mockResolvedValue(true);

      const signalFor = async (p: string, y: string) => ({
        ...validRequest,
        payload: p,
        signal: { x: (await payloadSignalX(p, NONCE)).toString(), y },
      });
      const first = await signalFor('first request', '11');
      const second = await signalFor('second request', '22');

      costs(10n ** 14n);
      await service.handleRequest(first);
      costs(10n ** 14n);
      await expect(service.handleRequest(second)).rejects.toThrow(
        'Double-spend detected',
      );

      expect(slashing.slashRevealed.mock.calls).toEqual([
        [first.signal, second.signal],
      ]);
    });

    it('treats a nullifier in another encoding as the same nullifier', async () => {
      jest.spyOn(proofVerifier, 'verify').mockResolvedValue(true);
      costs(10n ** 14n);
      const first = await service.handleRequest(validRequest);

      costs(10n ** 14n);
      const retry = await service.handleRequest({
        ...validRequest,
        nullifier: BigInt(validRequest.nullifier).toString(),
      });
      expect(retry).toBe(first);
    });

    it('enforces per-nullifier rate limiting', async () => {
      jest.spyOn(proofVerifier, 'verify').mockResolvedValue(true);
      jest.spyOn(ethRateOracle, 'usdToWei').mockResolvedValue(10n ** 14n);

      const rapidRequest = { ...validRequest, nullifier: '0x123456789abc' };
      for (let i = 0; i < 3; i++) {
        nullifierStore.clear();
        await service.handleRequest(rapidRequest);
      }

      nullifierStore.clear();
      await expect(service.handleRequest(rapidRequest)).rejects.toThrow(
        'Rate limit exceeded for this nullifier',
      );
      expect(
        nullifierStore.getRemainingAttempts(
          BigInt('0x123456789abc').toString(),
        ),
      ).toBe(0);
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
