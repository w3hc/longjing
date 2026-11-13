// SPDX-License-Identifier: LGPL-3.0
// Copyright (C) 2026 Julien Béranger and the W3HC

import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import * as tls from 'tls';
import { execFileSync } from 'child_process';
import { AddressInfo } from 'net';

import { loadTlsMaterial } from './tee-tls';
import { clearTlsLeafCertificate } from './tls-context';
import { TLS_CLIENT_GROUPS, TLS_SERVER_GROUPS } from './tls-groups';

function negotiatedGroup(port: number, ecdhCurve?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host: '127.0.0.1',
        port,
        rejectUnauthorized: false,
        ...(ecdhCurve && { ecdhCurve }),
      },
      () => {
        const info = socket.getEphemeralKeyInfo() as { name?: string } | null;
        socket.end();
        resolve(info?.name ?? '');
      },
    );
    socket.on('error', reject);
  });
}

describe('TLS key exchange groups', () => {
  const savedEnv = { ...process.env };
  let dir: string;
  let server: https.Server;
  let port: number;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'longjing-tls-'));
    const keyPath = path.join(dir, 'tls.key');
    const certPath = path.join(dir, 'tls.cert');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:P-256',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '1',
        '-subj',
        '/CN=longjing-test',
      ],
      { stdio: 'ignore' },
    );
    process.env.TLS_KEY_PATH = keyPath;
    process.env.TLS_CERT_PATH = certPath;

    const { httpsOptions } = await loadTlsMaterial(true);
    server = https.createServer(httpsOptions!, (_req, res) => res.end());
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
    clearTlsLeafCertificate();
    process.env = savedEnv;
  });

  it('sets the groups explicitly, without DEFAULT', async () => {
    const { httpsOptions } = await loadTlsMaterial(true);
    expect(httpsOptions?.ecdhCurve).toBe(TLS_SERVER_GROUPS);
    expect(httpsOptions?.ecdhCurve).not.toMatch(/DEFAULT/i);
  });

  it.each([
    ['the reference client', TLS_CLIENT_GROUPS, 'SecP384r1MLKEM1024'],
    [
      'a client listing X25519MLKEM768 first',
      'X25519MLKEM768:SecP384r1MLKEM1024',
      'SecP384r1MLKEM1024',
    ],
    ['a default OpenSSL client', undefined, 'X25519MLKEM768'],
    [
      'a client listing X25519 first',
      'X25519:X25519MLKEM768',
      'X25519MLKEM768',
    ],
    ['a classical-only client', 'X25519', 'X25519'],
  ])('gives %s %s', async (_client, offer, expected) => {
    await expect(negotiatedGroup(port, offer)).resolves.toBe(expected);
  });

  it('refuses a client that offers none of the groups', async () => {
    await expect(negotiatedGroup(port, 'P-256')).rejects.toThrow();
  });
});
