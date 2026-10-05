import { X509Certificate } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import { getAddress } from 'ethers';
import { DstackV1Client } from './dstack-v1.client';

const TEST_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIBhDCCASmgAwIBAgIUQKhCch4cCedvNFLRLYnLZI5uaiwwCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLd3Vsb25nLXRlc3QwIBcNMjYwOTI5MTY0NjU2WhgPMjEyNjA5
MDUxNjQ2NTZaMBYxFDASBgNVBAMMC3d1bG9uZy10ZXN0MFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAE308vcOnO7c2IhpMSO/zRw5dyWJsnNpxwWWmMChFRCQqc15Gu
gTV9Dy9Ygd8W/WVeFUlJcA4mkJs4jH+/kRogWKNTMFEwHQYDVR0OBBYEFC/8SlZH
KEg2r+1JC6sorZK40o2cMB8GA1UdIwQYMBaAFC/8SlZHKEg2r+1JC6sorZK40o2c
MA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSQAwRgIhAISqc4fhk0re+9m2
K+2VHo25+h0ACfPQWaoekB+xTvGrAiEAr8cEk4fd6A+CZiJIKRKBXKBa20jQi9PO
XbHSk+gVyuo=
-----END CERTIFICATE-----`;

describe('DstackV1Client', () => {
  let server: http.Server;
  let tmpDir: string;
  let requests: { url?: string; body: unknown }[];
  let reply: { status: number; body: string };

  const listen = (target: string | number) =>
    new Promise<void>((resolve) => server.listen(target, resolve));

  beforeEach(() => {
    requests = [];
    reply = {
      status: 200,
      body: JSON.stringify({
        key: 'aa'.repeat(32),
        public_key: '02' + 'bb'.repeat(32),
        signature_chain: ['cc'.repeat(65), 'dd'.repeat(65)],
      }),
    };
    server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => {
        requests.push({ url: req.url, body: data ? JSON.parse(data) : null });
        res.writeHead(reply.status, { 'Content-Type': 'application/json' });
        res.end(reply.body);
      });
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dstack-'));
  });

  afterEach(async () => {
    delete process.env.DSTACK_SIMULATOR_ENDPOINT;
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads the app id from Info as a checksummed address', async () => {
    const socket = path.join(tmpDir, 'dstack.sock');
    await listen(socket);
    process.env.DSTACK_SIMULATOR_ENDPOINT = socket;
    reply.body = JSON.stringify({
      app_id: 'ab'.repeat(20),
      instance_id: '',
      app_cert: '',
      tcb_info: '{}',
      app_name: 'longjing',
    });

    const appId = await new DstackV1Client().getAppId();

    expect(appId).toBe(getAddress('0x' + 'ab'.repeat(20)));
    expect(requests[0].url).toMatch(/Info$/);
  });

  it('calls /v1/GetKey over a unix socket and decodes the response', async () => {
    const socket = path.join(tmpDir, 'dstack.sock');
    await listen(socket);
    process.env.DSTACK_SIMULATOR_ENDPOINT = socket;

    const client = new DstackV1Client();
    const result = await client.getKey('longjing/test/v1', 'ed25519');

    expect(requests).toEqual([
      {
        url: '/v1/GetKey',
        body: { domain: 'longjing/test/v1', algorithm: 'ed25519' },
      },
    ]);
    expect(Buffer.from(result.key).toString('hex')).toBe('aa'.repeat(32));
    expect(result.publicKey).toHaveLength(33);
    expect(result.signatureChain).toHaveLength(2);
    expect(client.isSimulator()).toBe(true);
  });

  it('calls /v1/GetKey over http when the endpoint is a URL', async () => {
    await listen(0);
    const { port } = server.address() as AddressInfo;
    process.env.DSTACK_SIMULATOR_ENDPOINT = `http://127.0.0.1:${port}`;

    await new DstackV1Client().getKey('d', 'secp256k1');

    expect(requests[0].url).toBe('/v1/GetKey');
  });

  it('uses the dstack socket when no simulator is configured', () => {
    expect(new DstackV1Client().isSimulator()).toBe(false);
  });

  it('rejects when the agent has no v1 surface', async () => {
    const socket = path.join(tmpDir, 'dstack.sock');
    await listen(socket);
    process.env.DSTACK_SIMULATOR_ENDPOINT = socket;
    reply = { status: 404, body: 'Not Found' };

    await expect(new DstackV1Client().getKey('d', 'ed25519')).rejects.toThrow(
      '/v1/GetKey failed (404)',
    );
  });

  it('rejects malformed hex instead of truncating it', async () => {
    const socket = path.join(tmpDir, 'dstack.sock');
    await listen(socket);
    process.env.DSTACK_SIMULATOR_ENDPOINT = socket;
    reply = {
      status: 200,
      body: JSON.stringify({
        key: 'aazz',
        public_key: '02',
        signature_chain: [],
      }),
    };

    await expect(new DstackV1Client().getKey('d', 'ed25519')).rejects.toThrow(
      'malformed key',
    );
  });

  it('requests a RA-TLS server certificate and decodes the leaf', async () => {
    const socket = path.join(tmpDir, 'dstack.sock');
    await listen(socket);
    process.env.DSTACK_SIMULATOR_ENDPOINT = socket;
    reply.body = JSON.stringify({
      key: 'KEY_PEM',
      certificate_chain: [TEST_CERTIFICATE, TEST_CERTIFICATE],
    });

    const result = await new DstackV1Client().getTlsKey([
      'app-3000s.example.com',
    ]);

    expect(requests).toEqual([
      {
        url: '/GetTlsKey',
        body: {
          subject: 'app-3000s.example.com',
          alt_names: ['app-3000s.example.com'],
          usage_ra_tls: true,
          usage_server_auth: true,
          usage_client_auth: false,
        },
      },
    ]);
    expect(result.key).toBe('KEY_PEM');
    expect(result.certificateChain).toHaveLength(2);
    expect(Buffer.from(result.leafCertificateDer)).toEqual(
      new X509Certificate(TEST_CERTIFICATE).raw,
    );
  });

  it('rejects a TLS key response without a certificate chain', async () => {
    const socket = path.join(tmpDir, 'dstack.sock');
    await listen(socket);
    process.env.DSTACK_SIMULATOR_ENDPOINT = socket;
    reply.body = JSON.stringify({ key: 'KEY_PEM', certificate_chain: [] });

    await expect(new DstackV1Client().getTlsKey([])).rejects.toThrow(
      'no key or certificate_chain',
    );
  });

  it('requests a quote over hex report_data and decodes it', async () => {
    const socket = path.join(tmpDir, 'dstack.sock');
    await listen(socket);
    process.env.DSTACK_SIMULATOR_ENDPOINT = socket;
    reply.body = JSON.stringify({
      quote: '0x' + 'ee'.repeat(632),
      event_log: '[]',
      report_data: '11'.repeat(64),
      vm_config: '{}',
    });

    const result = await new DstackV1Client().getQuote(Buffer.alloc(64, 0x11));

    expect(requests).toEqual([
      { url: '/GetQuote', body: { report_data: '11'.repeat(64) } },
    ]);
    expect(Buffer.from(result.quote)).toEqual(Buffer.alloc(632, 0xee));
    expect(result.eventLog).toBe('[]');
  });

  it('refuses report_data longer than 64 bytes', async () => {
    await expect(
      new DstackV1Client().getQuote(Buffer.alloc(65)),
    ).rejects.toThrow('at most 64 bytes');
  });

  it('rejects a quote response without an event log', async () => {
    const socket = path.join(tmpDir, 'dstack.sock');
    await listen(socket);
    process.env.DSTACK_SIMULATOR_ENDPOINT = socket;
    reply.body = JSON.stringify({ quote: 'ee' });

    await expect(
      new DstackV1Client().getQuote(Buffer.alloc(64)),
    ).rejects.toThrow('no event_log');
  });

  it('rejects when the socket is unreachable', async () => {
    process.env.DSTACK_SIMULATOR_ENDPOINT = path.join(tmpDir, 'missing.sock');

    await expect(new DstackV1Client().getKey('d', 'ed25519')).rejects.toThrow();
  });
});
