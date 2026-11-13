/**
 * Node transport to the gateway: one connection per request, the TLS
 * certificate checked before anything is written, and optionally through
 * Tor's SOCKS port with fresh credentials per connection, so tor puts every
 * request on its own circuit (IsolateSOCKSAuth, on by default).
 *
 * See docs/INTEGRATION_GUIDELINES.md.
 */

import { randomBytes } from 'crypto';
import * as http from 'http';
import * as https from 'https';
import { Socket, connect as netConnect } from 'net';
import * as tls from 'tls';
import { TLS_CLIENT_GROUPS } from '../../src/tls/tls-groups';
import type {
  GatewayRequest,
  GatewayResponse,
  GatewayTransport,
} from './gateway';

export interface SocksProxy {
  host: string;
  port: number;
}

const TIMEOUT_MS = 120_000;

/**
 * @param baseUrl The gateway's origin, https:// (or http:// in development)
 * @param socks Tor's SOCKS port. When set, every connection goes through it
 * and fails if it is unreachable: never a direct connection.
 */
export function nodeTransport(
  baseUrl: string,
  socks?: SocksProxy,
): GatewayTransport {
  const url = new URL(baseUrl);
  const secure = url.protocol === 'https:';
  if (!secure && url.protocol !== 'http:') {
    throw new Error(`Unsupported gateway URL ${baseUrl}`);
  }
  const host = url.hostname;
  const port = url.port ? Number(url.port) : secure ? 443 : 80;

  const open = async (pinned?: Uint8Array) => {
    const tcp = socks
      ? await socksConnect(socks, host, port)
      : secure
        ? undefined
        : await tcpConnect(host, port);
    if (!secure) {
      return { socket: tcp!, certificate: null, keyExchange: undefined };
    }
    return tlsConnect(host, port, tcp, pinned);
  };

  return {
    host,
    secure,
    async request(request: GatewayRequest): Promise<GatewayResponse> {
      const { socket, certificate, keyExchange } = await open(
        request.pinnedCertificate,
      );
      const response = await send(
        secure ? https : http,
        socket,
        host,
        port,
        request,
      );
      return { ...response, certificate, keyExchange };
    },
  };
}

function send(
  client: typeof http | typeof https,
  socket: Socket,
  host: string,
  port: number,
  { method, path, body }: GatewayRequest,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        host,
        port,
        method,
        path,
        createConnection: () => socket,
        headers: body
          ? {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(body),
            }
          : undefined,
        timeout: TIMEOUT_MS,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => {
          socket.destroy();
          resolve({ status: res.statusCode ?? 0, body: text });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('Gateway timed out')));
    req.on('error', (error) => {
      socket.destroy();
      reject(error);
    });
    req.end(body);
  });
}

/**
 * Completes the TLS handshake, then, before anything is written, checks the
 * certificate against the pinned one. Trust comes from the attestation, not
 * from a CA, so the chain itself is not verified.
 */
function tlsConnect(
  host: string,
  port: number,
  tcp: Socket | undefined,
  pinned: Uint8Array | undefined,
): Promise<{ socket: Socket; certificate: Buffer; keyExchange?: string }> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      ...(tcp ? { socket: tcp } : { host, port }),
      servername: host,
      rejectUnauthorized: false,
      ecdhCurve: TLS_CLIENT_GROUPS,
    });
    socket.setTimeout(TIMEOUT_MS, () =>
      socket.destroy(new Error('TLS handshake timed out')),
    );
    socket.once('error', reject);
    socket.once('secureConnect', () => {
      socket.off('error', reject);
      socket.setTimeout(0);
      const raw = socket.getPeerCertificate().raw;
      if (!raw) {
        socket.destroy();
        reject(new Error('The gateway presented no certificate'));
        return;
      }
      const certificate = Buffer.from(raw);
      if (pinned && !certificate.equals(Buffer.from(pinned))) {
        socket.destroy();
        reject(
          new Error(
            'The gateway presented a certificate other than the attested one',
          ),
        );
        return;
      }
      const keyExchange = (
        socket.getEphemeralKeyInfo() as { name?: string } | null
      )?.name;
      resolve({ socket, certificate, keyExchange });
    });
  });
}

