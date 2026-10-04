/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-argument */

import { Test, TestingModule } from '@nestjs/testing';
import { ZKProofService } from './zkproof.service';

jest.mock('fs');
jest.mock('snarkjs', () => ({
  groth16: {
    fullProve: jest.fn(),
    verify: jest.fn(),
  },
  zKey: {
    exportSolidityVerifier: jest.fn(),
  },
}));

jest.mock('circomlibjs', () => ({
  poseidon: jest.fn((inputs: any[]) => {
    // Mock poseidon hash - just sum the inputs
    return inputs.reduce((a: any, b: any) => BigInt(a) + BigInt(b), BigInt(0));
  }),
}));

describe('ZKProofService', () => {
  let service: ZKProofService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [ZKProofService],
    }).compile();

    service = module.get<ZKProofService>(ZKProofService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('initialization', () => {
    it('should be defined even when keys are not found', () => {
      expect(service).toBeDefined();
    });

    it('should return false when keys are not available', () => {
      // Keys won't be available in test environment
      expect(service.isAvailable()).toBe(false);
    });
  });

  describe('generateProof', () => {
    const mockInput = {
      secretKey: '12345',
      pathElements: ['0x1', '0x2'],
      pathIndices: [0, 1],
      ticketIndex: 1,
      merkleRoot: '0x1234',
      maxCost: '1000000',
      initialDeposit: '5000000',
      signalX: '100',
    };

    it('should throw error when proving key not available', async () => {
      await expect(service.generateProof(mockInput)).rejects.toThrow(
        'Proving key not available - run key setup first',
      );
    });
  });

  describe('verifyProof', () => {
    const mockProof = { pi_a: ['0x1', '0x2'] };
    const mockPublicSignals = ['signal1', 'signal2'];

    it('should return false when verification key not available', async () => {
      const result = await service.verifyProof(mockProof, mockPublicSignals);
      expect(result).toBe(false);
    });
  });

  describe('exportSolidityVerifier', () => {
    it('should throw error when verification key not available', async () => {
      await expect(service.exportSolidityVerifier()).rejects.toThrow(
        'Verification key not available',
      );
    });
  });

  describe('isAvailable', () => {
    it('should return false when keys are not loaded', () => {
      expect(service.isAvailable()).toBe(false);
    });
  });

  describe('calculatePublicOutputs', () => {
    it('should calculate public outputs from private inputs', () => {
      const input = {
        secretKey: BigInt(12345),
        ticketIndex: BigInt(1),
        signalX: BigInt(100),
      };

      const result = service.calculatePublicOutputs(input);

      expect(result).toHaveProperty('nullifier');
      expect(result).toHaveProperty('signalY');
      expect(result).toHaveProperty('idCommitment');
      expect(typeof result.nullifier).toBe('bigint');
      expect(typeof result.signalY).toBe('bigint');
      expect(typeof result.idCommitment).toBe('bigint');
    });

    it('should produce consistent outputs for same inputs', () => {
      const input = {
        secretKey: BigInt(12345),
        ticketIndex: BigInt(1),
        signalX: BigInt(100),
      };

      const result1 = service.calculatePublicOutputs(input);
      const result2 = service.calculatePublicOutputs(input);

      expect(result1.nullifier).toEqual(result2.nullifier);
      expect(result1.signalY).toEqual(result2.signalY);
      expect(result1.idCommitment).toEqual(result2.idCommitment);
    });

    it('should produce different outputs for different inputs', () => {
      const input1 = {
        secretKey: BigInt(12345),
        ticketIndex: BigInt(1),
        signalX: BigInt(100),
      };

      const input2 = {
        secretKey: BigInt(54321),
        ticketIndex: BigInt(1),
        signalX: BigInt(100),
      };

      const result1 = service.calculatePublicOutputs(input1);
      const result2 = service.calculatePublicOutputs(input2);

      expect(result1.nullifier).not.toEqual(result2.nullifier);
      expect(result1.idCommitment).not.toEqual(result2.idCommitment);
    });
  });
});
