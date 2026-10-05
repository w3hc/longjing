import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { ProofGenService } from '../src/longjing/proof-gen.service';
import { RefundSignerService } from '../src/longjing/refund-signer.service';

// Type definitions for API responses
interface ProofMetadata {
  idCommitment: string;
  nullifier: string;
  timestamp: number;
  secretKey?: string;
}

interface ProofResponse {
  proof: string[];
  publicSignals: string[];
  metadata: ProofMetadata;
}

describe('Proof Generation Integration (e2e)', () => {
  let app: INestApplication<App>;
  let proofGenService: ProofGenService;
  let refundSignerService: RefundSignerService;

  // Test parameters
  const secretKey = BigInt('12345678901234567890');
  const ticketIndex = BigInt(1);
  const signalX = BigInt('999888777666555444');

  // Helper to suppress expected error logs from NestJS
  const suppressErrorLogs = (callback: () => Promise<void>) => {
    return async () => {
      // Disable NestJS logger temporarily
      app.useLogger(false);
      try {
        await callback();
      } finally {
        // Re-enable logger
        app.useLogger(['error', 'warn', 'log']);
      }
    };
  };

  // Proves on the client side, as a user would: the secret key never reaches the API
  const proveWithdrawal = async (key: bigint): Promise<ProofResponse> => {
    const { proof, publicSignals } =
      await proofGenService.generateWithdrawalProof({
        secretKey: key,
        ticketIndex,
        signalX,
      });
    const idCommitment = await proofGenService.generateIdCommitment(key);
    const { nullifier } = await proofGenService.generateRLNSignal(
      key,
      ticketIndex,
      signalX,
    );
    return {
      proof: proof.map((p) => '0x' + BigInt(p).toString(16)),
      publicSignals: publicSignals.map((x) => '0x' + BigInt(x).toString(16)),
      metadata: {
        idCommitment: '0x' + idCommitment.toString(16),
        nullifier: '0x' + nullifier.toString(16),
        timestamp: Date.now(),
      },
    };
  };

  beforeAll(async () => {
    // Set test environment variables
    process.env.NODE_ENV = 'test';
    process.env.PROFILE = 'local';
    process.env.KMS_URL = 'http://localhost:3001';
    process.env.DATA_DIR = ':memory:';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe());
    await app.init();

    // Get services for direct testing
    proofGenService = moduleFixture.get<ProofGenService>(ProofGenService);
    refundSignerService =
      moduleFixture.get<RefundSignerService>(RefundSignerService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Withdrawal Proof Generation (e2e)', () => {
    it('should not expose a withdrawal proving endpoint', async () => {
      await request(app.getHttpServer())
        .post('/longjing/proofs/withdrawal')
        .send({
          secretKey: `0x${secretKey.toString(16)}`,
          ticketIndex: `0x${ticketIndex.toString(16)}`,
          signalX: `0x${signalX.toString(16)}`,
        })
        .expect(404);
    });

    it('should generate valid proof using ProofGenService directly', async () => {
      const { proof, publicSignals } =
        await proofGenService.generateWithdrawalProof({
          secretKey,
          ticketIndex,
          signalX,
        });

      // Verify proof structure
      expect(Array.isArray(proof)).toBe(true);
      expect(proof).toHaveLength(8);

      // Verify public signals structure
      expect(Array.isArray(publicSignals)).toBe(true);
      expect(publicSignals).toHaveLength(5);

      // Verify all elements can be converted to bigint (proof comes as strings from snarkjs)
      proof.forEach((element) => {
        expect(() => BigInt(element)).not.toThrow();
      });

      publicSignals.forEach((signal) => {
        expect(() => BigInt(signal)).not.toThrow();
      });
    });
  });

  describe('Refund Redemption Proof Generation (e2e)', () => {
    it('should not expose a refund proving endpoint', async () => {
      await request(app.getHttpServer())
        .post('/longjing/proofs/refund')
        .send({
          secretKey: `0x${secretKey.toString(16)}`,
          ticketIndex: `0x${ticketIndex.toString(16)}`,
          signalX: `0x${signalX.toString(16)}`,
          recipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        })
        .expect(404);
    });

    it('should generate valid refund proof using ProofGenService directly', async () => {
      // Generate identity commitment and nullifier
      const idCommitment =
        await proofGenService.generateIdCommitment(secretKey);
      const { nullifier } = await proofGenService.generateRLNSignal(
        secretKey,
        ticketIndex,
        signalX,
      );

      // Generate mock refund ticket
      const refundValue = BigInt(1000000);
      const refundTimestamp = Math.floor(Date.now() / 1000);

      const refundTicket = await refundSignerService.signRefund({
        idCommitment: '0x' + idCommitment.toString(16),
        nullifier: '0x' + nullifier.toString(16),
        value: refundValue.toString(),
        timestamp: refundTimestamp,
      });

      const serverPublicKey = await refundSignerService.getPublicKey();
      const recipient = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'; // Test recipient

      // Generate proof with proper parameters
      const { proof, publicSignals } =
        await proofGenService.generateRefundRedemptionProof({
          secretKey,
          ticketIndex,
          signalX,
          refundValue,
          refundTimestamp,
          refundSignature: refundTicket.signature,
          serverPublicKey,
          recipient, // include recipient
        });

      // Verify proof structure
      expect(Array.isArray(proof)).toBe(true);
      expect(proof).toHaveLength(8);

      // Verify public signals structure - refund_redemption.circom has 8 public signals (front-running protection fix)
      expect(Array.isArray(publicSignals)).toBe(true);
      expect(publicSignals).toHaveLength(8);
      expect(publicSignals.length).toBeGreaterThan(0);
    });
  });

  describe('Double-Spend Slashing Proof Generation (e2e)', () => {
    it('should generate slashing proof via API endpoint', async () => {
      // Generate two different signals with the same nullifier (simulating double-spend)
      const signalX1 = BigInt('111111111111111111');
      const signalX2 = BigInt('222222222222222222');

      const { signalY: signalY1 } = await proofGenService.generateRLNSignal(
        secretKey,
        ticketIndex,
        signalX1,
      );
      const { signalY: signalY2 } = await proofGenService.generateRLNSignal(
        secretKey,
        ticketIndex,
        signalX2,
      );

      const response = await request(app.getHttpServer())
        .post('/longjing/proofs/slashing')
        .send({
          secretKey: `0x${secretKey.toString(16)}`,
          ticketIndex: `0x${ticketIndex.toString(16)}`,
          signal1: {
            x: `0x${signalX1.toString(16)}`,
            y: `0x${signalY1.toString(16)}`,
          },
          signal2: {
            x: `0x${signalX2.toString(16)}`,
            y: `0x${signalY2.toString(16)}`,
          },
        })
        .expect(200);

      const body = response.body as ProofResponse;

      // Verify response structure
      expect(body).toHaveProperty('proof');
      expect(body).toHaveProperty('publicSignals');
      expect(body).toHaveProperty('metadata');

      // Verify metadata includes revealed secretKey for slashing
      expect(body.metadata).toHaveProperty('secretKey');
      expect(body.metadata.secretKey).toMatch(/^0x[0-9a-f]+$/i);
      expect(body.metadata).toHaveProperty('nullifier');
    });

    it(
      'should reject invalid signal pairs (same x values)',
      suppressErrorLogs(async () => {
        const signalX1 = BigInt('111111111111111111');

        const { signalY: signalY1 } = await proofGenService.generateRLNSignal(
          secretKey,
          ticketIndex,
          signalX1,
        );
        const { signalY: signalY2 } = await proofGenService.generateRLNSignal(
          secretKey,
          ticketIndex,
          signalX1, // Same x value - should fail
        );

        await request(app.getHttpServer())
          .post('/longjing/proofs/slashing')
          .send({
            secretKey: `0x${secretKey.toString(16)}`,
            ticketIndex: `0x${ticketIndex.toString(16)}`,
            signal1: {
              x: `0x${signalX1.toString(16)}`,
              y: `0x${signalY1.toString(16)}`,
            },
            signal2: {
              x: `0x${signalX1.toString(16)}`, // Same x
              y: `0x${signalY2.toString(16)}`,
            },
          })
          .expect(500); // Should fail in proof generation
      }),
    );

    it('should verify secret key recovery from two signals', async () => {
      const signalX1 = BigInt('333333333333333333');
      const signalX2 = BigInt('444444444444444444');

      const { signalY: signalY1 } = await proofGenService.generateRLNSignal(
        secretKey,
        ticketIndex,
        signalX1,
      );
      const { signalY: signalY2 } = await proofGenService.generateRLNSignal(
        secretKey,
        ticketIndex,
        signalX2,
      );

      // Recover secret key
      const recoveredKey = await proofGenService.recoverSecretKey(
        { x: signalX1, y: signalY1 },
        { x: signalX2, y: signalY2 },
      );

      // Verify recovery is correct
      expect(recoveredKey).toBe(secretKey);
    });

    it('should generate valid slashing proof using ProofGenService directly', async () => {
      const signalX1 = BigInt('555555555555555555');
      const signalX2 = BigInt('666666666666666666');

      const { signalY: signalY1 } = await proofGenService.generateRLNSignal(
        secretKey,
        ticketIndex,
        signalX1,
      );
      const { signalY: signalY2 } = await proofGenService.generateRLNSignal(
        secretKey,
        ticketIndex,
        signalX2,
      );

      const { proof, publicSignals } =
        await proofGenService.generateDoubleSpendProof({
          secretKey,
          ticketIndex,
          signal1: { x: signalX1, y: signalY1 },
          signal2: { x: signalX2, y: signalY2 },
        });

      // Verify proof structure
      expect(Array.isArray(proof)).toBe(true);
      expect(proof).toHaveLength(8);

      // Verify public signals structure
      expect(Array.isArray(publicSignals)).toBe(true);
      expect(publicSignals).toHaveLength(5);
    });
  });

  describe('Proof Format Compatibility (e2e)', () => {
    it('should format proofs compatible with Solidity contract', async () => {
      const body = await proveWithdrawal(secretKey);
      const { proof, publicSignals } = body;

      // Verify proof can be converted to uint[8] format for Solidity
      const solidityProof = proof.map((p: string) => BigInt(p));
      expect(solidityProof).toHaveLength(8);

      // Verify publicSignals can be converted to uint[5] format for Solidity
      const solidityPublicSignals = publicSignals.map((s: string) => BigInt(s));
      expect(solidityPublicSignals).toHaveLength(5);

      // All values should be valid field elements (< BN254 prime)
      const BN254_PRIME = BigInt(
        '21888242871839275222246405745257275088548364400416034343698204186575808495617',
      );

      solidityProof.forEach((element: bigint) => {
        expect(element).toBeLessThan(BN254_PRIME);
        expect(element).toBeGreaterThanOrEqual(0n);
      });

      solidityPublicSignals.forEach((signal: bigint) => {
        expect(signal).toBeLessThan(BN254_PRIME);
        expect(signal).toBeGreaterThanOrEqual(0n);
      });
    });

    it('should maintain Groth16 proof structure', async () => {
      const body = await proveWithdrawal(secretKey);
      const { proof } = body;

      // Groth16 proof structure: [pA[0], pA[1], pB[0][1], pB[0][0], pB[1][1], pB[1][0], pC[0], pC[1]]
      // Verify we have exactly 8 elements
      expect(proof).toHaveLength(8);

      // All proof elements should be non-zero hex strings
      proof.forEach((element: string) => {
        expect(element).toMatch(/^0x[0-9a-f]+$/i);
        expect(element).not.toBe('0x0');
        expect(element).not.toBe('0x00');
      });
    });
  });

  describe('Performance (e2e)', () => {
    it('should generate withdrawal proof within reasonable time', async () => {
      const start = Date.now();

      await proveWithdrawal(secretKey);

      const duration = Date.now() - start;

      // Proof generation should complete in less than 5 seconds
      expect(duration).toBeLessThan(5000);
    });

    it('should handle concurrent proof generation', async () => {
      const bodies = await Promise.all(
        Array.from({ length: 3 }, (_, i) =>
          proveWithdrawal(secretKey + BigInt(i)),
        ),
      );

      bodies.forEach((body) => {
        expect(body).toHaveProperty('proof');
        expect(body).toHaveProperty('publicSignals');
      });

      // Each should have unique idCommitment
      const commitments = bodies.map((b) => b.metadata.idCommitment);
      const uniqueCommitments = new Set(commitments);
      expect(uniqueCommitments.size).toBe(3);
    });
  });

  describe('RLN Primitives (e2e)', () => {
    it('should generate consistent identity commitments', async () => {
      const idCommitment1 =
        await proofGenService.generateIdCommitment(secretKey);
      const idCommitment2 =
        await proofGenService.generateIdCommitment(secretKey);

      // Same input should produce same commitment
      expect(idCommitment1).toBe(idCommitment2);
    });

    it('should generate different identity commitments for different keys', async () => {
      const secretKey2 = BigInt('98765432109876543210');

      const idCommitment1 =
        await proofGenService.generateIdCommitment(secretKey);
      const idCommitment2 =
        await proofGenService.generateIdCommitment(secretKey2);

      // Different keys should produce different commitments
      expect(idCommitment1).not.toBe(idCommitment2);
    });

    it('should generate consistent nullifiers for same inputs', async () => {
      const { nullifier: nullifier1 } = await proofGenService.generateRLNSignal(
        secretKey,
        ticketIndex,
        signalX,
      );
      const { nullifier: nullifier2 } = await proofGenService.generateRLNSignal(
        secretKey,
        ticketIndex,
        signalX,
      );

      // Same inputs should produce same nullifier
      expect(nullifier1).toBe(nullifier2);
    });

    it('should generate different nullifiers for different ticket indices', async () => {
      const ticketIndex2 = BigInt(2);

      const { nullifier: nullifier1 } = await proofGenService.generateRLNSignal(
        secretKey,
        ticketIndex,
        signalX,
      );
      const { nullifier: nullifier2 } = await proofGenService.generateRLNSignal(
        secretKey,
        ticketIndex2,
        signalX,
      );

      // Different ticket indices should produce different nullifiers
      expect(nullifier1).not.toBe(nullifier2);
    });
  });
});
