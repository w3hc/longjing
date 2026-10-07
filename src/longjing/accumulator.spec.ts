import { readFileSync } from 'fs';
import { join } from 'path';
import {
  accumulatorGenerators,
  addPoints,
  applyRefund,
  commit,
  genesis,
  hashToCurve,
  inSubgroup,
  isIdentity,
  mulPoint,
  rerandomize,
  SUBGROUP_ORDER,
} from './accumulator';

// circomlib's Base8, the subgroup generator EdDSA uses
const BASE8 = [
  5299619240641551281634865583518297030282874472190772894086521144482721001553n,
  16950150798460657717958625567821834550301663161624707787222815936182638968203n,
] as const;

describe('accumulator', () => {
  const { G, J, K, H } = accumulatorGenerators();

  it('agrees with circomlib on the curve law', () => {
    expect(inSubgroup(BASE8)).toBe(true);
    expect(isIdentity(mulPoint(BASE8, SUBGROUP_ORDER))).toBe(true);
    expect(mulPoint(BASE8, 3n)).toEqual(
      addPoints(BASE8, addPoints(BASE8, BASE8)),
    );
  });

  it('derives four distinct generators in the prime-order subgroup', () => {
    for (const point of [G, J, K, H]) {
      expect(inSubgroup(point)).toBe(true);
      expect(isIdentity(point)).toBe(false);
    }
    expect(new Set([G, J, K, H].map((p) => p.join())).size).toBe(4);
  });

  it('derives the generators deterministically from their seeds', () => {
    expect(hashToCurve('longjing/accumulator/G')).toEqual(G);
    expect(hashToCurve('longjing/accumulator/X')).not.toEqual(G);
  });

  it('matches the generators the circuits embed', () => {
    const source = readFileSync(
      join(__dirname, '../../circuits/templates/accumulator.circom'),
      'utf8',
    );
    for (const [name, point] of Object.entries({ G, J, K, H })) {
      const body = new RegExp(
        `function GENERATOR_${name}\\(\\) \\{\\s*return \\[\\s*(\\d+),\\s*(\\d+)`,
      ).exec(source);
      expect(body?.slice(1).map(BigInt)).toEqual(point);
    }
  });

  it('starts from c·K', () => {
    expect(genesis(42n)).toEqual(mulPoint(K, 42n));
  });

  it('adds the refund and moves the index without the opening', () => {
    const before = { refunds: 7n, index: 3n, commitment: 42n, blinding: 11n };
    const next = applyRefund(rerandomize(commit(before), 5n), 9n);
    expect(next).toEqual(
      commit({ refunds: 16n, index: 4n, commitment: 42n, blinding: 16n }),
    );
  });

  it('hides the accumulator behind a fresh blinding', () => {
    const accumulator = genesis(42n);
    expect(rerandomize(accumulator, 1n)).not.toEqual(accumulator);
    expect(rerandomize(accumulator, 1n)).not.toEqual(
      rerandomize(accumulator, 2n),
    );
  });
});
