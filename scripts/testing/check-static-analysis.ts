#!/usr/bin/env ts-node
/**
 * Runs Slither on contracts/src or circomspect on circuits/, and fails on any
 * finding missing from the tool's baseline, or on any baseline entry that no
 * longer matches a finding. Every baseline entry carries the reason it is
 * accepted.
 *
 * Usage:
 *   pnpm check:slither      (needs slither and forge on PATH)
 *   pnpm check:circomspect  (needs circomspect on PATH)
 */

import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';

const ROOT = join(__dirname, '../..');

interface Finding {
  check: string;
  file: string;
  location: string;
  description: string;
}

interface BaselineEntry {
  check: string;
  file: string;
  location: string;
  reason: string;
}

interface SlitherElement {
  type: string;
  name: string;
  source_mapping: { filename_relative: string };
  type_specific_fields?: {
    signature?: string;
    parent?: { name: string };
  };
}

interface SlitherOutput {
  success: boolean;
  error: string | null;
  results: {
    detectors?: {
      check: string;
      description: string;
      elements: SlitherElement[];
    }[];
  };
}

interface SarifResult {
  ruleId: string;
  message: { text: string };
  locations: {
    physicalLocation: {
      artifactLocation: { uri: string };
      region: { startLine: number };
    };
  }[];
}

function slither(): Finding[] {
  const cwd = join(ROOT, 'contracts');
  const run = spawnSync(
    'slither',
    ['.', '--config-file', 'slither.config.json', '--json', '-'],
    { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (run.error) throw run.error;
  // Slither exits non-zero whenever it reports findings, so only the JSON says whether it ran
  const out = JSON.parse(run.stdout) as SlitherOutput;
  if (!out.success) {
    throw new Error(`slither failed: ${out.error}\n${run.stderr}`);
  }

  return (out.results.detectors ?? []).map((d) => {
    const e = d.elements[0];
    const name = e.type_specific_fields?.signature ?? e.name;
    const parent = e.type_specific_fields?.parent?.name;
    return {
      check: d.check,
      file: `contracts/${e.source_mapping.filename_relative}`,
      location: parent ? `${parent}.${name}` : name,
      description: d.description.trim().split('\n')[0],
    };
  });
}

function circomspect(): Finding[] {
  const files = execFileSync(
    'git',
    ['ls-files', 'circuits/*.circom', 'circuits/**/*.circom'],
    { cwd: ROOT, encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean);
  const sarif = join(mkdtempSync(join(tmpdir(), 'circomspect-')), 'out.sarif');
  const run = spawnSync('circomspect', ['--sarif-file', sarif, ...files], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (run.error) throw run.error;

  const results = (
    JSON.parse(readFileSync(sarif, 'utf8')) as {
      runs: { results: SarifResult[] }[];
    }
  ).runs.flatMap((r) => r.results);

  // Keyed on the flagged line's text rather than its number, so unrelated edits don't move it
  return results.map((r) => {
    const { artifactLocation, region } = r.locations[0].physicalLocation;
    const path = new URL(artifactLocation.uri).pathname;
    const line = readFileSync(path, 'utf8').split('\n')[region.startLine - 1];
    return {
      check: r.ruleId,
      file: relative(ROOT, path),
      location: line.trim(),
      description: `${r.message.text} (line ${region.startLine})`,
    };
  });
}

const TOOLS: Record<string, { run: () => Finding[]; baseline: string }> = {
  slither: { run: slither, baseline: 'contracts/slither.baseline.json' },
  circomspect: {
    run: circomspect,
    baseline: 'circuits/circomspect.baseline.json',
  },
};

const matches = (f: Finding, b: BaselineEntry) =>
  f.check === b.check && f.file === b.file && f.location === b.location;

function main() {
  const tool = TOOLS[process.argv[2]];
  if (!tool) {
    console.error(
      `usage: check-static-analysis <${Object.keys(TOOLS).join('|')}>`,
    );
    process.exit(2);
  }

  const findings = tool.run();
  const baseline = JSON.parse(
    readFileSync(join(ROOT, tool.baseline), 'utf8'),
  ) as BaselineEntry[];

  const errors: string[] = [];
  for (const b of baseline) {
    if (!b.reason?.trim()) {
      errors.push(`${tool.baseline}: ${b.check} ${b.location} has no reason`);
    }
  }
  const fresh = findings.filter((f) => !baseline.some((b) => matches(f, b)));
  const stale = baseline.filter((b) => !findings.some((f) => matches(f, b)));

  for (const f of fresh) {
    errors.push(
      `new finding ${f.check} in ${f.file}: ${f.description}\n` +
        `    fix it, or add to ${tool.baseline} with a reason:\n` +
        `    ${JSON.stringify({ check: f.check, file: f.file, location: f.location })}`,
    );
  }
  for (const b of stale) {
    errors.push(
      `stale entry in ${tool.baseline}, remove it: ${b.check} ${b.file} ${b.location}`,
    );
  }

  console.log(
    `${findings.length} findings, ${findings.length - fresh.length} baselined, ` +
      `${fresh.length} new, ${stale.length} stale baseline entries`,
  );
  for (const e of errors) console.error(`✗ ${e}`);
  process.exit(errors.length ? 1 : 0);
}

main();
