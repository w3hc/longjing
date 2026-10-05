// SPDX-License-Identifier: LGPL-3.0
// Copyright (C) 2026 Julien Béranger and the W3HC

import * as fs from 'fs';
import { X509Certificate, createHash } from 'crypto';

import { loadTlsMaterial } from './tee-tls';
import { getTlsLeafCertificate, clearTlsLeafCertificate } from './tls-context';

jest.mock('fs');
jest.mock('@phala/dstack-sdk', () => ({
  DstackClient: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const dstackSdk = require('@phala/dstack-sdk') as {
  DstackClient: jest.Mock;
};

// The loader passes the key through without parsing it, so a placeholder suffices
const FIXTURE_KEY = 'fixture-tls-key';

// Self-signed test certificate (not used anywhere outside these tests)
const FIXTURE_CERT = `-----BEGIN CERTIFICATE-----
MIIBgTCCASegAwIBAgIUd8EwQnu+eSkmWNzYkL2jNQF3xD8wCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLemstYXBpLXRlc3QwHhcNMjYwNzA3MTY0NDA4WhcNMzYwNzA0
MTY0NDA4WjAWMRQwEgYDVQQDDAt6ay1hcGktdGVzdDBZMBMGByqGSM49AgEGCCqG
SM49AwEHA0IABIZA30lt8loUBhvuGfNBFTUsSMQIqh4b1QgqdfESju2yoNZpQCuI
3EJeAdvEjxVSTbcIXV9VhFBwaRxBjj/9QRyjUzBRMB0GA1UdDgQWBBSj+eyDqHN3
1hyQNv0V3nBk1gxBODAfBgNVHSMEGDAWgBSj+eyDqHN31hyQNv0V3nBk1gxBODAP
BgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUCIEkq187VwDyIbuuwxXMs
ozKvHgo8dLknE46aaBbiWr7BAiEAjWdlfuZFM4CwuYmAhuvSD8x3benvl41HV+VJ
TdgEP1k=
-----END CERTIFICATE-----`;

const FIXTURE_CERT_DER = new X509Certificate(FIXTURE_CERT).raw;

describe('loadTlsMaterial', () => {
  const mockReadFileSync = fs.readFileSync as jest.Mock;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    clearTlsLeafCertificate();
    jest.clearAllMocks();
    delete process.env.TLS_KEY_PATH;
    delete process.env.TLS_CERT_PATH;
    delete process.env.ALLOW_EXTERNAL_TLS_TERMINATION;
    // Default: dstack socket unavailable (constructor throws like the SDK)
    dstackSdk.DstackClient.mockImplementation(() => {
      throw new Error('Unix socket file /var/run/dstack.sock does not exist');
    });
  });

  afterAll(() => {
    process.env = savedEnv;
  });

  describe('development mode', () => {
    it('loads self-signed certs from ./secrets and registers the leaf cert', async () => {
      mockReadFileSync.mockImplementation((path: string) =>
        path.endsWith('.key')
          ? Buffer.from(FIXTURE_KEY)
          : Buffer.from(FIXTURE_CERT),
      );

      const material = await loadTlsMaterial(false);

      expect(material.source).toBe('dev-file');
      expect(material.httpsOptions).toBeDefined();
      expect(mockReadFileSync).toHaveBeenCalledWith('./secrets/tls.key');
      expect(mockReadFileSync).toHaveBeenCalledWith('./secrets/tls.cert');
      expect(getTlsLeafCertificate()).toEqual(Buffer.from(FIXTURE_CERT_DER));
    });
  });

  describe('production mode', () => {
    it('uses TLS_KEY_PATH/TLS_CERT_PATH when provided', async () => {
      process.env.TLS_KEY_PATH = '/sealed-storage/tls.key';
      process.env.TLS_CERT_PATH = '/sealed-storage/tls.cert';
      mockReadFileSync.mockImplementation((path: string) =>
        path.endsWith('.key')
          ? Buffer.from(FIXTURE_KEY)
          : Buffer.from(FIXTURE_CERT),
      );

      const material = await loadTlsMaterial(true);

      expect(material.source).toBe('file');
      expect(material.httpsOptions).toBeDefined();
      expect(mockReadFileSync).toHaveBeenCalledWith('/sealed-storage/tls.key');
      expect(getTlsLeafCertificate()).toEqual(Buffer.from(FIXTURE_CERT_DER));
    });

    it('derives the key in-enclave via dstack when the socket is available', async () => {
      const getTlsKey = jest.fn().mockResolvedValue({
        key: FIXTURE_KEY,
        certificate_chain: [FIXTURE_CERT],
      });
      dstackSdk.DstackClient.mockImplementation(() => ({ getTlsKey }));

      const material = await loadTlsMaterial(true);

      expect(material.source).toBe('dstack');
      expect(material.httpsOptions?.key).toBe(FIXTURE_KEY);
      expect(getTlsKey).toHaveBeenCalledWith(
        expect.objectContaining({ usageServerAuth: true }),
      );
      // Leaf cert registered for attestation binding
      const der = getTlsLeafCertificate();
      expect(der).not.toBeNull();
      expect(createHash('sha256').update(der!).digest()).toEqual(
        createHash('sha256').update(FIXTURE_CERT_DER).digest(),
      );
    });

    it('serves plain HTTP only with explicit ALLOW_EXTERNAL_TLS_TERMINATION', async () => {
      process.env.ALLOW_EXTERNAL_TLS_TERMINATION = 'true';

      const material = await loadTlsMaterial(true);

      expect(material.source).toBe('external-proxy');
      expect(material.httpsOptions).toBeUndefined();
      expect(getTlsLeafCertificate()).toBeNull();
    });

    it('fails closed when no enclave-held key material is available', async () => {
      await expect(loadTlsMaterial(true)).rejects.toThrow(
        /in-enclave TLS termination/,
      );
    });
  });
});
