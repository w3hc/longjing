import { createHash } from 'crypto';
import { computeAddress, getAddress, verifyTypedData } from 'ethers';
import {
  KEY_MANIFEST_DOMAIN,
  KEY_MANIFEST_TYPES,
  SignedKeyManifest,
} from '../keys/key-derivation.service';
import { BoundKeys } from './attestation.types';
import { tdxQuoteReportData } from './platforms/phala.platform';
import { buildReportData, encodeRefundSignerPublicKey } from './report-data';
import { verifyEventLog } from './tdx-quote';

/** The fields of `GET /attestation` that bind the keys. */
export interface KeyBindingEvidence {
  platform: string;
  /** Base64 quote */
  quote: string;
  /** Hex report_data */
  reportData: string;
  keys: BoundKeys;
  eventLog?: string;
}

/**
 * Checks that an attestation commits to the keys it returns, as described in
 * docs/ATTESTATION.md#verification. It does not verify the quote signature,
 * the measurements against published values or the GetKey signature chains.
 * @param evidence The `GET /attestation` response
 * @param options.nonce The nonce the client sent, if any
 * @param options.servedCertificate DER of the certificate the TLS session
 * presented, to check TLS terminates inside the enclave
 * @param options.keyManifest The `GET /attestation/manifest` response, to
 * check it signs the same keys
 * @returns The failed checks, empty when the binding holds
 */
export function verifyKeyBinding(
  evidence: KeyBindingEvidence,
  options: {
    nonce?: Buffer;
    servedCertificate?: Buffer;
    keyManifest?: SignedKeyManifest;
  } = {},
): string[] {
  const failures: string[] = [];
  const { keys } = evidence;
  const ek = Buffer.from(keys.mlkemPublicKey, 'base64');
  const identity = keys.identityPublicKey
    ? Buffer.from(strip0x(keys.identityPublicKey), 'hex')
    : undefined;
  const tlsCertificate = keys.tlsCertificate
    ? Buffer.from(keys.tlsCertificate, 'base64')
    : undefined;

  const expected = buildReportData(
    {
      mlkemPublicKey: ek,
      identityPublicKey: identity,
      refundSignerPublicKey: keys.refundSignerPublicKey
        ? encodeRefundSignerPublicKey(keys.refundSignerPublicKey)
        : undefined,
      tlsCertificateDer: tlsCertificate,
    },
    options.nonce,
  );
  if (!Buffer.from(strip0x(evidence.reportData), 'hex').equals(expected)) {
    failures.push('reportData does not commit to the returned keys and nonce');
  }

  if (options.servedCertificate) {
    if (!tlsCertificate) {
      failures.push(
        'The attestation binds no TLS certificate: TLS terminates outside the enclave',
      );
    } else if (!options.servedCertificate.equals(tlsCertificate)) {
      failures.push(
        'The TLS session certificate is not the one bound by the attestation',
      );
    }
  }

  if (evidence.platform === 'phala' || evidence.platform === 'intel-tdx') {
    const quote = Buffer.from(evidence.quote, 'base64');
    try {
      if (!tdxQuoteReportData(quote).equals(expected)) {
        failures.push('The quote report_data does not match');
      }
    } catch (error) {
      failures.push((error as Error).message);
    }
    if (evidence.eventLog !== undefined) {
      failures.push(...verifyEventLog(quote, evidence.eventLog));
    }
  }

  if (options.keyManifest) {
    failures.push(
      ...verifyManifest(
        options.keyManifest,
        ek,
        keys,
        identity,
        tlsCertificate,
      ),
    );
  }

  return failures;
}

function verifyManifest(
  { manifest, signature }: SignedKeyManifest,
  ek: Buffer,
  keys: BoundKeys,
  identity: Buffer | undefined,
  tlsCertificate: Buffer | undefined,
): string[] {
  const failures: string[] = [];
  if (manifest.mlkemPublicKeyHash.toLowerCase() !== sha256Hex(ek)) {
    failures.push('The key manifest commits to a different ML-KEM key');
  }
  const refundSigner = keys.refundSignerPublicKey;
  if (
    !refundSigner ||
    BigInt(manifest.refundSignerX) !== BigInt(refundSigner.x) ||
    BigInt(manifest.refundSignerY) !== BigInt(refundSigner.y)
  ) {
    failures.push('The key manifest commits to a different refund signer');
  }
  const tlsCertificateHash = tlsCertificate
    ? sha256Hex(tlsCertificate)
    : '0x' + '00'.repeat(32);
  if (manifest.tlsCertificateHash.toLowerCase() !== tlsCertificateHash) {
    failures.push('The key manifest commits to a different TLS certificate');
  }
  if (!identity) {
    failures.push('The attestation binds no identity key');
    return failures;
  }
  try {
    const signer = verifyTypedData(
      KEY_MANIFEST_DOMAIN,
      KEY_MANIFEST_TYPES,
      manifest,
      signature,
    );
    if (
      getAddress(signer) !== computeAddress(`0x${identity.toString('hex')}`)
    ) {
      failures.push('The key manifest is not signed by the identity key');
    }
  } catch {
    failures.push('The key manifest signature is invalid');
  }
  return failures;
}

function sha256Hex(bytes: Buffer): string {
  return `0x${createHash('sha256').update(bytes).digest('hex')}`;
}

function strip0x(value: string): string {
  return value.startsWith('0x') ? value.slice(2) : value;
}
