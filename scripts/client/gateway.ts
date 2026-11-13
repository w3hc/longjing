/**
 * The client's way to the gateway: it verifies the attestation, with a fresh
 * nonce, before its first request, and sends nothing when the quote, the
 * nonce or a bound key doesn't match. The only way to get a `post` is
 * through `openGateway`.
 *
 * The transport is the only Node-specific part: see transport.ts for Node,
 * and docs/INTEGRATION_GUIDELINES.md for a browser.
 */

import { BoundAttestation } from '../../src/attestation/attestation.types';
import { verifyKeyBinding } from '../../src/attestation/key-binding';
import type { SignedKeyManifest } from '../../src/keys/key-derivation.service';

export interface GatewayRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: string;
  /** DER the TLS certificate must equal before anything is written */
  pinnedCertificate?: Uint8Array;
}

export interface GatewayResponse {
  status: number;
  body: string;
  /** DER of the certificate the TLS session presented, null over HTTP */
  certificate: Uint8Array | null;
  /** The TLS key exchange group, when the transport can tell */
  keyExchange?: string;
}

export interface GatewayTransport {
  /** The host the client connects to, to check a .onion host */
  readonly host: string;
  /** Whether the transport is TLS */
  readonly secure: boolean;
  request(request: GatewayRequest): Promise<GatewayResponse>;
}

export interface Gateway {
  attestation: BoundAttestation;
  /** POSTs JSON to the attested gateway, over a pinned TLS session */
  post(path: string, body: unknown): Promise<{ status: number; json: any }>;
}

export interface CheckOptions {
  /** The nonce the client sent */
  nonce: Uint8Array;
  /** DER of the certificate of the session that returned the attestation */
  servedCertificate?: Uint8Array | null;
  keyManifest?: SignedKeyManifest;
  host?: string;
  /**
   * Accepts the mock platform, plain HTTP and a missing key manifest: a
   * local gateway with NODE_ENV=development, never a deployment
   */
  development?: boolean;
}

export class AttestationRefused extends Error {
  constructor(readonly failures: string[]) {
    super(`Attestation refused, nothing sent: ${failures.join('; ')}`);
    this.name = 'AttestationRefused';
  }
}

/**
 * Every check the client runs on `GET /attestation` before it sends
 * anything. It doesn't verify the quote signature or compare the
 * measurements with a release (docs/ATTESTATION.md#verification).
 * @returns The failed checks, empty when the gateway can be trusted
 */
export function checkAttestation(
  attestation: BoundAttestation,
  options: CheckOptions,
): string[] {
  const failures: string[] = [];
  if (!options.development) {
    // Production attests only through dstack, whose quote binds report_data
    if (attestation.platform !== 'phala') {
      failures.push(
        `The gateway attests with ${attestation.platform}, not a dstack TDX quote`,
      );
    }
    if (!options.servedCertificate) {
      failures.push('The gateway was not reached over TLS');
    }
    if (attestation.eventLog === undefined) {
      failures.push('The attestation has no event log to replay');
    }
    if (!options.keyManifest) {
      failures.push('The gateway serves no key manifest');
    }
  }
  failures.push(
    ...verifyKeyBinding(attestation, {
      nonce: Buffer.from(options.nonce),
      servedCertificate: options.servedCertificate
        ? Buffer.from(options.servedCertificate)
        : undefined,
      keyManifest: options.keyManifest,
      host: options.host,
    }),
  );
  return failures;
}

/**
 * Verifies the gateway's attestation with a fresh nonce and returns a
 * client bound to it, or throws AttestationRefused having sent nothing but
 * the attestation and manifest requests.
 */
export async function openGateway(
  transport: GatewayTransport,
  options: { development?: boolean } = {},
): Promise<Gateway> {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const nonceHex = Buffer.from(nonce).toString('hex');

  const response = await transport.request({
    method: 'GET',
    path: `/attestation?nonce=${nonceHex}`,
  });
  if (response.status !== 200) {
    throw new AttestationRefused([
      `GET /attestation answered HTTP ${response.status}`,
    ]);
  }
  const attestation = parse<BoundAttestation>(response.body);
  if (!attestation?.keys) {
    throw new AttestationRefused(['GET /attestation returned no keys']);
  }

  const manifestResponse = await transport.request({
    method: 'GET',
    path: '/attestation/manifest',
    pinnedCertificate: response.certificate ?? undefined,
  });
  const keyManifest =
    manifestResponse.status === 200
      ? parse<SignedKeyManifest>(manifestResponse.body)
      : undefined;

  const failures = checkAttestation(attestation, {
    nonce,
    servedCertificate: response.certificate,
    keyManifest,
    host: transport.host,
    development: options.development,
  });
  if (failures.length > 0) {
    throw new AttestationRefused(failures);
  }

  const pinned = attestation.keys.tlsCertificate
    ? Buffer.from(attestation.keys.tlsCertificate, 'base64')
    : undefined;
  return {
    attestation,
    async post(path, body) {
      const res = await transport.request({
        method: 'POST',
        path,
        body: JSON.stringify(body),
        pinnedCertificate: pinned,
      });
      return { status: res.status, json: parse(res.body) };
    },
  };
}

function parse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
