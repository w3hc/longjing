#!/usr/bin/env ts-node

/**
 * Downloads the circuit artifacts listed in circuits/artifacts.json into
 * circuits/build/ and checks each one against its pinned sha256.
 *
 * Usage:
 *   pnpm circuits:fetch
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';

const CIRCUITS_DIR = join(__dirname, '../../circuits');
const BUILD_DIR = join(CIRCUITS_DIR, 'build');

interface Manifest {
  release: string;
  files: Record<string, string>;
}

const manifest = JSON.parse(
  readFileSync(join(CIRCUITS_DIR, 'artifacts.json'), 'utf8'),
) as Manifest;

const sha256 = (data: Buffer) =>
  createHash('sha256').update(data).digest('hex');

async function fetchArtifact(path: string, hash: string): Promise<void> {
  const target = join(BUILD_DIR, path);

  if (existsSync(target) && sha256(readFileSync(target)) === hash) {
    console.log(`✓ ${path}`);
    return;
  }

  const url = `${manifest.release}/${basename(path)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }

  const data = Buffer.from(await response.arrayBuffer());
  const actual = sha256(data);
  if (actual !== hash) {
    throw new Error(`${path}: expected sha256 ${hash}, got ${actual}`);
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, data);
  console.log(`↓ ${path}`);
}

async function main(): Promise<void> {
  for (const [path, hash] of Object.entries(manifest.files)) {
    await fetchArtifact(path, hash);
  }
}

main().catch((error: Error) => {
  console.error(`✗ ${error.message}`);
  process.exit(1);
});
