import {
  buildReportData,
  encodeRefundSignerPublicKey,
  parseNonce,
} from './report-data';

// Vectors computed independently in Python with hashlib and struct.pack('>I')
const EK = new Uint8Array(1568).fill(0x01);
const IDENTITY = new Uint8Array([0x04, ...new Uint8Array(64).fill(0x02)]);
const REFUND_SIGNER = { x: '0x05', y: '0x' + '03'.repeat(32) };
const CERT = Buffer.from('cert');

describe('buildReportData', () => {
  it('commits to the ML-KEM key alone, with empty terms and a zero nonce', () => {
    const reportData = buildReportData({ mlkemPublicKey: EK });

    expect(reportData).toHaveLength(64);
    expect(reportData.subarray(0, 32).toString('hex')).toBe(
      'd4df96ff643aac9d41a4b779808045fad242a3246702b7dfa697a2dca9163769',
    );
    expect(reportData.subarray(32).equals(Buffer.alloc(32))).toBe(true);
  });

  it('commits to every key and the certificate hash', () => {
    const reportData = buildReportData({
      mlkemPublicKey: EK,
      identityPublicKey: IDENTITY,
      refundSignerPublicKey: encodeRefundSignerPublicKey(REFUND_SIGNER),
      tlsCertificateDer: CERT,
    });

    expect(reportData.subarray(0, 32).toString('hex')).toBe(
      '99493ed50cae56e7b02e675dcc074a3349098238d034cad1830bc2ac7b2c685c',
    );
  });

  it('places the nonce in the second half', () => {
    const nonce = Buffer.alloc(32, 0x7f);

    const reportData = buildReportData({ mlkemPublicKey: EK }, nonce);

    expect(reportData.subarray(32).equals(nonce)).toBe(true);
  });

  it('changes the commitment when the refund signer changes', () => {
    const commitment = (y: string) =>
      buildReportData({
        mlkemPublicKey: EK,
        refundSignerPublicKey: encodeRefundSignerPublicKey({ x: '0x05', y }),
      }).subarray(0, 32);

    expect(commitment('0x01').equals(commitment('0x02'))).toBe(false);
  });

  it('rejects a nonce that is not 32 bytes', () => {
    expect(() =>
      buildReportData({ mlkemPublicKey: EK }, Buffer.alloc(16)),
    ).toThrow('Nonce must be 32 bytes');
  });
});

describe('encodeRefundSignerPublicKey', () => {
  it('left-pads each coordinate to 32 bytes', () => {
    const encoded = encodeRefundSignerPublicKey(REFUND_SIGNER);

    expect(encoded).toHaveLength(64);
    expect(encoded[31]).toBe(0x05);
    expect(encoded.subarray(32).equals(Buffer.alloc(32, 0x03))).toBe(true);
  });

  it('rejects a coordinate longer than 32 bytes', () => {
    expect(() =>
      encodeRefundSignerPublicKey({ x: '0x' + '01'.repeat(33), y: '0x01' }),
    ).toThrow('at most 32 bytes');
  });
});

describe('parseNonce', () => {
  const hex = '11'.repeat(32);

  it('returns undefined when no nonce is sent', () => {
    expect(parseNonce(undefined)).toBeUndefined();
    expect(parseNonce('')).toBeUndefined();
  });

  it('parses 64 hex characters, with or without 0x', () => {
    expect(parseNonce(hex)).toEqual(Buffer.alloc(32, 0x11));
    expect(parseNonce(`0x${hex}`)).toEqual(Buffer.alloc(32, 0x11));
  });

  it.each(['11'.repeat(31), '11'.repeat(33), 'zz'.repeat(32)])(
    'rejects %s',
    (value) => {
      expect(() => parseNonce(value)).toThrow('Nonce must be 32 bytes of hex');
    },
  );
});