function tcpConnect(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port }, () => {
      socket.off('error', reject);
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

/**
 * SOCKS5 CONNECT by host name (RFC 1928), with a random username and
 * password (RFC 1929): tor puts streams with different credentials on
 * different circuits. The host name goes to tor, never to a local resolver.
 */
async function socksConnect(
  proxy: SocksProxy,
  host: string,
  port: number,
): Promise<Socket> {
  let socket: Socket;
  try {
    socket = await tcpConnect(proxy.host, proxy.port);
  } catch (error) {
    throw new Error(
      `Tor is configured but its SOCKS port ${proxy.host}:${proxy.port} is unreachable: nothing was sent`,
      { cause: error },
    );
  }
  const reader = new SocketReader(socket);
  try {
    socket.write(Buffer.from([0x05, 0x01, 0x02]));
    const method = await reader.read(2);
    if (method[0] !== 0x05 || method[1] !== 0x02) {
      throw new Error('The SOCKS proxy refused username/password auth');
    }

    const username = Buffer.from(randomBytes(16).toString('hex'));
    const password = Buffer.from(randomBytes(16).toString('hex'));
    socket.write(
      Buffer.concat([
        Buffer.from([0x01, username.length]),
        username,
        Buffer.from([password.length]),
        password,
      ]),
    );
    const auth = await reader.read(2);
    if (auth[1] !== 0x00) {
      throw new Error('The SOCKS proxy refused the credentials');
    }

    const name = Buffer.from(host, 'ascii');
    const portBytes = Buffer.alloc(2);
    portBytes.writeUInt16BE(port);
    socket.write(
      Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
        name,
        portBytes,
      ]),
    );
    const reply = await reader.read(4);
    if (reply[1] !== 0x00) {
      throw new Error(`Tor could not reach ${host} (SOCKS reply ${reply[1]})`);
    }
    const addressLength =
      reply[3] === 0x01
        ? 4
        : reply[3] === 0x04
          ? 16
          : (await reader.read(1))[0];
    await reader.read(addressLength + 2);
    reader.release();
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

/** Reads exact byte counts from a socket during a handshake. */
class SocketReader {
  private buffered = Buffer.alloc(0);
  private wanted: { length: number; resolve: (b: Buffer) => void } | null =
    null;
  private failure: Error | null = null;
  private reject: ((error: Error) => void) | null = null;
  private readonly onData = (chunk: Buffer) => {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    this.drain();
  };
  private readonly onEnd = () =>
    this.fail(new Error('The SOCKS proxy closed the connection'));
  private readonly onError = (error: Error) => this.fail(error);

  constructor(private readonly socket: Socket) {
    socket.on('data', this.onData);
    socket.on('end', this.onEnd);
    socket.on('error', this.onError);
  }

  read(length: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (this.failure) {
        reject(this.failure);
        return;
      }
      this.wanted = { length, resolve };
      this.reject = reject;
      this.drain();
    });
  }

  /**
   * Hands the socket back, paused until its next reader. The gateway speaks
   * only after the client, so nothing may be left unread.
   */
  release(): void {
    this.socket.pause();
    this.socket.off('data', this.onData);
    this.socket.off('end', this.onEnd);
    this.socket.off('error', this.onError);
    if (this.buffered.length > 0) {
      throw new Error('The SOCKS proxy sent data before the gateway');
    }
  }

  private drain(): void {
    if (this.wanted && this.buffered.length >= this.wanted.length) {
      const { length, resolve } = this.wanted;
      this.wanted = null;
      const bytes = this.buffered.subarray(0, length);
      this.buffered = this.buffered.subarray(length);
      resolve(bytes);
    }
  }

  private fail(error: Error): void {
    this.failure = error;
    this.reject?.(error);
  }
}
