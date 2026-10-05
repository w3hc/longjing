import { X509Certificate } from 'crypto';
import * as http from 'http';
import { Injectable } from '@nestjs/common';
import { getAddress } from 'ethers';

export const DSTACK_SOCKET_PATH = '/var/run/dstack.sock';

export type KeyAlgorithm = 'secp256k1' | 'ed25519';

export interface GetKeyResponse {
  key: Uint8Array;
  publicKey: Uint8Array;
  signatureChain: Uint8Array[];
}

export interface GetTlsKeyResponse {
  /** PKCS#8 private key, PEM. */
  key: string;
  /** PEM certificates, leaf first. */
  certificateChain: string[];
  leafCertificateDer: Uint8Array;
}

export interface GetQuoteResponse {
  /** Raw TDX quote. */
  quote: Uint8Array;
  /** JSON event log, which replays RTMR0-3. */
  eventLog: string;
}

/**
 * Minimal client for the dstack guest agent v1 API (dstack >= 0.6.0).
 *
 * GetKey uses v1: v0 ignores the algorithm and lets the caller steer the
 * signature chain claim. Longjing's keys are derived with v1, see
 * docs/KEY_DERIVATION.md.
 *
 * Talks to the unix socket, or to DSTACK_SIMULATOR_ENDPOINT (a socket path
 * or an http URL) when set.
 */
@Injectable()
export class DstackV1Client {
  private readonly endpoint: string;

  constructor() {
    this.endpoint = process.env.DSTACK_SIMULATOR_ENDPOINT || DSTACK_SOCKET_PATH;
  }

  isSimulator(): boolean {
    return this.endpoint !== DSTACK_SOCKET_PATH;
  }

  async getKey(
    domain: string,
    algorithm: KeyAlgorithm,
  ): Promise<GetKeyResponse> {
    const result = await this.call('/v1/GetKey', { domain, algorithm });
    if (!Array.isArray(result.signature_chain)) {
      throw new Error('dstack GetKey returned no signature_chain');
    }
    return {
      key: decodeHex(result.key, 'key'),
      publicKey: decodeHex(result.public_key, 'public_key'),
      signatureChain: result.signature_chain.map((link, i) =>
        decodeHex(link, `signature_chain[${i}]`),
      ),
    };
  }

  /**
   * A TLS server key and certificate issued by the KMS to this app, with the
   * private key generated inside the CVM. The chain is leaf first.
   */
  async getTlsKey(altNames: string[]): Promise<GetTlsKeyResponse> {
    const result = await this.call('/GetTlsKey', {
      subject: altNames[0] ?? 'longjing',
      alt_names: altNames,
      usage_ra_tls: true,
      usage_server_auth: true,
      usage_client_auth: false,
    });
    const chain = result.certificate_chain;
    if (
      typeof result.key !== 'string' ||
      !Array.isArray(chain) ||
      chain.length === 0 ||
      !chain.every((pem) => typeof pem === 'string')
    ) {
      throw new Error('dstack GetTlsKey returned no key or certificate_chain');
    }
    return {
      key: result.key,
      certificateChain: chain,
      leafCertificateDer: new Uint8Array(new X509Certificate(chain[0]).raw),
    };
  }

  /**
   * A TDX quote over `reportData`, which the guest agent zero-pads to 64 bytes.
   */
  async getQuote(reportData: Uint8Array): Promise<GetQuoteResponse> {
    if (reportData.length > 64) {
      throw new Error('report_data must be at most 64 bytes');
    }
    const result = await this.call('/GetQuote', {
      report_data: Buffer.from(reportData).toString('hex'),
    });
    if (typeof result.event_log !== 'string') {
      throw new Error('dstack GetQuote returned no event_log');
    }
    return {
      quote: decodeHex(result.quote, 'quote'),
      eventLog: result.event_log,
    };
  }

  /** This CVM's app id, from the guest agent's Info. */
  async getAppId(): Promise<string> {
    const { app_id: appId } = await this.call('/Info', {});
    if (typeof appId !== 'string') {
      throw new Error('dstack Info returned no app_id');
    }
    return getAddress(appId.startsWith('0x') ? appId : `0x${appId}`);
  }

  private call(
    path: string,
    body: object,
  ): Promise<
    Record<string, unknown> & {
      signature_chain?: unknown[];
      certificate_chain?: unknown[];
    }
  > {
    const payload = JSON.stringify(body);
    const target = this.endpoint.startsWith('http')
      ? new URL(path, this.endpoint)
      : null;

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          ...(target
            ? {
                hostname: target.hostname,
                port: target.port,
                path: target.pathname,
              }
            : { socketPath: this.endpoint, path }),
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: 10_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8');
            if (res.statusCode !== 200) {
              reject(
                new Error(`dstack ${path} failed (${res.statusCode}): ${text}`),
              );
              return;
            }
            try {
              resolve(JSON.parse(text) as Record<string, unknown>);
            } catch {
              reject(new Error(`dstack ${path} returned invalid JSON`));
            }
          });
        },
      );
      req.on('timeout', () =>
        req.destroy(new Error(`dstack ${path} timed out`)),
      );
      req.on('error', reject);
      req.end(payload);
    });
  }
}

// Strict on purpose: Buffer.from(hex) silently truncates at the first bad pair.
function decodeHex(value: unknown, field: string): Uint8Array {
  if (typeof value !== 'string') {
    throw new Error(`dstack returned no ${field}`);
  }
  const hex = value.startsWith('0x') ? value.slice(2) : value;
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`dstack returned a malformed ${field}`);
  }
  return new Uint8Array(Buffer.from(hex, 'hex'));
}
