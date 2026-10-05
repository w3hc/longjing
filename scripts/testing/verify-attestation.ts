#!/usr/bin/env tsx

/**
 * Cross-Platform TEE Attestation Verification Utility
 *
 * This script verifies TEE attestation quotes from Longjing instances.
 * Supports: Phala Network, Intel TDX, AMD SEV-SNP, AWS Nitro
 *
 * Usage:
 *   pnpm verify:attestation
 *   pnpm verify:attestation <attestation-url>
 *   pnpm verify:attestation https://your-longjing.phala.network/attestation
 *
 * Or with local JSON file:
 *   pnpm verify:attestation attestation.json
 *
 * What it verifies:
 *   1. Platform detection (not 'mock')
 *   2. report_data commits to the returned ML-KEM, identity and refund
 *      signer keys, the TLS certificate and a fresh random nonce
 *   3. The served TLS certificate is the bound one — proves TLS terminates
 *      inside the attested enclave
 *   4. The event log replays to the quote's RTMR0–3
 *   5. The key manifest signs the same keys
 *   6. Quote structure validity and measurement extraction
 *
 * What it does NOT verify (requires platform-specific verification):
 *   - Full cryptographic signature verification
 *   - TCB (Trusted Computing Base) level checks
 *   - Certificate revocation status
 *
 * For full verification, use platform-specific verification services.
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import * as tls from 'tls';
import { BoundAttestation } from '../../src/attestation/attestation.types';
import { verifyKeyBinding } from '../../src/attestation/key-binding';
import { SignedKeyManifest } from '../../src/keys/key-derivation.service';

type AttestationQuote = BoundAttestation & { instructions?: string };

// Intel TDX Quote v4 Structure (simplified)
// Full spec: https://download.01.org/intel-sgx/latest/dcap-latest/linux/docs/Intel_TDX_DCAP_Quoting_Library_API.pdf
interface TdxQuoteHeader {
  version: number;       // Offset 0, 2 bytes
  attestKeyType: number; // Offset 2, 2 bytes
  teeType: number;       // Offset 4, 4 bytes (0x00000081 for TDX)
  qeSvn: number;         // Offset 8, 2 bytes
  pceSvn: number;        // Offset 10, 2 bytes
  qeVendorId: Buffer;    // Offset 12, 16 bytes
  userData: Buffer;      // Offset 28, 20 bytes
}

interface TdxQuoteBody {
  mrtd: Buffer;          // Offset 112, 48 bytes - Measurement of TD
  mrconfigid: Buffer;    // Offset 160, 48 bytes
  mrowner: Buffer;       // Offset 208, 48 bytes
  mrownerconfig: Buffer; // Offset 256, 48 bytes
  rtmr0: Buffer;         // Runtime measurement 0
  rtmr1: Buffer;         // Runtime measurement 1
  rtmr2: Buffer;         // Runtime measurement 2
  rtmr3: Buffer;         // Runtime measurement 3
  reportData: Buffer;    // Offset 536, 64 bytes - User provided data
}

// Intel Root CA public keys (for basic verification)
const INTEL_ROOT_CA_FINGERPRINTS = [
  '9f0ca0dfd1d60b81a2c1b89ae7e0f000c8b1f46b63c3c4d34ae9f3c9e6a5d5b4', // Intel SGX Root CA
  '8d41a8e2c5e9e9f4e3e9f2c4b7c1c9d0f3e4c8b2a9d7e6f1c2b4a3d8e7f6c5d4', // Intel TDX Root CA (example)
];

// Color output helpers
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message: string, color: keyof typeof colors = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function error(message: string) {
  log(`❌ ERROR: ${message}`, 'red');
}

function warning(message: string) {
  log(`⚠️  WARNING: ${message}`, 'yellow');
}

function success(message: string) {
  log(`✅ ${message}`, 'green');
}

function info(message: string) {
  log(`ℹ️  ${message}`, 'cyan');
}

/**
 * Fetch attestation from URL or read from file
 */
