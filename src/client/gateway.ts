/**
 * The client's way to the gateway: it verifies the attestation, with a fresh
 * nonce, before its first request, and sends nothing when the quote, the
 * nonce or a bound key doesn't match. The only way to get a `post` is
 * through `openGateway`.
 *
 * The transport is the only environment-specific part: scripts/client/
 * transport.ts for Node, fetchTransport for a browser
 * (docs/INTEGRATION_GUIDELINES.md).
 */

import { BoundAttestation } from '../attestation/attestation.types';
import { verifyKeyBinding } from '../attestation/key-binding';
import type { SignedKeyManifest } from '../keys/key-manifest';
import { base64ToBytes, bytesToHex } from '../common/bytes';

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
  /**
   * False when the transport can't see the session's TLS certificate, as in
   * a browser: the attested .onion address then binds the session
   */
  readonly certificateVisible?: boolean;
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
  /** False when the client can't see the TLS certificate, as in a browser */
  certificateVisible?: boolean;
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
    if (options.certificateVisible === false) {
      if (!isOnion(options.host)) {
        failures.push(
          "A browser can't pin the TLS certificate: reach the gateway at its attested .onion address",
        );
      }
    } else if (!options.servedCertificate) {
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
      nonce: options.nonce,
      servedCertificate: options.servedCertificate ?? undefined,
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
  const nonceHex = bytesToHex(nonce);

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
    certificateVisible: transport.certificateVisible,
    development: options.development,
  });
  if (failures.length > 0) {
    throw new AttestationRefused(failures);
  }

  const pinned = attestation.keys.tlsCertificate
    ? base64ToBytes(attestation.keys.tlsCertificate)
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
      return { status: res.status, json: parse<unknown>(res.body) };
    },
  };
}

/**
 * A browser transport over fetch: no cookies, no referrer, no cache. It
 * can't see or pin the TLS certificate, so outside development the gateway
 * must be its attested .onion address, in Tor Browser
 * (docs/INTEGRATION_GUIDELINES.md#verifying-in-the-browser).
 * @param baseUrl The gateway's origin, https://<address>.onion
 */
export function fetchTransport(baseUrl: string): GatewayTransport {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Unsupported gateway URL ${baseUrl}`);
  }
  return {
    host: url.hostname,
    secure: url.protocol === 'https:',
    certificateVisible: false,
    async request({ method, path, body }) {
      const response = await fetch(new URL(path, url), {
        method,
        body,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        redirect: 'error',
      });
      return {
        status: response.status,
        body: await response.text(),
        certificate: null,
      };
    },
  };
}

function isOnion(host: string | undefined): boolean {
  return !!host?.toLowerCase().replace(/\.$/, '').endsWith('.onion');
}

function parse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
