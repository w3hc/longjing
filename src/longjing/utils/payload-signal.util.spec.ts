/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { createHash } from 'crypto';
import { buildPoseidon } from 'circomlibjs';
import {
  BN254_SCALAR_FIELD,
  parseFieldElement,
  payloadDigest,
  payloadSignalX,
  signalXMatchesRequest,
} from './payload-signal.util';

describe('PayloadSignalUtil', () => {
  const payload = 'What does 苟全性命於亂世，不求聞達於諸侯。mean?';

  describe('payloadDigest', () => {
    it('should reduce the SHA-256 of the UTF-8 payload modulo the field', () => {
      const digest = createHash('sha256')
        .update(Buffer.from(payload, 'utf8'))
        .digest('hex');
      expect(payloadDigest(payload)).toBe(
        BigInt('0x' + digest) % BN254_SCALAR_FIELD,
      );
    });

    it('should stay inside the field', () => {
      expect(payloadDigest(payload)).toBeLessThan(BN254_SCALAR_FIELD);
    });

    it('should differ for different payloads', () => {
      expect(payloadDigest('a')).not.toBe(payloadDigest('b'));
    });
  });

  describe('payloadSignalX', () => {
    it('should be Poseidon of the digest and the nonce', async () => {
      const poseidon = await buildPoseidon();
      const expected = poseidon.F.toObject(
        poseidon([payloadDigest(payload), 7n]),
      );
      await expect(payloadSignalX(payload, 7n)).resolves.toBe(expected);
    });

    it('should hide the payload behind the nonce', async () => {
      expect(await payloadSignalX(payload, 1n)).not.toBe(
        await payloadSignalX(payload, 2n),
      );
    });
  });

  describe('signalXMatchesRequest', () => {
    const nonce = '0x2a';

    it('should accept x for the payload and nonce', async () => {
      const x = await payloadSignalX(payload, 42n);
      await expect(
        signalXMatchesRequest(x.toString(), payload, nonce),
      ).resolves.toBe(true);
    });

    it('should reject another payload or nonce', async () => {
      const x = (await payloadSignalX(payload, 42n)).toString();
      await expect(
        signalXMatchesRequest(x, payload + ' ', nonce),
      ).resolves.toBe(false);
      await expect(signalXMatchesRequest(x, payload, '43')).resolves.toBe(
        false,
      );
    });

    it('should reject x not reduced modulo the field', async () => {
      const x = (await payloadSignalX(payload, 42n)) + BN254_SCALAR_FIELD;
      await expect(
        signalXMatchesRequest(x.toString(), payload, nonce),
      ).resolves.toBe(false);
    });

    it('should reject a nonce outside the field', async () => {
      const rho = BN254_SCALAR_FIELD + 42n;
      const x = (await payloadSignalX(payload, 42n)).toString();
      await expect(
        signalXMatchesRequest(x, payload, rho.toString()),
      ).resolves.toBe(false);
    });

    it('should reject malformed input', async () => {
      await expect(
        signalXMatchesRequest('not-a-number', payload, nonce),
      ).resolves.toBe(false);
      await expect(signalXMatchesRequest('1', payload, 'zz')).resolves.toBe(
        false,
      );
    });
  });

  describe('parseFieldElement', () => {
    it('should parse 0x-prefixed hex, decimal and bare hex', () => {
      expect(parseFieldElement('0xff')).toBe(255n);
      expect(parseFieldElement('255')).toBe(255n);
      expect(parseFieldElement('ff')).toBe(255n);
    });
  });
});
