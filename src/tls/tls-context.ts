// SPDX-License-Identifier: LGPL-3.0
// Copyright (C) 2026 Julien Béranger and the W3HC

/**
 * TLS Context
 *
 * Holds the DER encoding of the TLS leaf certificate the HTTPS server is
 * actually serving, so it can be bound into the TEE attestation quote:
 *
 *   report_data = SHA-256(mlkem_public_key) || SHA-256(tls_leaf_cert_der)
 *
 * The certificate is loaded in main.ts (before the Nest application exists),
 * which is why this is a plain module-level singleton rather than a Nest
 * provider.
 */

let tlsLeafCertificateDer: Buffer | null = null;

/**
 * Register the TLS leaf certificate served by this process.
 * Called once during bootstrap, before the HTTP(S) server starts.
 */
export function setTlsLeafCertificate(der: Buffer): void {
  tlsLeafCertificateDer = der;
}

/**
 * Get the DER-encoded TLS leaf certificate, or null when the process is not
 * terminating TLS itself (e.g. behind an external TLS proxy).
 */
export function getTlsLeafCertificate(): Buffer | null {
  return tlsLeafCertificateDer;
}

/** Test helper — reset module state between tests. */
export function clearTlsLeafCertificate(): void {
  tlsLeafCertificateDer = null;
}
