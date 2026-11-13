// SPDX-License-Identifier: LGPL-3.0
// Copyright (C) 2026 Julien Béranger and the W3HC

import { spawn } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { Socket, connect } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { OnionKey, onionAddress } from './onion-key';

export interface OnionServiceOptions {
  key: OnionKey;
  virtualPort: number;
  /** host:port the onion service forwards to */
  target: string;
  /** tor, then arguments placed before Longjing's */
  command?: string[];
  /** Extra tor options, e.g. ['--DisableNetwork', '1'] in tests */
  extraArgs?: string[];
  startTimeoutMs?: number;
}

export interface RunningOnionService {
  /** The 56-character address tor answered, without ".onion" */
  serviceId: string;
  /** Resolves when tor exits, with its exit code */
  exited: Promise<number | null>;
  stop(): void;
}

/**
 * Starts tor and adds a v3 onion service with the given key over tor's
 * control socket, so the key never touches disk. tor exits when the control
 * connection closes or this process exits.
 *
 * See docs/ONION_SERVICE.md.
 */
export async function startOnionService(
  options: OnionServiceOptions,
): Promise<RunningOnionService> {
  const dir = mkdtempSync(join(tmpdir(), 'longjing-tor-'));
  const controlSocket = join(dir, 'control');
  const cookieFile = join(dir, 'control.authcookie');
  const [binary, ...prefix] = options.command ?? ['tor'];

  const tor = spawn(
    binary,
    [
      ...prefix,
      // No torrc: every option is on this command line
      '--defaults-torrc',
      join(dir, 'torrc-defaults'),
      '-f',
      join(dir, 'torrc'),
      '--ignore-missing-torrc',
      '--DataDirectory',
      join(dir, 'data'),
      '--SocksPort',
      '0',
      '--ControlSocket',
      controlSocket,
      '--CookieAuthentication',
      '1',
      '--CookieAuthFile',
      cookieFile,
      '--__OwningControllerProcess',
      String(process.pid),
      '--SafeLogging',
      '1',
      '--AvoidDiskWrites',
      '1',
      '--Log',
      'warn stderr',
      ...(options.extraArgs ?? []),
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const exited = new Promise<number | null>((resolve) => {
    tor.once('exit', (code) => resolve(code));
    tor.once('error', () => resolve(null));
  });

  let control: TorControl | undefined;
  const stop = () => {
    control?.close();
    if (tor.exitCode === null) {
      tor.kill('SIGTERM');
    }
  };
  void exited.then(() => rmSync(dir, { recursive: true, force: true }));

  try {
    await waitForFiles(
      [controlSocket, cookieFile],
      exited,
      options.startTimeoutMs ?? 30_000,
    );
    control = await connectWhenListening(
      controlSocket,
      exited,
      options.startTimeoutMs ?? 30_000,
    );
    await control.command(
      `AUTHENTICATE ${readFileSync(cookieFile).toString('hex')}`,
    );
    // tor now exits when this connection closes
    await control.command('TAKEOWNERSHIP');
    await control.command('RESETCONF __OwningControllerProcess');

    const expected = onionAddress(options.key.publicKey);
    // base64 leaves an immutable string copy of the key, which only lives
    // until garbage collection; the control socket is the only way to hand
    // tor a key without writing it to disk
    const reply = await control.command(
      `ADD_ONION ED25519-V3:${options.key.expandedSecretKey.toString('base64')} ` +
        `Port=${options.virtualPort},${options.target}`,
    );
    const serviceId = reply
      .map((line) => /^ServiceID=([a-z2-7]+)$/.exec(line)?.[1])
      .find(Boolean);
    if (serviceId !== expected) {
      throw new Error(
        `tor added onion service ${serviceId ?? '(none)'}, not ${expected}`,
      );
    }
    return { serviceId, exited, stop };
  } catch (error) {
    stop();
    throw error;
  }
}

async function waitForFiles(
  paths: string[],
  exited: Promise<number | null>,
  timeoutMs: number,
): Promise<void> {
  let gone = false;
  void exited.then(() => (gone = true));
  const deadline = Date.now() + timeoutMs;
  while (!paths.every((path) => existsSync(path))) {
    if (gone) {
      throw new Error('tor exited before it opened its control socket');
    }
    if (Date.now() > deadline) {
      throw new Error(`tor did not open its control socket in ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** tor may create the socket file a moment before it accepts connections */
async function connectWhenListening(
  path: string,
  exited: Promise<number | null>,
  timeoutMs: number,
): Promise<TorControl> {
  let gone = false;
  void exited.then(() => (gone = true));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await TorControl.connect(path);
    } catch (error) {
      if (gone || Date.now() > deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/**
 * A minimal client for tor's control protocol: one command at a time, each
 * reply read up to its final "<code> " line.
 * https://spec.torproject.org/control-spec/protocol-outline.html
 */
class TorControl {
  private buffer = '';
  private lines: string[] = [];
  private waiting: ((lines: string[]) => void) | null = null;
  private failed: ((error: Error) => void) | null = null;

  private constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.receive(chunk));
    socket.on('error', (error) => this.failed?.(error));
    socket.on('close', () =>
      this.failed?.(new Error('tor closed the control connection')),
    );
  }

  static connect(path: string): Promise<TorControl> {
    return new Promise((resolve, reject) => {
      const socket = connect(path, () => {
        socket.off('error', reject);
        resolve(new TorControl(socket));
      });
      socket.once('error', reject);
    });
  }

  /** Sends a command and returns its reply lines, without the status code. */
  command(line: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      this.waiting = (lines) => {
        const status = lines[lines.length - 1].slice(0, 3);
        if (status === '250') {
          resolve(lines.map((reply) => reply.slice(4)));
        } else {
          // Only the command word: ADD_ONION's arguments hold the key
          reject(
            new Error(
              `tor refused ${line.split(' ')[0]}: ${lines.join(' | ')}`,
            ),
          );
        }
      };
      this.failed = reject;
      this.socket.write(`${line}\r\n`);
    });
  }

  close(): void {
    this.failed = null;
    this.socket.destroy();
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf('\r\n')) !== -1) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      this.lines.push(line);
      if (/^\d{3} /.test(line)) {
        const lines = this.lines;
        this.lines = [];
        const waiting = this.waiting;
        this.waiting = null;
        waiting?.(lines);
      }
    }
  }
}
