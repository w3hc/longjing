import { execFileSync } from 'child_process';
import { X509Certificate } from 'crypto';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import * as https from 'https';
import { AddressInfo, Server, Socket, connect, createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { nodeTransport } from './transport';

// A throwaway self-signed certificate, made with the openssl CLI at test time
function selfSigned(dir: string, name: string) {
  const key = join(dir, `${name}.key`);
  const cert = join(dir, `${name}.crt`);
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-keyout',
    key,
    '-out',
    cert,
    '-days',
    '1',
    '-subj',
    `/CN=${name}`,
  ]);
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

const listen = (server: Server | https.Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve((server.address() as AddressInfo).port),
    ),
  );

describe('nodeTransport', () => {
  let dir: string;
  let gateway: https.Server;
  let port: number;
  let served: Buffer;
  let other: Buffer;
  let received: { method?: string; url?: string; body: string }[];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'longjing-transport-'));
    const tls = selfSigned(dir, 'gateway');
    served = Buffer.from(new X509Certificate(tls.cert).raw);
    other = Buffer.from(new X509Certificate(selfSigned(dir, 'other').cert).raw);
    gateway = https.createServer(tls, (req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        received.push({ method: req.method, url: req.url, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    port = await listen(gateway);
  });

  afterAll(async () => {
    gateway.closeAllConnections();
    await new Promise((resolve) => gateway.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    received = [];
  });

  it('returns the body and the certificate of the session', async () => {
    const transport = nodeTransport(`https://127.0.0.1:${port}`);

    const res = await transport.request({
      method: 'GET',
      path: '/attestation',
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(Buffer.from(res.certificate!)).toEqual(served);
    expect(transport.secure).toBe(true);
  });

  it('writes nothing when the certificate is not the pinned one', async () => {
    const transport = nodeTransport(`https://127.0.0.1:${port}`);

    await expect(
      transport.request({
        method: 'POST',
        path: '/longjing/request',
        body: '{"secret":1}',
        pinnedCertificate: other,
      }),
    ).rejects.toThrow('a certificate other than the attested one');
    expect(received).toEqual([]);
  });

  it('posts over a pinned session', async () => {
    const transport = nodeTransport(`https://127.0.0.1:${port}`);

    await transport.request({
      method: 'POST',
      path: '/longjing/request',
      body: '{"a":1}',
      pinnedCertificate: served,
    });

    expect(received).toEqual([
      { method: 'POST', url: '/longjing/request', body: '{"a":1}' },
    ]);
  });

  describe('through a SOCKS port', () => {
    let proxy: Server;
    let proxyPort: number;
    let connects: { username: string; host: string; port: number }[];

    /** A SOCKS5 proxy that sends every CONNECT to the gateway */
    const sockets: Socket[] = [];
    const handle = (client: Socket) => {
      sockets.push(client);
      let state = 0;
      let username = '';
      client.on('data', (data: Buffer) => {
        if (state === 0) {
          client.write(Buffer.from([0x05, 0x02]));
          state = 1;
        } else if (state === 1) {
          username = data.subarray(2, 2 + data[1]).toString();
          client.write(Buffer.from([0x01, 0x00]));
          state = 2;
        } else if (state === 2) {
          const length = data[4];
          connects.push({
            username,
            host: data.subarray(5, 5 + length).toString(),
            port: data.readUInt16BE(5 + length),
          });
          state = 3;
          client.removeAllListeners('data');
          const upstream = connect(port, '127.0.0.1', () => {
            sockets.push(upstream);
            client.write(Buffer.from([0x05, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
            client.pipe(upstream).pipe(client);
          });
        }
      });
    };

    beforeAll(async () => {
      proxy = createServer(handle);
      proxyPort = await listen(proxy);
    });

    afterAll(async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise((resolve) => proxy.close(resolve));
    });

    beforeEach(() => {
      connects = [];
    });

    it('sends the host name to tor, with fresh credentials per request', async () => {
      const onion =
        'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwx.onion';
      const transport = nodeTransport(`https://${onion}:${port}`, {
        host: '127.0.0.1',
        port: proxyPort,
      });

      const first = await transport.request({ method: 'GET', path: '/a' });
      await transport.request({ method: 'GET', path: '/b' });

      expect(Buffer.from(first.certificate!)).toEqual(served);
      expect(connects.map(({ host, port: p }) => [host, p])).toEqual([
        [onion, port],
        [onion, port],
      ]);
      expect(connects[0].username).toMatch(/^[0-9a-f]{32}$/);
      expect(connects[0].username).not.toBe(connects[1].username);
      expect(received.map((r) => r.url)).toEqual(['/a', '/b']);
    });

    it('fails closed when the SOCKS port is unreachable', async () => {
      const closed = createServer();
      const closedPort = await listen(closed);
      await new Promise((resolve) => closed.close(resolve));
      const transport = nodeTransport(`https://127.0.0.1:${port}`, {
        host: '127.0.0.1',
        port: closedPort,
      });

      await expect(
        transport.request({ method: 'GET', path: '/a' }),
      ).rejects.toThrow('Tor is configured but its SOCKS port');
      expect(received).toEqual([]);
    });
  });
});
