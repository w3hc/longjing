import { createHash } from 'crypto';
import {
  BN254_SCALAR_FIELD,
  parseFieldElement,
  payloadToSignalX,
  signalXMatchesPayload,
} from './payload-signal.util';

describe('PayloadSignalUtil', () => {
  const payload = 'What does 苟全性命於亂世，不求聞達於諸侯。mean?';

  describe('payloadToSignalX', () => {
    it('should reduce the SHA-256 of the UTF-8 payload modulo the field', () => {
      const digest = createHash('sha256')
        .update(Buffer.from(payload, 'utf8'))
        .digest('hex');
      expect(payloadToSignalX(payload)).toBe(
        BigInt('0x' + digest) % BN254_SCALAR_FIELD,
      );
    });

    it('should stay inside the field', () => {
      expect(payloadToSignalX(payload)).toBeLessThan(BN254_SCALAR_FIELD);
    });

    it('should differ for different payloads', () => {
      expect(payloadToSignalX('a')).not.toBe(payloadToSignalX('b'));
    });
  });

  describe('parseFieldElement', () => {
    it('should parse 0x-prefixed hex, decimal and bare hex', () => {
      expect(parseFieldElement('0xff')).toBe(255n);
      expect(parseFieldElement('255')).toBe(255n);
      expect(parseFieldElement('ff')).toBe(255n);
    });
  });

  describe('signalXMatchesPayload', () => {
    const x = payloadToSignalX(payload);

    it('should accept x in any supported encoding', () => {
      expect(signalXMatchesPayload('0x' + x.toString(16), payload)).toBe(true);
      expect(signalXMatchesPayload(x.toString(), payload)).toBe(true);
    });

    it('should reject x computed for another payload', () => {
      expect(signalXMatchesPayload(x.toString(), payload + ' ')).toBe(false);
    });

    it('should reject a tampered x', () => {
      expect(signalXMatchesPayload((x + 1n).toString(), payload)).toBe(false);
    });

    it('should reject x not reduced modulo the field', () => {
      const unreduced = x + BN254_SCALAR_FIELD;
      expect(signalXMatchesPayload(unreduced.toString(), payload)).toBe(false);
    });

    it('should reject malformed input', () => {
      expect(signalXMatchesPayload('not-a-number', payload)).toBe(false);
    });
  });
});
