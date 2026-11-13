import pinned from '../../circuits/artifacts.json';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '../common/bytes';

/** A circuit file as bytes, a URL to fetch it from, or a function that reads it */
export type ArtifactSource =
  | Uint8Array
  | string
  | URL
  | (() => Uint8Array | Promise<Uint8Array>);

export interface CircuitArtifacts {
  wasm: ArtifactSource;
  zkey: ArtifactSource;
}

/** Where the client takes each circuit's files from: any mirror or local copy */
export interface Artifacts {
  request: CircuitArtifacts;
  settlement: CircuitArtifacts;
}

export type Circuit = keyof Artifacts;

/** The sha256 of every circuit file, from circuits/artifacts.json */
export const ARTIFACT_HASHES: Readonly<Record<string, string>> = pinned.files;

/** The release the pinned files are published in */
export const ARTIFACT_RELEASE: string = pinned.release;

export const artifactName = (circuit: Circuit, kind: 'wasm' | 'zkey') =>
  kind === 'wasm' ? `${circuit}_js/${circuit}.wasm` : `${circuit}.zkey`;

export class ArtifactMismatch extends Error {
  constructor(
    readonly artifact: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `${artifact} doesn't match circuits/artifacts.json: expected sha256 ${expected}, got ${actual}. Nothing was proved`,
    );
    this.name = 'ArtifactMismatch';
  }
}

/**
 * Loads a circuit file and checks it against its pinned sha256, before any
 * proof uses it
 * @returns A copy of the file's bytes, which the caller can't change after
 * the check
 */
export async function loadArtifact(
  name: string,
  source: ArtifactSource,
): Promise<Uint8Array> {
  const expected = ARTIFACT_HASHES[name];
  if (!expected) throw new Error(`${name} is not a pinned circuit file`);
  const bytes =
    typeof source === 'function'
      ? new Uint8Array(await source())
      : source instanceof Uint8Array
        ? source.slice()
        : new Uint8Array(await fetchBytes(source));
  const actual = bytesToHex(await digest(bytes));
  if (actual !== expected) throw new ArtifactMismatch(name, expected, actual);
  return bytes;
}

async function fetchBytes(url: string | URL): Promise<ArrayBuffer> {
  const response = await fetch(url, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  if (!response.ok) {
    throw new Error(`Fetching ${String(url)} answered HTTP ${response.status}`);
  }
  return response.arrayBuffer();
}

/** Web Crypto, or a script implementation outside a secure context */
async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  return subtle
    ? new Uint8Array(await subtle.digest('SHA-256', bytes))
    : sha256(bytes);
}
