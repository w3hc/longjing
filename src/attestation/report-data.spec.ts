import {
  buildReportData,
  encodeRefundSignerPublicKey,
  parseNonce,
} from './report-data';

// Vectors computed independently in Python with hashlib and struct.pack('>I')
const IDENTITY = new Uint8Array([0x04, ...new Uint8Array(64).fill(0x02)]);
const REFUND_SIGNER = { x: '0x05', y: '0x' + '03'.repeat(32) };
const CERT = Buffer.from('cert');
const ONION = new Uint8Array(32).fill(0x06);

describe('buildReportData', () => {
  it('commits to empty terms with a zero nonce', () => {
    const reportData = buildReportData({});

    expect(reportData).toHaveLength(64);
    expect(reportData.subarray(0, 32).toString('hex')).toBe(
      '8d54af7daf4235f2d9c6e661fa1287edb51a4e339171a319d97c7636f79b94df',
    );
    expect(reportData.subarray(32).equals(Buffer.alloc(32))).toBe(true);
  });

  it('commits to every key and the certificate hash', () => {
    const reportData = buildReportData({
      identityPublicKey: IDENTITY,
      refundSignerPublicKey: encodeRefundSignerPublicKey(REFUND_SIGNER),
      tlsCertificateDer: CERT,
      onionPublicKey: ONION,
    });

    expect(reportData.subarray(0, 32).toString('hex')).toBe(
      'e5fa441eb0ce07753011262eb97c4b5eba30a1c1f2b4730e747c5d606cabeec8',
    );
  });

  it('places the nonce in the second half', () => {
    const nonce = Buffer.alloc(32, 0x7f);

    const reportData = buildReportData({}, nonce);

    expect(reportData.subarray(32).equals(nonce)).toBe(true);
  });

  it('changes the commitment when the refund signer changes', () => {
    const commitment = (y: string) =>
      buildReportData({
        refundSignerPublicKey: encodeRefundSignerPublicKey({ x: '0x05', y }),
      }).subarray(0, 32);

    expect(commitment('0x01').equals(commitment('0x02'))).toBe(false);
  });

  it('changes the commitment when the onion service key changes', () => {
    const commitment = (fill: number) =>
      buildReportData({
        onionPublicKey: new Uint8Array(32).fill(fill),
      }).subarray(0, 32);

    expect(commitment(1).equals(commitment(2))).toBe(false);
  });

  it('rejects a nonce that is not 32 bytes', () => {
    expect(() => buildReportData({}, Buffer.alloc(16))).toThrow(
      'Nonce must be 32 bytes',
    );
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
