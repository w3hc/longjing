import { createHash } from 'crypto';
import { SigningKey, TypedDataEncoder, Wallet, ZeroHash } from 'ethers';
import {
  KEY_MANIFEST_DOMAIN,
  KEY_MANIFEST_TYPES,
  KeyManifest,
  SignedKeyManifest,
} from '../keys/key-derivation.service';
import { KeyBindingEvidence, verifyKeyBinding } from './key-binding';
import { buildReportData, encodeRefundSignerPublicKey } from './report-data';

const identity = new SigningKey('0x' + '42'.repeat(32));
const ek = Buffer.alloc(1568, 0x01);
const refundSigner = { x: '0x' + '03'.repeat(32), y: '0x' + '04'.repeat(32) };
const certificate = Buffer.from([0x30, 0x82, 0x01, 0x0a]);
const nonce = Buffer.alloc(32, 0x7f);

const sha256 = (bytes: Buffer) =>
  '0x' + createHash('sha256').update(bytes).digest('hex');

const signedManifest = (
  overrides: Partial<KeyManifest> = {},
  key = identity,
): SignedKeyManifest => {
  const manifest: KeyManifest = {
    appId: '0x1111111111111111111111111111111111111111',
    mlkemPublicKeyHash: sha256(ek),
    refundSignerX: refundSigner.x,
    refundSignerY: refundSigner.y,
    tlsCertificateHash: sha256(certificate),
    epoch: 1,
    ...overrides,
  };
  const digest = TypedDataEncoder.hash(
    KEY_MANIFEST_DOMAIN,
    KEY_MANIFEST_TYPES,
    manifest,
  );
  return { manifest, signature: key.sign(digest).serialized };
};

const tdxQuote = (reportData: Buffer) => {
  const quote = Buffer.alloc(1024);
  reportData.copy(quote, 568);
  return quote;
};

const evidence = (
  overrides: Partial<KeyBindingEvidence> = {},
): KeyBindingEvidence => {
  const reportData = buildReportData(
    {
      mlkemPublicKey: ek,
      identityPublicKey: Buffer.from(identity.publicKey.slice(2), 'hex'),
      refundSignerPublicKey: encodeRefundSignerPublicKey(refundSigner),
      tlsCertificateDer: certificate,
    },
    nonce,
  );
  return {
    platform: 'phala',
    quote: tdxQuote(reportData).toString('base64'),
    reportData: reportData.toString('hex'),
    keys: {
      mlkemPublicKey: ek.toString('base64'),
      identityPublicKey: identity.publicKey,
      refundSignerPublicKey: refundSigner,
      tlsCertificate: certificate.toString('base64'),
    },
    eventLog: '[]',
    ...overrides,
  };
};

describe('verifyKeyBinding', () => {
  it('accepts an attestation that binds its keys, nonce, quote and manifest', () => {
    expect(
      verifyKeyBinding(evidence(), {
        nonce,
        servedCertificate: certificate,
        keyManifest: signedManifest(),
      }),
    ).toEqual([]);
  });

  it('rejects a swapped refund signer', () => {
    const valid = evidence();
    const swapped = evidence({
      keys: {
        ...valid.keys,
        refundSignerPublicKey: { ...refundSigner, y: '0x05' },
      },
    });

    expect(
      verifyKeyBinding(swapped, { nonce, keyManifest: signedManifest() }),
    ).toEqual([
      'reportData does not commit to the returned keys and nonce',
      'The quote report_data does not match',
      'The key manifest commits to a different refund signer',
    ]);
  });

  it('rejects a replayed attestation for another nonce', () => {
    expect(
      verifyKeyBinding(evidence(), { nonce: Buffer.alloc(32, 0x01) }),
    ).toEqual([
      'reportData does not commit to the returned keys and nonce',
      'The quote report_data does not match',
    ]);
  });

  it('rejects a quote whose report_data differs', () => {
    const tampered = evidence({
      quote: tdxQuote(Buffer.alloc(64)).toString('base64'),
    });

    expect(verifyKeyBinding(tampered, { nonce })).toEqual([
      'The quote report_data does not match',
    ]);
  });

  it('rejects an event log that does not replay to the quote', () => {
    const event = {
      imr: 0,
      event_type: 1,
      digest: '11'.repeat(48),
      event: '',
      event_payload: '',
    };

    expect(
      verifyKeyBinding(evidence({ eventLog: JSON.stringify([event]) }), {
        nonce,
      }),
    ).toEqual(['RTMR0 does not match the event log']);
  });

  it('rejects a TLS session certificate other than the bound one', () => {
    expect(
      verifyKeyBinding(evidence(), {
        nonce,
        servedCertificate: Buffer.from([0x30, 0x00]),
      }),
    ).toEqual([
      'The TLS session certificate is not the one bound by the attestation',
    ]);
  });

  it('rejects TLS terminating outside the enclave', () => {
    const valid = evidence();
    const withoutTls = {
      ...valid.keys,
      tlsCertificate: null,
    };

    expect(
      verifyKeyBinding(evidence({ keys: withoutTls }), {
        servedCertificate: certificate,
      }),
    ).toContain(
      'The attestation binds no TLS certificate: TLS terminates outside the enclave',
    );
  });

  it('rejects a manifest for another TLS certificate', () => {
    expect(
      verifyKeyBinding(evidence(), {
        nonce,
        keyManifest: signedManifest({ tlsCertificateHash: ZeroHash }),
      }),
    ).toEqual(['The key manifest commits to a different TLS certificate']);
  });

  it('rejects a manifest signed by another key', () => {
    const other = new SigningKey(Wallet.createRandom().privateKey);

    expect(
      verifyKeyBinding(evidence(), {
        nonce,
        keyManifest: signedManifest({}, other),
      }),
    ).toEqual(['The key manifest is not signed by the identity key']);
  });
});
