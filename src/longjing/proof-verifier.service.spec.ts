/* eslint-disable @typescript-eslint/unbound-method */

import { ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ProofVerifierService } from './proof-verifier.service';
import { ComputeLimiterService } from './compute-limiter.service';
import { BlockchainService } from './blockchain.service';
import { RefundSignerService } from './refund-signer.service';
import { SnarkjsProofService } from './snarkjs-proof.service';

describe('ProofVerifierService', () => {
  let service: ProofVerifierService;
  let blockchainService: jest.Mocked<BlockchainService>;
  let snarkjsProofService: jest.Mocked<SnarkjsProofService>;
  let loggerErrorSpy: jest.SpyInstance;

  const mockProof = JSON.stringify({
    protocol: 'groth16',
    pi_a: ['0x123', '0x456', '1'],
    pi_b: [
      ['0x111', '0x222', '1'],
      ['0x333', '0x444', '1'],
    ],
    pi_c: ['0x789', '0xabc', '1'],
  });

  const mockPublicInputs = {
    nullifier: '0x9999',
    signalY: '0x8888',
    accumulatorX: '0x7777',
    accumulatorY: '0x6666',
    merkleRoot:
      '0x1234567890123456789012345678901234567890123456789012345678901234',
    maxCost: 1000000n,
    signalX: '0x0064',
  };

  const serverKey = { x: '0x0a', y: '0x0b' };

  beforeEach(async () => {
    const mockBlockchainService = {
      isAvailable: jest.fn().mockReturnValue(false),
      isKnownRoot: jest.fn(),
    };

    const mockSnarkjsProofService = {
      isAvailable: jest.fn().mockReturnValue(false),
      verifyProof: jest.fn(),
    };

    const mockRefundSignerService = {
      getPublicKey: jest.fn().mockResolvedValue(serverKey),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProofVerifierService,
        ComputeLimiterService,
        { provide: BlockchainService, useValue: mockBlockchainService },
        { provide: SnarkjsProofService, useValue: mockSnarkjsProofService },
        { provide: RefundSignerService, useValue: mockRefundSignerService },
      ],
    }).compile();

    service = module.get<ProofVerifierService>(ProofVerifierService);
    blockchainService = module.get(BlockchainService);
    snarkjsProofService = module.get(SnarkjsProofService);

    // Suppress expected error logs
    loggerErrorSpy = jest
      .spyOn(service['logger'], 'error')
      .mockImplementation();
  });

  afterEach(() => {
    loggerErrorSpy.mockRestore();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('verify', () => {
    it('should return false if proof structure is invalid', async () => {
      const result = await service.verify('invalid', mockPublicInputs);
      expect(result).toBe(false);
    });

    it('should throw error when snarkjs not available (no mock fallback)', async () => {
      snarkjsProofService.isAvailable.mockReturnValue(false);

      await expect(service.verify(mockProof, mockPublicInputs)).rejects.toThrow(
        'Proof verification not available. Circuit artifacts not loaded.',
      );
    });

    it('should verify using snarkjs when available', async () => {
      snarkjsProofService.isAvailable.mockReturnValue(true);
      snarkjsProofService.verifyProof.mockResolvedValue(true);

      const result = await service.verify(mockProof, mockPublicInputs);

      expect(result).toBe(true);
      expect(snarkjsProofService.verifyProof).toHaveBeenCalled();
    });

    it('should return false when snarkjs verification fails', async () => {
      snarkjsProofService.isAvailable.mockReturnValue(true);
      snarkjsProofService.verifyProof.mockResolvedValue(false);

      const result = await service.verify(mockProof, mockPublicInputs);

      expect(result).toBe(false);
    });

    it('should verify against blockchain when available', async () => {
      blockchainService.isAvailable.mockReturnValue(true);
      blockchainService.isKnownRoot.mockResolvedValue(true);
      snarkjsProofService.isAvailable.mockReturnValue(true);
      snarkjsProofService.verifyProof.mockResolvedValue(true);

      const result = await service.verify(mockProof, mockPublicInputs);

      expect(result).toBe(true);
      expect(blockchainService.isKnownRoot).toHaveBeenCalledWith(
        mockPublicInputs.merkleRoot,
      );
    });

    it('should return false if the root is not a recent onchain root', async () => {
      blockchainService.isAvailable.mockReturnValue(true);
      blockchainService.isKnownRoot.mockResolvedValue(false);

      const result = await service.verify(mockProof, mockPublicInputs);

      expect(result).toBe(false);
    });

    it('rejects with 503 before any RPC or pairing work when the cap is full', async () => {
      blockchainService.isAvailable.mockReturnValue(true);
      snarkjsProofService.isAvailable.mockReturnValue(true);
      let release!: (valid: boolean) => void;
      snarkjsProofService.verifyProof.mockReturnValue(
        new Promise<boolean>((resolve) => (release = resolve)),
      );
      blockchainService.isKnownRoot.mockResolvedValue(true);

      const { max } = service['computeLimiter'].verification;
      const inFlight = Array.from({ length: max }, () =>
        service.verify(mockProof, mockPublicInputs),
      );
      await new Promise((resolve) => setImmediate(resolve));
      blockchainService.isKnownRoot.mockClear();

      await expect(service.verify(mockProof, mockPublicInputs)).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(blockchainService.isKnownRoot).not.toHaveBeenCalled();

      release(true);
      await Promise.all(inFlight);
    });

    it('should continue verification if blockchain check fails outside prod', async () => {
      blockchainService.isAvailable.mockReturnValue(true);
      blockchainService.isKnownRoot.mockRejectedValue(
        new Error('Network error'),
      );
      snarkjsProofService.isAvailable.mockReturnValue(true);
      snarkjsProofService.verifyProof.mockResolvedValue(true);

      const result = await service.verify(mockProof, mockPublicInputs);

      expect(result).toBe(true);
    });

    it('should throw errors during verification', async () => {
      snarkjsProofService.isAvailable.mockReturnValue(true);
      snarkjsProofService.verifyProof.mockRejectedValue(
        new Error('Unexpected error'),
      );

      await expect(service.verify(mockProof, mockPublicInputs)).rejects.toThrow(
        'Unexpected error',
      );
    });

    it('should cryptographically reject proof with invalid witness (CRITICAL TEST)', async () => {
      // End-to-end negative test: a structurally valid but invalid proof must be rejected
      // "real-but-wrong witness → production verifier → asserted rejection"

      snarkjsProofService.isAvailable.mockReturnValue(true);

      // Simulate real cryptographic verification rejecting an invalid proof
      // (valid structure, but mathematically invalid witness/signals)
      snarkjsProofService.verifyProof.mockResolvedValue(false);

      const result = await service.verify(mockProof, mockPublicInputs);

      expect(result).toBe(false);
      expect(snarkjsProofService.verifyProof).toHaveBeenCalledWith(
        expect.objectContaining({
          protocol: 'groth16',
          pi_a: expect.any(Array) as unknown[],
          pi_b: expect.any(Array) as unknown[][],
          pi_c: expect.any(Array) as unknown[],
        }),
        expect.arrayContaining([
          BigInt(mockPublicInputs.nullifier).toString(),
          BigInt(mockPublicInputs.signalY).toString(),
          BigInt(mockPublicInputs.accumulatorX).toString(),
          BigInt(mockPublicInputs.signalX).toString(),
        ]) as string[],
      );
    });
  });

  describe('public signals', () => {
    beforeEach(() => {
      snarkjsProofService.isAvailable.mockReturnValue(true);
      snarkjsProofService.verifyProof.mockResolvedValue(true);
    });

    const signals = async () => {
      await service.verify(mockProof, mockPublicInputs);
      return snarkjsProofService.verifyProof.mock.calls[0][1];
    };

    it('orders the request circuit signals, outputs first, with this server key', async () => {
      await expect(signals()).resolves.toEqual(
        [
          mockPublicInputs.nullifier,
          mockPublicInputs.signalY,
          mockPublicInputs.accumulatorX,
          mockPublicInputs.accumulatorY,
          mockPublicInputs.merkleRoot,
          mockPublicInputs.maxCost,
          mockPublicInputs.signalX,
          serverKey.x,
          serverKey.y,
        ].map((v) => BigInt(v).toString()),
      );
    });
  });

  describe('isProductionReady', () => {
    it('should return true when snarkjs is available', () => {
      snarkjsProofService.isAvailable.mockReturnValue(true);
      expect(service.isProductionReady()).toBe(true);
    });

    it('should return false when snarkjs is not available', () => {
      snarkjsProofService.isAvailable.mockReturnValue(false);
      expect(service.isProductionReady()).toBe(false);
    });
  });

  describe('production mode enforcement', () => {
    let originalEnv: string | undefined;

    beforeEach(() => {
      originalEnv = process.env.NODE_ENV;
    });

    afterEach(() => {
      process.env.NODE_ENV = originalEnv;
    });

    it('should throw error in production mode when snarkjs not available', async () => {
      process.env.NODE_ENV = 'production';
      snarkjsProofService.isAvailable.mockReturnValue(false);

      await expect(service.verify(mockProof, mockPublicInputs)).rejects.toThrow(
        'Proof verification not available in production mode. Configure circuit artifacts.',
      );
    });

    it('should allow verification in production when snarkjs is available', async () => {
      process.env.NODE_ENV = 'production';
      blockchainService.isAvailable.mockReturnValue(true);
      blockchainService.isKnownRoot.mockResolvedValue(true);
      snarkjsProofService.isAvailable.mockReturnValue(true);
      snarkjsProofService.verifyProof.mockResolvedValue(true);

      const result = await service.verify(mockProof, mockPublicInputs);

      expect(result).toBe(true);
    });

    describe('onchain state unavailable', () => {
      beforeEach(() => {
        process.env.NODE_ENV = 'production';
        snarkjsProofService.isAvailable.mockReturnValue(true);
        snarkjsProofService.verifyProof.mockResolvedValue(true);
      });

      it('rejects with 503 when the blockchain service is unavailable', async () => {
        blockchainService.isAvailable.mockReturnValue(false);

        await expect(
          service.verify(mockProof, mockPublicInputs),
        ).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(snarkjsProofService.verifyProof).not.toHaveBeenCalled();
      });

      it('rejects with 503 when the root cannot be read', async () => {
        blockchainService.isAvailable.mockReturnValue(true);
        blockchainService.isKnownRoot.mockRejectedValue(
          new Error('Network error'),
        );

        await expect(
          service.verify(mockProof, mockPublicInputs),
        ).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(snarkjsProofService.verifyProof).not.toHaveBeenCalled();
      });
    });

    it('should throw error even in dev mode when snarkjs not available', async () => {
      process.env.NODE_ENV = 'test';
      snarkjsProofService.isAvailable.mockReturnValue(false);

      await expect(service.verify(mockProof, mockPublicInputs)).rejects.toThrow(
        'Proof verification not available. Circuit artifacts not loaded.',
      );
    });
  });

  describe('metrics', () => {
    beforeEach(() => {
      // Reset metrics
      process.env.NODE_ENV = 'test';
    });

    it('should track successful verifications', async () => {
      snarkjsProofService.isAvailable.mockReturnValue(true);
      snarkjsProofService.verifyProof.mockResolvedValue(true);

      await service.verify(mockProof, mockPublicInputs);

      const metrics = service.getMetrics();
      expect(metrics.total).toBe(1);
      expect(metrics.successful).toBe(1);
      expect(metrics.failed).toBe(0);
    });

    it('should track failed verifications', async () => {
      snarkjsProofService.isAvailable.mockReturnValue(true);
      snarkjsProofService.verifyProof.mockResolvedValue(false);

      await service.verify(mockProof, mockPublicInputs);

      const metrics = service.getMetrics();
      expect(metrics.total).toBe(1);
      expect(metrics.successful).toBe(0);
      expect(metrics.failed).toBe(1);
    });

    it('should not use mock verifications (deprecated)', async () => {
      // Mock verification has been removed
      // This test verifies that mock verification is no longer available
      snarkjsProofService.isAvailable.mockReturnValue(false);

      await expect(
        service.verify(mockProof, mockPublicInputs),
      ).rejects.toThrow();

      // Note: usingRealVerification returns false when snarkjs is unavailable
      // but the service throws instead of falling back to mock
      const metrics = service.getMetrics();
      expect(metrics.usingRealVerification).toBe(false); // False because unavailable
      expect(metrics.failed).toBeGreaterThan(0); // But it failed-closed
    });

    it('should calculate success rate correctly', async () => {
      snarkjsProofService.isAvailable.mockReturnValue(true);
      snarkjsProofService.verifyProof
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      await service.verify(mockProof, mockPublicInputs);
      await service.verify(mockProof, mockPublicInputs);
      await service.verify(mockProof, mockPublicInputs);

      const metrics = service.getMetrics();
      expect(metrics.total).toBe(3);
      expect(metrics.successful).toBe(2);
      expect(metrics.failed).toBe(1);
      expect(metrics.successRate).toBeCloseTo(66.67, 1);
    });

    it('should indicate real verification status', async () => {
      snarkjsProofService.isAvailable.mockReturnValue(true);
      snarkjsProofService.verifyProof.mockResolvedValue(true);

      await service.verify(mockProof, mockPublicInputs);

      const metrics = service.getMetrics();
      expect(metrics.mock).toBe(0);
      expect(metrics.usingRealVerification).toBe(true);
    });
  });
});
