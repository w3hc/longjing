/* eslint-disable @typescript-eslint/no-unsafe-assignment */

/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import { Test, TestingModule } from '@nestjs/testing';
import { ProofGenService } from './proof-gen.service';

describe('ProofGenService', () => {
  let service: ProofGenService;
  let loggerErrorSpy: jest.SpyInstance;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ProofGenService],
    }).compile();

    service = module.get<ProofGenService>(ProofGenService);

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

  describe('generateIdCommitment', () => {
    it('should generate an identity commitment from secret key', async () => {
      const secretKey = BigInt(12345);
      const commitment = await service.generateIdCommitment(secretKey);

      expect(commitment).toBeDefined();
      expect(typeof commitment).toBe('bigint');
    });

    it('should generate different commitments for different keys', async () => {
      const commitment1 = await service.generateIdCommitment(BigInt(111));
      const commitment2 = await service.generateIdCommitment(BigInt(222));

      expect(commitment1).not.toEqual(commitment2);
    });

    it('should generate same commitment for same key', async () => {
      const secretKey = BigInt(99999);
      const commitment1 = await service.generateIdCommitment(secretKey);
      const commitment2 = await service.generateIdCommitment(secretKey);

      expect(commitment1).toEqual(commitment2);
    });
  });

  describe('generateRLNSignal', () => {
    it('should generate RLN signal components', async () => {
      const secretKey = BigInt(12345);
      const ticketIndex = BigInt(1);
      const signalX = BigInt(100);

      const result = await service.generateRLNSignal(
        secretKey,
        ticketIndex,
        signalX,
      );

      expect(result).toBeDefined();
      expect(result.nullifier).toBeDefined();
      expect(result.signalY).toBeDefined();
      expect(result.a).toBeDefined();
      expect(typeof result.nullifier).toBe('bigint');
      expect(typeof result.signalY).toBe('bigint');
      expect(typeof result.a).toBe('bigint');
    }, 10000);

    it('should generate different nullifiers for different ticket indices', async () => {
      const secretKey = BigInt(12345);
      const signalX = BigInt(100);

      const result1 = await service.generateRLNSignal(
        secretKey,
        BigInt(1),
        signalX,
      );
      const result2 = await service.generateRLNSignal(
        secretKey,
        BigInt(2),
        signalX,
      );

      expect(result1.nullifier).not.toEqual(result2.nullifier);
    });

    it('should generate different signals for different signalX values', async () => {
      const secretKey = BigInt(12345);
      const ticketIndex = BigInt(1);

      const result1 = await service.generateRLNSignal(
        secretKey,
        ticketIndex,
        BigInt(100),
      );
      const result2 = await service.generateRLNSignal(
        secretKey,
        ticketIndex,
        BigInt(200),
      );

      expect(result1.signalY).not.toEqual(result2.signalY);
      expect(result1.nullifier).toEqual(result2.nullifier); // Same nullifier for same key+ticket
    });
  });

  describe('recoverSecretKey', () => {
    it('should recover secret key from two RLN signals', async () => {
      const secretKey = BigInt(12345);
      const ticketIndex = BigInt(1);
      const signalX1 = BigInt(100);
      const signalX2 = BigInt(200);

      // Generate two signals with same secret key
      const signal1 = await service.generateRLNSignal(
        secretKey,
        ticketIndex,
        signalX1,
      );
      const signal2 = await service.generateRLNSignal(
        secretKey,
        ticketIndex,
        signalX2,
      );

      // Recover secret key
      const recovered = await service.recoverSecretKey(
        { x: signalX1, y: signal1.signalY },
        { x: signalX2, y: signal2.signalY },
      );

      expect(recovered).toEqual(secretKey);
    });

    it('should throw error when signals have same x values', async () => {
      const signal = { x: BigInt(100), y: BigInt(200) };

      await expect(service.recoverSecretKey(signal, signal)).rejects.toThrow(
        'Signals must have different x values',
      );
    });
  });

  describe('generateMockProof', () => {
    it('should generate a mock proof with correct structure', async () => {
      const input = {
        secretKey: BigInt(12345),
        ticketIndex: BigInt(1),
        signalX: BigInt(100),
        merkleRoot:
          '0x1234567890123456789012345678901234567890123456789012345678901234',
        maxCost: '1000000',
        initialDeposit: '5000000',
      };

      const result = await service.generateMockProof(input);

      expect(result).toBeDefined();
      expect(result.proof).toBeDefined();
      expect(result.publicInputs).toBeDefined();
      expect(result.publicInputs.merkleRoot).toEqual(input.merkleRoot);
      expect(result.publicInputs.maxCost).toEqual(input.maxCost);
      expect(result.publicInputs.initialDeposit).toEqual(input.initialDeposit);
      expect(result.publicInputs.nullifier).toMatch(/^0x[0-9a-f]{64}$/);
      expect(result.publicInputs.signalY).toMatch(/^0x[0-9a-f]{64}$/);
      expect(result.publicInputs.idCommitment).toMatch(/^0x[0-9a-f]{64}$/);

      // Verify proof structure
      const proofData = JSON.parse(result.proof);
      expect(proofData.protocol).toBe('groth16');
      expect(proofData.pi_a).toHaveLength(2);
      expect(proofData.pi_b).toHaveLength(2);
      expect(proofData.pi_c).toHaveLength(2);
    });
  });

  describe('verifyMockProof', () => {
    it('should verify a valid mock proof', async () => {
      const input = {
        secretKey: BigInt(12345),
        ticketIndex: BigInt(1),
        signalX: BigInt(100),
        merkleRoot:
          '0x1234567890123456789012345678901234567890123456789012345678901234',
        maxCost: '1000000',
        initialDeposit: '5000000',
      };

      const { proof, publicInputs } = await service.generateMockProof(input);
      const isValid = service.verifyMockProof(proof, publicInputs);

      expect(isValid).toBe(true);
    }, 10000);

    it('should reject proof with invalid protocol', () => {
      const invalidProof = JSON.stringify({
        protocol: 'invalid',
        pi_a: ['0x00', '0x00'],
        pi_b: [
          ['0x00', '0x00'],
          ['0x00', '0x00'],
        ],
        pi_c: ['0x00', '0x00'],
      });

      const publicInputs = {
        merkleRoot: '0x00',
        maxCost: '0',
        initialDeposit: '0',
        signalX: '0x00',
        nullifier: '0x00',
        signalY: '0x00',
        idCommitment: '0x00',
      };

      const isValid = service.verifyMockProof(invalidProof, publicInputs);
      expect(isValid).toBe(false);
    });

    it('should reject proof with invalid structure', () => {
      const invalidProof = JSON.stringify({
        protocol: 'groth16',
        pi_a: ['0x00'], // Invalid length
        pi_b: [['0x00', '0x00']],
        pi_c: ['0x00', '0x00'],
      });

      const publicInputs = {
        merkleRoot: '0x00',
        maxCost: '0',
        initialDeposit: '0',
        signalX: '0x00',
        nullifier: '0x00',
        signalY: '0x00',
        idCommitment: '0x00',
      };

      const isValid = service.verifyMockProof(invalidProof, publicInputs);
      expect(isValid).toBe(false);
    });

    it('should reject proof with missing public inputs', () => {
      const proof = JSON.stringify({
        protocol: 'groth16',
        pi_a: ['0x00', '0x00'],
        pi_b: [
          ['0x00', '0x00'],
          ['0x00', '0x00'],
        ],
        pi_c: ['0x00', '0x00'],
      });

      const publicInputs = {
        merkleRoot: '0x00',
        maxCost: '0',
        initialDeposit: '0',
        signalX: '',
        nullifier: '0x00',
        signalY: '0x00',
        idCommitment: '0x00',
      };

      const isValid = service.verifyMockProof(proof, publicInputs);
      expect(isValid).toBe(false);
    });

    it('should reject malformed JSON proof', () => {
      const invalidProof = 'not valid json';
      const publicInputs = {
        merkleRoot: '0x00',
        maxCost: '0',
        initialDeposit: '0',
        signalX: '0x00',
        nullifier: '0x00',
        signalY: '0x00',
        idCommitment: '0x00',
      };

      const isValid = service.verifyMockProof(invalidProof, publicInputs);
      expect(isValid).toBe(false);
    });
  });
});
