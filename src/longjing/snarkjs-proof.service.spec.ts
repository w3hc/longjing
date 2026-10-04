/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-require-imports */

import { Test, TestingModule } from '@nestjs/testing';
import { SnarkjsProofService } from './snarkjs-proof.service';
import * as fs from 'fs';

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

describe('SnarkjsProofService', () => {
  let service: SnarkjsProofService;
  let loggerErrorSpy: jest.SpyInstance;
  const snarkjs = require('snarkjs');

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [SnarkjsProofService],
    }).compile();

    service = module.get<SnarkjsProofService>(SnarkjsProofService);

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

  describe('initialize', () => {
    it('should return false when WASM file does not exist', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      const result = await service.initialize();

      expect(result).toBe(false);
      expect(service.isAvailable()).toBe(false);
    });

    it('should return false when zkey file does not exist', async () => {
      (fs.existsSync as jest.Mock).mockImplementation((path: string) => {
        return path.includes('.wasm');
      });

      const result = await service.initialize();

      expect(result).toBe(false);
      expect(service.isAvailable()).toBe(false);
    });

    it('should return false when verification key does not exist', async () => {
      (fs.existsSync as jest.Mock).mockImplementation((path: string) => {
        return path.includes('.wasm') || path.includes('.zkey');
      });

      const result = await service.initialize();

      expect(result).toBe(false);
      expect(service.isAvailable()).toBe(false);
    });

    it('should initialize successfully when all files exist', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(
        '{"vk_delta_2": [["12345", "67890"], ["11111", "22222"], ["1", "0"]]}',
      );

      const result = await service.initialize();

      expect(result).toBe(true);
      expect(service.isAvailable()).toBe(true);
    });

    it('should return true if already initialized', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(
        '{"vk_delta_2": [["12345", "67890"], ["11111", "22222"], ["1", "0"]]}',
      );

      await service.initialize();
      const result = await service.initialize();

      expect(result).toBe(true);
    });

    it('should handle errors during initialization', async () => {
      (fs.existsSync as jest.Mock).mockImplementation(() => {
        throw new Error('File system error');
      });

      const result = await service.initialize();

      expect(result).toBe(false);
      expect(service.isAvailable()).toBe(false);
    });
  });

  describe('generateProof', () => {
    const mockInput = {
      secretKey: '12345',
      ticketIndex: '1',
      signalX: '100',
      idCommitmentExpected: '0x1234',
    };

    beforeEach(() => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(
        '{"vk_delta_2": [["12345", "67890"], ["11111", "22222"], ["1", "0"]]}',
      );
    });

    it('should generate proof when initialized', async () => {
      const mockProof = { pi_a: ['0x1', '0x2'] };
      const mockPublicSignals = ['signal1', 'signal2'];

      snarkjs.groth16.fullProve.mockResolvedValue({
        proof: mockProof,
        publicSignals: mockPublicSignals,
      });

      await service.initialize();
      const result = await service.generateProof(mockInput);

      expect(result.proof).toEqual(mockProof);
      expect(result.publicSignals).toEqual(mockPublicSignals);
      expect(snarkjs.groth16.fullProve).toHaveBeenCalled();
    });

    it('should initialize if not already initialized before generating proof', async () => {
      const mockProof = { pi_a: ['0x1', '0x2'] };
      const mockPublicSignals = ['signal1'];

      snarkjs.groth16.fullProve.mockResolvedValue({
        proof: mockProof,
        publicSignals: mockPublicSignals,
      });

      const result = await service.generateProof(mockInput);

      expect(result.proof).toEqual(mockProof);
      expect(service.isAvailable()).toBe(true);
    });

    it('should throw error if circuit artifacts are missing', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      await expect(service.generateProof(mockInput)).rejects.toThrow(
        'Proof system not initialized. Circuit artifacts missing.',
      );
    });

    it('should handle errors during proof generation', async () => {
      await service.initialize();
      snarkjs.groth16.fullProve.mockRejectedValue(new Error('Proof error'));

      await expect(service.generateProof(mockInput)).rejects.toThrow(
        'Proof error',
      );
    });
  });

  describe('verifyProof', () => {
    // Use proper Groth16 proof format with projective coordinates [x, y, z]
    const mockProof = {
      pi_a: ['1', '2', '1'],
      pi_b: [
        ['3', '4', '1'],
        ['5', '6', '1'],
      ],
      pi_c: ['7', '8', '1'],
      protocol: 'groth16',
    };
    const mockPublicSignals = ['signal1', 'signal2'];

    beforeEach(() => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(
        '{"vk_delta_2": [["12345", "67890"], ["11111", "22222"], ["1", "0"]]}',
      );
    });

    it('should verify proof successfully', async () => {
      snarkjs.groth16.verify.mockResolvedValue(true);

      await service.initialize();
      const result = await service.verifyProof(mockProof, mockPublicSignals);

      expect(result).toBe(true);
      expect(snarkjs.groth16.verify).toHaveBeenCalled();
    });

    it('should return false for invalid proof', async () => {
      snarkjs.groth16.verify.mockResolvedValue(false);

      await service.initialize();
      const result = await service.verifyProof(mockProof, mockPublicSignals);

      expect(result).toBe(false);
    });

    it('should initialize if not already initialized before verifying', async () => {
      snarkjs.groth16.verify.mockResolvedValue(true);

      const result = await service.verifyProof(mockProof, mockPublicSignals);

      expect(result).toBe(true);
      expect(service.isAvailable()).toBe(true);
    });

    it('should return false if initialization fails', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      const result = await service.verifyProof(mockProof, mockPublicSignals);

      expect(result).toBe(false);
    });

    it('should handle errors during verification', async () => {
      await service.initialize();
      snarkjs.groth16.verify.mockRejectedValue(new Error('Verify error'));

      const result = await service.verifyProof(mockProof, mockPublicSignals);

      expect(result).toBe(false);
    });
  });

  describe('exportProof', () => {
    it('should export proof to JSON string', () => {
      const proof = { pi_a: ['0x1', '0x2'] };
      const result = service.exportProof(proof);

      expect(result).toBe(JSON.stringify(proof));
    });
  });

  describe('importProof', () => {
    it('should import proof from JSON string', () => {
      const proof = { pi_a: ['0x1', '0x2'] };
      const proofJson = JSON.stringify(proof);
      const result = service.importProof(proofJson);

      expect(result).toEqual(proof);
    });
  });

  describe('getCircuitInfo', () => {
    it('should return circuit information', () => {
      const info = service.getCircuitInfo();

      expect(info).toHaveProperty('wasmPath');
      expect(info).toHaveProperty('zkeyPath');
      expect(info).toHaveProperty('isSetup');
      expect(typeof info.isSetup).toBe('boolean');
    });
  });

  describe('isAvailable', () => {
    it('should return false when not initialized', () => {
      expect(service.isAvailable()).toBe(false);
    });

    it('should return true after successful initialization', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(
        '{"vk_delta_2": [["12345", "67890"], ["11111", "22222"], ["1", "0"]]}',
      );

      await service.initialize();

      expect(service.isAvailable()).toBe(true);
    });
  });
});
