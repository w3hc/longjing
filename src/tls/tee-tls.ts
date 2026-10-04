// SPDX-License-Identifier: LGPL-3.0
// Copyright (C) 2026 Julien Béranger and the W3HC

/**
 * In-enclave TLS termination
 *
 * Production must terminate TLS *inside* the TEE, so that request bodies
 * (which may carry user secrets on the /longjing/proofs/* endpoints) are never
 * visible in plaintext at an external TLS-termination proxy.
 *
 * Key material resolution order in production:
 *   1. TLS_KEY_PATH / TLS_CERT_PATH — operator-provisioned files that must
 *      live in enclave-only storage (non-dstack TEE platforms).
 *   2. dstack/tappd getTlsKey() — key derived by the dstack KMS *inside* the
 *      CVM; it exists only in enclave memory and never touches the host.
 *   3. ALLOW_EXTERNAL_TLS_TERMINATION=true — explicit, loudly-logged opt-out
 *      that restores the old plain-HTTP-behind-proxy behavior.
 *   4. Otherwise: fail closed (same posture as the proof-verification check).
 *
 * Whatever certificate is used is registered in the TLS context so the
 * attestation service can bind SHA-256(cert DER) into report_data, letting
 * clients verify the TLS session terminates inside the attested enclave.
 *
 * On Phala/dstack the gateway must be used in TLS-passthrough mode
 * (https://<app-id>-<port>s.<base-domain> — note the trailing "s") so the
 * gateway forwards raw TLS instead of terminating it.
 */

import * as fs from 'fs';
import { X509Certificate } from 'crypto';
import { Logger } from '@nestjs/common';
import { DstackClient, TappdClient } from '@phala/dstack-sdk';

import { setTlsLeafCertificate } from './tls-context';

export type TlsSource = 'dev-file' | 'file' | 'dstack' | 'external-proxy';

export interface TlsMaterial {
  /** Passed to NestFactory.create; undefined = plain HTTP. */
  httpsOptions: { key: string | Buffer; cert: string | Buffer } | undefined;
  /** Where the key material came from (for logging/health). */
  source: TlsSource;
}

const logger = new Logger('TeeTls');

/**
 * Parse a PEM certificate (or chain) and register the leaf's DER encoding
 * for attestation binding. Returns the leaf certificate.
 */
function registerLeafCertificate(certPem: string | Buffer): X509Certificate {
  const leaf = new X509Certificate(certPem);
  setTlsLeafCertificate(Buffer.from(leaf.raw));
  return leaf;
}

/**
 * Obtain a TLS key + certificate chain from the dstack KMS.
 * The private key is derived inside the CVM and never leaves enclave memory.
 */
async function loadFromDstack(): Promise<TlsMaterial | null> {
  // DstackClient (dstack.sock) first, TappdClient (tappd.sock) for legacy
  // deployments — both sockets are mounted in docker-compose.yml.
  // (Only getTlsKey is used, which both clients share.)
  type TlsKeyClient = Pick<DstackClient, 'getTlsKey'>;
  const clients: Array<() => TlsKeyClient> = [
    () => new DstackClient(),
    () => new TappdClient(),
  ];

  for (const createClient of clients) {
    let client: TlsKeyClient;
    try {
      client = createClient(); // throws when the socket does not exist
    } catch {
      continue;
    }

    try {
      const subject = process.env.TLS_CERT_SUBJECT || 'longjing';
      const altNames = process.env.TLS_CERT_ALT_NAMES
        ? process.env.TLS_CERT_ALT_NAMES.split(',').map((n) => n.trim())
        : undefined;

      const result = await client.getTlsKey({
        subject,
        altNames,
        usageServerAuth: true,
      });

      if (!result.key || result.certificate_chain.length === 0) {
        throw new Error('dstack returned empty TLS key material');
      }

      registerLeafCertificate(result.certificate_chain[0]);
      return {
        httpsOptions: {
          key: result.key,
          cert: result.certificate_chain.join('\n'),
        },
        source: 'dstack',
      };
    } catch (error) {
      logger.warn(
        `dstack getTlsKey failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return null;
}

/**
 * Load TLS key material from operator-provided paths (TLS_KEY_PATH /
 * TLS_CERT_PATH). In production these files MUST live in enclave-only
 * storage — never on the host filesystem.
 */
function loadFromFiles(keyPath: string, certPath: string): TlsMaterial {
  const key = fs.readFileSync(keyPath);
  const cert = fs.readFileSync(certPath);
  registerLeafCertificate(cert);
  return { httpsOptions: { key, cert }, source: 'file' };
}

/**
 * Resolve the TLS configuration for this process.
 *
 * Dev: self-signed certs from ./secrets (unchanged behavior).
 * Prod: in-enclave TLS termination, failing closed when no enclave-held key
 * material is available and the external-terminator escape hatch is not
 * explicitly enabled.
 */
export async function loadTlsMaterial(isProd: boolean): Promise<TlsMaterial> {
  if (!isProd) {
    const material = loadFromFiles('./secrets/tls.key', './secrets/tls.cert');
    return { ...material, source: 'dev-file' };
  }

  // 1. Explicit operator-provisioned paths (non-dstack TEE platforms)
  const keyPath = process.env.TLS_KEY_PATH;
  const certPath = process.env.TLS_CERT_PATH;
  if (keyPath && certPath) {
    logger.log(`Loading TLS key material from ${certPath} (enclave storage)`);
    return loadFromFiles(keyPath, certPath);
  }

  // 2. dstack KMS — key derived inside the CVM
  const dstackMaterial = await loadFromDstack();
  if (dstackMaterial) {
    logger.log(
      'TLS key derived in-enclave via dstack KMS — TLS terminates inside the TEE',
    );
    return dstackMaterial;
  }

  // 3. Explicit opt-out (previous behavior: HTTP behind an external proxy)
  if (process.env.ALLOW_EXTERNAL_TLS_TERMINATION === 'true') {
    logger.warn(
      '⚠️  ALLOW_EXTERNAL_TLS_TERMINATION=true — serving plain HTTP behind an ' +
        'external TLS terminator. Request bodies (including secretKey on ' +
        '/longjing/proofs/*) are visible in plaintext at the termination proxy, ' +
        'OUTSIDE the TEE trust boundary. Do not use with real user secrets.',
    );
    return { httpsOptions: undefined, source: 'external-proxy' };
  }

  // 4. Fail closed
  throw new Error(
    'FATAL: Cannot start in production without in-enclave TLS termination. ' +
      'Provide key material via dstack (mount /var/run/dstack.sock or ' +
      '/var/run/tappd.sock) or TLS_KEY_PATH/TLS_CERT_PATH in enclave storage. ' +
      'To explicitly accept an external TLS terminator (NOT recommended), ' +
      'set ALLOW_EXTERNAL_TLS_TERMINATION=true.',
  );
}
