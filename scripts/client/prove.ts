#!/usr/bin/env ts-node
/**
 * Client side of a note (docs/SETTLEMENT.md). The secret key and the
 * accumulator opening stay in a note file on the user's machine.
 *
 * Usage:
 *   pnpm prove note <note.json> <rpcUrl> <contract>
 *     Draws a secret key and writes a new note file. Prints the commitment
 *     to pass to deposit(); the deposit is the note's D.
 *   pnpm prove request <note.json> <payload> [model]
 *     Prints the body for POST /longjing/request and keeps it as pending. Run
 *     again before `receive` to get the same body back for a retry.
 *   pnpm prove receive <note.json> <response.json>
 *     Checks the server's signed accumulator against the key registered
 *     onchain and folds the refund into the opening. Takes the 200 body, or
 *     the 502 body when the provider failed.
 *   pnpm prove withdrawal <note.json> <recipient> [n]
 *     Prints the arguments for initiateWithdrawal. n defaults to the indices
 *     the note used. finalizeWithdrawal pays out after the challenge window.
 *   pnpm prove slashing <signals.json>
 *     Recovers k from two signals with the same nullifier,
 *     { "signal1": { "x", "y" }, "signal2": { "x", "y" } }, and prints the
 *     argument for slash().
 *
 * None of this needs the server: a note exits with the chain alone.
 */

import * as fs from 'fs';
import { ethers } from 'ethers';
import {
  commitmentOf,
  newNote,
  NoteFile,
  proveRequest,
  proveWithdrawal,
  receive,
  RequestResponse,
} from './note';
import { SlashingService } from '../../src/longjing/slashing.service';

function usage(): never {
  console.error(
    'Usage: pnpm prove <note|request|receive|withdrawal|slashing> ...',
  );
  process.exit(1);
}

const readJson = <T>(path: string) =>
  JSON.parse(fs.readFileSync(path, 'utf8')) as T;
const writeNote = (path: string, note: NoteFile) =>
  fs.writeFileSync(path, JSON.stringify(note, null, 2) + '\n', {
    mode: 0o600,
  });

const commands: Record<string, (args: string[]) => Promise<unknown>> = {
  async note([path, rpcUrl, contract]) {
    if (!contract) usage();
    if (fs.existsSync(path)) throw new Error(`${path} already exists`);
    const note = newNote(rpcUrl, contract);
    writeNote(path, note);
    return { commitment: await commitmentOf(note) };
  },

  async request([path, payload, model]) {
    if (payload === undefined) usage();
    const { body, note } = await proveRequest(
      readJson<NoteFile>(path),
      payload,
      model,
    );
    writeNote(path, note);
    return body;
  },

  async receive([path, responsePath]) {
    if (!responsePath) usage();
    const note = await receive(
      readJson<NoteFile>(path),
      readJson<RequestResponse>(responsePath),
    );
    writeNote(path, note);
    return { opening: note.opening };
  },

  async withdrawal([path, recipient, n]) {
    if (!recipient) usage();
    return proveWithdrawal(
      readJson<NoteFile>(path),
      recipient,
      n === undefined ? undefined : BigInt(n),
    );
  },

  slashing([path]) {
    if (!path) usage();
    const { signal1, signal2 } = readJson<{
      signal1: { x: string; y: string };
      signal2: { x: string; y: string };
    }>(path);
    const point = (s: { x: string; y: string }) => ({
      x: BigInt(s.x),
      y: BigInt(s.y),
    });
    const k = SlashingService.recoverSecretKey(point(signal1), point(signal2));
    return Promise.resolve({ secretKey: ethers.toBeHex(k, 32) });
  },
};

async function main() {
  const [kind, ...args] = process.argv.slice(2);
  if (!(kind in commands)) usage();
  console.log(JSON.stringify(await commands[kind](args), null, 2));
  // snarkjs keeps worker threads alive
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
