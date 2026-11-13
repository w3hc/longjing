#!/usr/bin/env ts-node
/**
 * Builds the browser client into build/browser/, one file per format, each
 * self-contained so a page can inline it:
 *   longjing-client.js   IIFE, defines the global `Longjing`
 *   longjing-client.mjs  ES module
 *   SHA256SUMS           their sha256, as the release publishes them
 *
 * The prover worker, with snarkjs, is bundled first and inlined as a string,
 * so proving needs no second file. The build fails if anything pulls in a
 * Node built-in module.
 *
 * Usage: pnpm build:browser
 */

import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { builtinModules } from 'module';
import { join } from 'path';
import { build, BuildOptions, Metafile, Plugin } from 'esbuild';

const ROOT = join(__dirname, '../..');
const OUT = join(ROOT, 'build/browser');
const FILES = ['longjing-client.js', 'longjing-client.mjs'];

const BUILTINS = new Set(
  builtinModules.flatMap((name) => [name, `node:${name}`]),
);

const common = {
  bundle: true,
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  legalComments: 'inline',
  metafile: true as const,
  write: false as const,
  logLevel: 'warning',
  absWorkingDir: ROOT,
  define: { 'process.env.NODE_ENV': '"production"' },
} satisfies BuildOptions;

/** Refuses a bundle that imports a Node built-in, even an empty shim */
function assertNoNodeBuiltins(metafile: Metafile, what: string): void {
  const used = Object.values(metafile.inputs)
    .flatMap((input) => input.imports.map((i) => i.path))
    .filter((path) => BUILTINS.has(path));
  if (used.length > 0) {
    throw new Error(`${what} imports Node modules: ${[...new Set(used)]}`);
  }
}

function inlineWorker(source: string): Plugin {
  return {
    name: 'inline-prover-worker',
    setup(b) {
      b.onResolve({ filter: /^longjing:prover-worker$/ }, (args) => ({
        path: args.path,
        namespace: 'prover-worker',
      }));
      b.onLoad({ filter: /.*/, namespace: 'prover-worker' }, () => ({
        contents: source,
        loader: 'text',
      }));
    },
  };
}

async function main() {
  const worker = await build({
    ...common,
    entryPoints: ['src/client/prover-worker.ts'],
    format: 'iife',
  });
  assertNoNodeBuiltins(worker.metafile, 'The prover worker');
  const workerSource = worker.outputFiles[0].text;

  mkdirSync(OUT, { recursive: true });
  for (const [file, format] of [
    [FILES[0], 'iife'],
    [FILES[1], 'esm'],
  ] as const) {
    const result = await build({
      ...common,
      entryPoints: ['src/client/browser.ts'],
      format,
      globalName: format === 'iife' ? 'Longjing' : undefined,
      plugins: [inlineWorker(workerSource)],
    });
    assertNoNodeBuiltins(result.metafile, file);
    writeFileSync(join(OUT, file), result.outputFiles[0].contents);
  }

  const sums = FILES.map((file) => {
    const hash = createHash('sha256')
      .update(readFileSync(join(OUT, file)))
      .digest('hex');
    return `${hash}  ${file}\n`;
  }).join('');
  writeFileSync(join(OUT, 'SHA256SUMS'), sums);
  for (const file of FILES) {
    const kib = Math.round(readFileSync(join(OUT, file)).length / 1024);
    console.log(`build/browser/${file}  ${kib} KiB`);
  }
  process.stdout.write(sums);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