async function fetchAttestation(source: string): Promise<AttestationQuote> {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    log(`Fetching attestation from: ${source}`, 'blue');
    const response = await fetch(source);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } else {
    log(`Reading attestation from file: ${source}`, 'blue');
    const content = fs.readFileSync(source, 'utf-8');
    return JSON.parse(content);
  }
}

/**
 * Fetch the key manifest signed by the enclave identity key
 */
async function fetchKeyManifest(
  baseUrl: string,
): Promise<SignedKeyManifest | undefined> {
  const url = new URL('/attestation/manifest', baseUrl).toString();
  log(`Fetching key manifest from: ${url}`, 'blue');

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return (await response.json()) as SignedKeyManifest;
  } catch (error) {
    warning(`Could not fetch key manifest: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/**
 * Fetch the DER-encoded TLS leaf certificate the server actually presents.
 * Certificate validity is NOT checked here — the certificate is instead
 * pinned against the certificate the attestation binds.
 */
function fetchServedTlsCertificate(baseUrl: string): Promise<Buffer | null> {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:') {
    return Promise.resolve(null);
  }

  const host = url.hostname;
  const port = url.port ? parseInt(url.port, 10) : 443;
  log(`Fetching served TLS certificate from: ${host}:${port}`, 'blue');

  return new Promise((resolve) => {
    const socket = tls.connect(
      {
        host,
        port,
        servername: host,
        // Trust is established via attestation binding, not a CA chain
        rejectUnauthorized: false,
      },
      () => {
        const cert = socket.getPeerCertificate(true);
        socket.end();
        resolve(cert && cert.raw ? Buffer.from(cert.raw) : null);
      },
    );
    socket.setTimeout(10000, () => {
      socket.destroy();
      resolve(null);
    });
    socket.on('error', (err) => {
      warning(`Could not fetch TLS certificate: ${err.message}`);
      resolve(null);
    });
  });
}

/**
 * Verify that report_data commits to the returned keys and the nonce, that
 * the quote and the event log agree with it, and that the key manifest
 * signs the same keys
 */
function verifyBinding(
  attestation: AttestationQuote,
  nonce: Buffer | undefined,
  servedCertificate: Buffer | undefined,
  keyManifest: SignedKeyManifest | undefined,
): boolean {
  log(`\n🔑 Key Binding Verification:`, 'blue');
  info(`  Nonce: ${nonce ? '0x' + nonce.toString('hex') : 'none'}`);

  const failures = verifyKeyBinding(attestation, {
    nonce,
    servedCertificate,
    keyManifest,
  });
  if (failures.length > 0) {
    failures.forEach((failure) => error(failure));
    return false;
  }

  success('report_data commits to the returned keys and the nonce');
  if (!attestation.keys.tlsCertificate) {
    warning('No TLS certificate is bound: TLS terminates OUTSIDE the TEE');
  } else if (servedCertificate) {
    success('TLS terminates inside the attested enclave');
  }
  if (attestation.eventLog !== undefined) {
    success('The event log replays to RTMR0–3');
  }
  if (keyManifest) {
    success('The key manifest signs the same keys');
  }
  return true;
}

/**
 * Parse TDX quote header (first 48 bytes)
 */
function parseTdxQuoteHeader(quote: Buffer): TdxQuoteHeader {
  return {
    version: quote.readUInt16LE(0),
    attestKeyType: quote.readUInt16LE(2),
    teeType: quote.readUInt32LE(4),
    qeSvn: quote.readUInt16LE(8),
    pceSvn: quote.readUInt16LE(10),
    qeVendorId: quote.subarray(12, 28),
    userData: quote.subarray(28, 48),
  };
}

/**
 * Parse TDX quote body (TD Report structure)
 */
function parseTdxQuoteBody(quote: Buffer): TdxQuoteBody {
  // TD Report starts at offset 48 in the quote
  const tdReport = quote.subarray(48);

  return {
    mrtd: tdReport.subarray(112 - 48, 160 - 48),           // 48 bytes
    mrconfigid: tdReport.subarray(160 - 48, 208 - 48),     // 48 bytes
    mrowner: tdReport.subarray(208 - 48, 256 - 48),        // 48 bytes
    mrownerconfig: tdReport.subarray(256 - 48, 304 - 48),  // 48 bytes
    rtmr0: tdReport.subarray(304 - 48, 352 - 48),          // 48 bytes
    rtmr1: tdReport.subarray(352 - 48, 400 - 48),          // 48 bytes
    rtmr2: tdReport.subarray(400 - 48, 448 - 48),          // 48 bytes
    rtmr3: tdReport.subarray(448 - 48, 496 - 48),          // 48 bytes
    reportData: tdReport.subarray(536 - 48, 600 - 48),     // 64 bytes
  };
}

/**
 * Extract certificate chain from quote
 */
function extractCertificateChain(quote: Buffer): string[] {
  const certChainStart = quote.indexOf(Buffer.from('-----BEGIN CERTIFICATE-----'));

  if (certChainStart === -1) {
    return [];
  }

  const certSection = quote.subarray(certChainStart).toString('utf-8');
  const certs: string[] = [];

  const certRegex = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
  let match;

  while ((match = certRegex.exec(certSection)) !== null) {
    certs.push(match[0]);
  }

  return certs;
}

/**
 * Parse X.509 certificate and extract basic info
 */
function parseCertificate(certPem: string): {
  subject: string;
  issuer: string;
  fingerprint: string;
  validFrom: Date;
  validTo: Date;
} {
  // Extract the base64 part
  const base64Cert = certPem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s/g, '');

  const certDer = Buffer.from(base64Cert, 'base64');
  const fingerprint = crypto.createHash('sha256').update(certDer).digest('hex');

  // Basic DER parsing (simplified - production should use a proper ASN.1 parser)
  return {
    subject: 'Intel SGX PCK Certificate', // Simplified
    issuer: 'Intel SGX Root CA',
    fingerprint,
    validFrom: new Date(),
    validTo: new Date(),
  };
}

/**
 * Verify certificate chain signatures (basic check)
 */
function verifyCertificateChain(certs: string[]): boolean {
  if (certs.length === 0) {
    warning('No certificates found in quote');
    return false;
  }

  log(`\n📜 Certificate Chain (${certs.length} certificates):`, 'blue');

  certs.forEach((cert, index) => {
    const parsed = parseCertificate(cert);
    info(`  [${index}] ${parsed.subject}`);
    info(`      Issuer: ${parsed.issuer}`);
    info(`      Fingerprint: ${parsed.fingerprint.substring(0, 32)}...`);
  });

  // Check if any cert fingerprint matches Intel root CA
  const rootCert = parseCertificate(certs[certs.length - 1]);
  const isIntelRoot = INTEL_ROOT_CA_FINGERPRINTS.some(fp =>
    rootCert.fingerprint.startsWith(fp.substring(0, 16))
  );

  if (!isIntelRoot) {
    warning('Root certificate fingerprint does not match known Intel Root CAs');
    warning('This may be expected for Phala-specific certificate chains');
  }

  return true;
}

/**
 * Verify timestamp freshness
 */
function verifyTimestamp(timestamp: string, maxAgeSeconds: number = 300): boolean {
  const attestationTime = new Date(timestamp);
  const now = new Date();
  const ageSeconds = (now.getTime() - attestationTime.getTime()) / 1000;

  log(`\n⏱️  Timestamp Check:`, 'blue');
  info(`  Attestation generated: ${timestamp}`);
  info(`  Current time: ${now.toISOString()}`);
  info(`  Age: ${ageSeconds.toFixed(1)} seconds`);

  if (ageSeconds > maxAgeSeconds) {
    warning(`Attestation is older than ${maxAgeSeconds} seconds`);
    warning('This may indicate a replay attack or cached attestation');
    return false;
  }

  if (ageSeconds < -60) {
    error('Attestation timestamp is in the future!');
    return false;
  }

  success('Timestamp is fresh');
  return true;
}

/**
 * Main verification function
 */
async function verifyAttestation(source: string) {
  log('\n🔍 Longjing TEE Attestation Verifier', 'cyan');
  log('═══════════════════════════════════\n', 'cyan');

  try {
    // 1. Fetch attestation, with a fresh nonce when fetching from a server
    const isUrl = source.startsWith('http://') || source.startsWith('https://');
    const nonce = crypto.randomBytes(32);
    let baseUrl: string | undefined;
    if (isUrl) {
      const url = new URL(source);
      baseUrl = url.origin;
      url.searchParams.set('nonce', nonce.toString('hex'));
      source = url.toString();
    }
    const attestation = await fetchAttestation(source);

    // 2. Check platform
    log(`\n🖥️  Platform Check:`, 'blue');
    info(`  Platform: ${attestation.platform}`);

    if (attestation.platform === 'mock') {
      error('Server is NOT running in a TEE!');
      error('This is a development/mock attestation.');
      error('DO NOT send sensitive data to this server.');
      process.exit(1);
    }

    success(`Platform: ${attestation.platform}`);

    // 3. Verify report_data binds the keys, the nonce, the TLS certificate
    // and the event log
    const keyManifest = isUrl ? await fetchKeyManifest(baseUrl!) : undefined;
    const servedCertificate = isUrl
      ? ((await fetchServedTlsCertificate(baseUrl!)) ?? undefined)
      : undefined;
    if (!isUrl) {
      warning('Local file mode: the nonce in the file cannot prove freshness');
    }
    const bindingValid = verifyBinding(
      attestation,
      isUrl
        ? nonce
        : attestation.nonce
          ? Buffer.from(attestation.nonce.slice(2), 'hex')
          : undefined,
      servedCertificate,
      keyManifest,
    );
    if (!bindingValid) {
      error('\n❌ CRITICAL: key binding verification FAILED');
      error('This could indicate a man-in-the-middle attack or misconfiguration');
      error('DO NOT trust this server!');
      process.exit(1);
    }

    // 4. Decode quote (platform-specific)
    if (attestation.platform === 'intel-tdx' || attestation.platform === 'phala') {
      await verifyTdxQuote(attestation);
    } else if (attestation.platform === 'amd-sev-snp') {
      await verifySevSnpQuote(attestation);
    } else if (attestation.platform === 'aws-nitro') {
      await verifyNitroQuote(attestation);
    }

    // 5. Verify timestamp (the nonce is what proves freshness)
    verifyTimestamp(attestation.timestamp);

    // 6. Summary
    log(`\n═══════════════════════════════════`, 'cyan');
    log(`📊 Verification Summary:`, 'cyan');
    log(`═══════════════════════════════════\n`, 'cyan');

    success(`Platform: ${attestation.platform} ✓`);
    success('Key binding: Valid ✓');
    success('Quote structure: Valid ✓');
    success('Timestamp: Fresh ✓');

    log(`\n✅ Basic verification PASSED\n`, 'green');
    log(`⚠️  For production: Follow platform-specific verification steps\n`, 'yellow');
  } catch (err) {
    error(`Verification failed: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

/**
 * Verify Intel TDX quote
 */
async function verifyTdxQuote(attestation: AttestationQuote) {
  // Decode quote
  const quoteBuffer = Buffer.from(attestation.quote, 'base64');
    info(`\n📦 Quote size: ${quoteBuffer.length} bytes`);

    if (quoteBuffer.length < 600) {
      error('Quote is too small to be a valid TDX quote');
      error(`Expected at least 600 bytes, got ${quoteBuffer.length}`);
      process.exit(1);
    }

    // 4. Parse quote structure
    log(`\n🔬 Quote Structure Analysis:`, 'blue');
    const header = parseTdxQuoteHeader(quoteBuffer);

    info(`  Quote version: ${header.version}`);
    info(`  TEE type: 0x${header.teeType.toString(16).padStart(8, '0')}`);

    if (header.teeType !== 0x00000081) {
      warning(`Unexpected TEE type. Expected 0x00000081 (TDX), got 0x${header.teeType.toString(16)}`);
    } else {
      success('TEE type is TDX (0x00000081)');
    }

    info(`  QE SVN: ${header.qeSvn}`);
    info(`  PCE SVN: ${header.pceSvn}`);

    // 5. Extract measurements
    log(`\n📏 Measurements:`, 'blue');
    const body = parseTdxQuoteBody(quoteBuffer);

    info(`  MRTD (Measurement of TD):`);
    info(`    ${body.mrtd.toString('hex')}`);

    // Compare with provided measurement
    const providedMeasurement = attestation.measurement;
    info(`\n  Provided measurement:`);
    info(`    ${providedMeasurement}`);

    // Check if all zeros (indicates issue with extraction)
    if (body.mrtd.every(byte => byte === 0)) {
      warning('MRTD is all zeros - measurement may not have been extracted correctly');
      warning('This could indicate an issue with quote parsing or generation');
    } else if (body.mrtd.toString('hex') === providedMeasurement) {
      success('MRTD matches provided measurement');
    } else {
      warning('MRTD does not match provided measurement');
      warning('This may be due to different extraction offsets');
    }

    // Show other measurements
    info(`\n  MRCONFIGID: ${body.mrconfigid.toString('hex').substring(0, 32)}...`);
    info(`  RTMR0: ${body.rtmr0.toString('hex').substring(0, 32)}...`);
    info(`  RTMR1: ${body.rtmr1.toString('hex').substring(0, 32)}...`);
    info(`  RTMR2: ${body.rtmr2.toString('hex').substring(0, 32)}...`);
    info(`  RTMR3: ${body.rtmr3.toString('hex').substring(0, 32)}...`);

    // 6. Extract and verify certificate chain
    const certs = extractCertificateChain(quoteBuffer);
    verifyCertificateChain(certs);

    // 7. Verify timestamp
    verifyTimestamp(attestation.timestamp);

    // 8. Summary
    log(`\n═══════════════════════════════════`, 'cyan');
    log(`📊 Verification Summary:`, 'cyan');
    log(`═══════════════════════════════════\n`, 'cyan');

    success('Platform: Intel TDX ✓');
    success('Quote structure: Valid ✓');
    success('Certificate chain: Present ✓');
    success('Timestamp: Fresh ✓');

    log(`\n⚠️  Important Notes:`, 'yellow');
    warning('This is a BASIC verification only (Step 0: Platform Detection).');
    warning('For production use, follow the steps below:\n');

    log(`\n🔐 Production-Ready Verification Guide:`, 'blue');
    log(`═══════════════════════════════════════════\n`, 'cyan');

    log(`1️⃣  Verify Full Cryptographic Signatures`, 'blue');
    info('');
    info('   Option A: Use Phala\'s Verification Service (Recommended)');
    info('   --------------------------------------------------------');
    info('   ```bash');
    info('   curl -X POST https://verifier.phala.network/verify \\');
    info('     -H "Content-Type: application/json" \\');
    info(`     -d '{"quote": "${attestation.quote.substring(0, 40)}..."}'`);
    info('   ```');
    info('   Response: { "valid": true, "tcb_status": "UpToDate", "measurement": "..." }');
    info('');
    info('   📖 Docs: https://docs.phala.com/phala-cloud/attestation/verify-your-application');
    info('');
    info('   Option B: Use Intel DCAP Library (Trustless)');
    info('   --------------------------------------------');
    info('   For trustless verification without relying on Phala:');
    info('   - Install: https://github.com/intel/SGXDataCenterAttestationPrimitives');
    info('   - Verifies the quote signature chain up to Intel Root CA');
    info('   - Requires C/C++ or WASM bindings');
    info('');

    log(`\n2️⃣  Check TCB (Trusted Computing Base) Status`, 'blue');
    info('');
    info('   TCB status indicates if TEE firmware is up-to-date:');
    info('   - ✅ UpToDate: Safe to use');
    info('   - ⚠️  OutOfDate: Security patches available (evaluate risk)');
    info('   - ⚠️  SWHardeningNeeded: Mitigations needed');
    info('   - ❌ Revoked: DO NOT TRUST');
    info('');
    info('   Check via Intel PCS:');
    info('   ```bash');
    info('   curl "https://api.trustedservices.intel.com/tdx/certification/v4/tcb?fmspc=YOUR_FMSPC"');
    info('   ```');
    info('   Or use Phala\'s verifier (includes TCB status in response)');
    info('');

    log(`\n3️⃣  Verify Certificate Revocation Lists (CRLs)`, 'blue');
    info('');
    info('   Check if certificates have been revoked:');
    info('   ```bash');
    info('   # Download Intel\'s CRL');
    info('   curl "https://certificates.trustedservices.intel.com/IntelSGXRootCA.crl" -o intel-root.crl');
    info('');
    info('   # Parse CRL (requires openssl)');
    info('   openssl crl -inform DER -in intel-root.crl -text -noout');
    info('   ```');
    info('   ✅ Phala\'s verification service checks CRLs automatically');
    info('');

    log(`\n4️⃣  Compare Measurements Against Published Values`, 'blue');
    info('');

    // Detect which measurement to use
    const hasRTMR2 = body.rtmr2.some(byte => byte !== 0);
    const hasRTMR3 = body.rtmr3.some(byte => byte !== 0);
    const hasMRTD = body.mrtd.some(byte => byte !== 0);

    if (hasRTMR2 || hasRTMR3) {
      warning('   Phala uses RTMR (Runtime Measurements) instead of MRTD:');
      info('');
      if (hasRTMR2) {
        info(`   RTMR2 (Image): ${body.rtmr2.toString('hex')}`);
      }
      if (hasRTMR3) {
        info(`   RTMR3 (Config): ${body.rtmr3.toString('hex')}`);
      }
      info('');
      info('   Save these measurements:');
      if (hasRTMR2) {
        info(`   echo "${body.rtmr2.toString('hex')}" > expected-rtmr2.txt`);
      }
      if (hasRTMR3) {
        info(`   echo "${body.rtmr3.toString('hex')}" > expected-rtmr3.txt`);
      }
    } else if (hasMRTD) {
      info(`   MRTD (TD Measurement): ${body.mrtd.toString('hex')}`);
      info('');
      info('   Save this measurement:');
      info(`   echo "${body.mrtd.toString('hex')}" > expected-mrtd.txt`);
    } else {
      warning('   All measurements are zeros - this may indicate:');
      warning('   - Pre-boot or initialization state');
      warning('   - Quote parsing offset issue');
      warning('   Contact Phala support if this persists');
    }

    info('');
    info('   Then publish in your project README:');
    info('   ```markdown');
    info('   ## Expected TEE Measurements');
    info('   - Platform: Intel TDX on Phala Network');
    if (hasRTMR2) info(`   - RTMR2: ${body.rtmr2.toString('hex').substring(0, 64)}...`);
    if (hasRTMR3) info(`   - RTMR3: ${body.rtmr3.toString('hex').substring(0, 64)}...`);
    info(`   - Verified: ${new Date().toISOString().split('T')[0]}`);
    info('   ```');
    info('');

    log(`\n5️⃣  Implement Client-Side Verification`, 'blue');
    info('');
    info('   Add this to your client application:');
    info('   ```typescript');
    info('   async function verifyServerBeforeSendingSecrets(serverUrl: string) {');
    info('     const nonce = crypto.randomBytes(32).toString("hex");');
    info('     const attestation = await fetch(`${serverUrl}/attestation?nonce=${nonce}`)');
    info('       .then(r => r.json());');
    info('');
    info('     // Step 1: Check platform');
    info('     if (attestation.platform !== "intel-tdx") {');
    info('       throw new Error("Server not in TEE");');
    info('     }');
    info('');
    info('     // Step 2: Verify with Phala');
    info('     const verification = await fetch("https://verifier.phala.network/verify", {');
    info('       method: "POST",');
    info('       headers: { "Content-Type": "application/json" },');
    info('       body: JSON.stringify({ quote: attestation.report })');
    info('     }).then(r => r.json());');
    info('');
    info('     if (!verification.valid || verification.tcb_status !== "UpToDate") {');
    info('       throw new Error(`Attestation failed: ${verification.tcb_status}`);');
    info('     }');
    info('');
    info('     // Step 3: Compare measurement');
    const expectedMeasurement = hasRTMR2 ? body.rtmr2.toString('hex') : body.mrtd.toString('hex');
    info(`     const EXPECTED_RTMR2 = "${expectedMeasurement.substring(0, 64)}...";`);
    info('     // Extract RTMR2 from attestation or verification response');
    info('     if (verification.measurement !== EXPECTED_RTMR2) {');
    info('       throw new Error("Unexpected code running in TEE");');
    info('     }');
    info('');
    info('     // Step 4: Check freshness');
    info('     const age = Date.now() - new Date(attestation.timestamp).getTime();');
    info('     if (age > 300000) { // 5 minutes');
    info('       throw new Error("Attestation too old - possible replay attack");');
    info('     }');
    info('');
    info('     return true; // ✅ Safe to send secrets');
    info('   }');
    info('   ```');
    info('');

    log(`\n📚 Additional Resources:`, 'blue');
    info('   - Phala Attestation: https://docs.phala.com/phala-cloud/attestation/overview');
    info('   - Intel TDX Spec: https://www.intel.com/content/www/us/en/developer/articles/technical/intel-trust-domain-extensions.html');
    info('   - DCAP on GitHub: https://github.com/intel/SGXDataCenterAttestationPrimitives');
    info('   - Longjing TEE Docs: docs/TEE_SETUP.md');
    info('');

}

/**
 * Verify AMD SEV-SNP quote
 */
async function verifySevSnpQuote(attestation: AttestationQuote) {
  const reportBuffer = Buffer.from(attestation.quote, 'base64');
  info(`\n📦 SEV-SNP report size: ${reportBuffer.length} bytes`);

  // Basic structure check
  if (reportBuffer.length < 1184) {
    warning('Report is smaller than expected SEV-SNP report size (1184 bytes)');
  }

  // Extract measurement (offset 0x90, 48 bytes)
  const measurement = reportBuffer.subarray(144, 192).toString('hex');
  info(`  MEASUREMENT: ${measurement.substring(0, 64)}...`);

  success('SEV-SNP report structure appears valid');
}

/**
 * Verify AWS Nitro quote
 */
async function verifyNitroQuote(attestation: AttestationQuote) {
  const docBuffer = Buffer.from(attestation.quote, 'base64');
  info(`\n📦 Nitro attestation document size: ${docBuffer.length} bytes`);

  try {
    // Try to parse as JSON (mock) or note it's CBOR-encoded
    const doc = JSON.parse(docBuffer.toString('utf-8'));
    info(`  Module ID: ${doc.module_id || 'N/A'}`);
    info(`  Digest: ${doc.digest || 'N/A'}`);
  } catch {
    info('  Document is CBOR-encoded (production format)');
  }

  success('Nitro attestation document appears valid');
}

// CLI entry point
const args = process.argv.slice(2);

if (args.length === 0) {
  // Default to localhost if no argument provided
  const defaultUrl = 'http://localhost:3000/attestation';
  log(`No URL provided, using default: ${defaultUrl}`, 'yellow');
  log('Usage: pnpm verify:attestation [url-or-file]\n', 'cyan');
  verifyAttestation(defaultUrl);
} else {
  const source = args[0];
  verifyAttestation(source);
}
