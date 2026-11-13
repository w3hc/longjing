/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { buildEddsa, buildPoseidon } from 'circomlibjs';
import {
  commitmentOf,
  newNote,
  nullifierAt,
  Signature,
  verifyAccumulatorSignature,
} from './note';
import { FIELD_MODULUS, Point } from '../longjing/accumulator';

const CONTRACT = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

describe('browser client note', () => {
  let poseidon: (inputs: bigint[]) => bigint;
  let eddsa: any;

  beforeAll(async () => {
    const p = await buildPoseidon();
    poseidon = (inputs) => p.F.toObject(p(inputs));
    eddsa = await buildEddsa();
  });

  describe('newNote', () => {
    it('draws a secret key in the field', () => {
      const a = newNote('http://127.0.0.1:8545', CONTRACT);
      const b = newNote('http://127.0.0.1:8545', CONTRACT);
      expect(BigInt(a.secretKey)).toBeLessThan(FIELD_MODULUS);
      expect(a.secretKey).not.toBe(b.secretKey);
      expect(a.opening).toEqual({ refunds: '0', index: '0', blinding: '0' });
    });

    it('takes a secret key from outside', () => {
      expect(newNote('', CONTRACT, 42n).secretKey).toBe('42');
    });

    it.each([0n, FIELD_MODULUS, -1n])('refuses the secret key %s', (k) => {
      expect(() => newNote('', CONTRACT, k)).toThrow('nonzero BN254');
    });
  });

  it('commits and derives nullifiers as circomlibjs does', async () => {
    const note = newNote('', CONTRACT, 123456789n);
    expect(BigInt(await commitmentOf(note))).toBe(poseidon([123456789n]));
    expect(await nullifierAt(note, 3n)).toBe(
      poseidon([poseidon([123456789n, 3n])]),
    );
  });

  describe('verifyAccumulatorSignature', () => {
    const accumulator: Point = [
      5299619240641551281634865583518297030282874472190772894086521144482721001553n,
      16950150798460657717958625567821834550301663161624707787222815936182638968203n,
    ];
    // Signed by circomlibjs 0.1.7's signPoseidon with the key 0x07 × 32
    const key = {
      x: '14422859473778768188622151430526693594403470008420308922992775064941455773685',
      y: '7592518773672929099542717438998516546396504563265155469693554058278098107299',
    };
    const signature: Signature = {
      R8x: '1137481166321477019318334127177513106752171864002862024539750151976944254018',
      R8y: '635687896059770643478499472726709250604887769370930780797670821915540171496',
      S: '1717541783238332189031926241276007176368692469374380221093174258834890865220',
    };

    it('accepts a circomlibjs signature from fixed vectors', () => {
      expect(verifyAccumulatorSignature(accumulator, signature, key)).toBe(
        true,
      );
    });

    it('agrees with circomlibjs on fresh signatures', () => {
      const F = eddsa.F;
      for (const fill of [1, 2, 3]) {
        const prvKey = Buffer.alloc(32, fill);
        const pub = eddsa.prv2pub(prvKey);
        const signed = eddsa.signPoseidon(
          prvKey,
          F.e(poseidon([...accumulator])),
        );
        expect(
          verifyAccumulatorSignature(
            accumulator,
            {
              R8x: F.toObject(signed.R8[0]).toString(),
              R8y: F.toObject(signed.R8[1]).toString(),
              S: signed.S.toString(),
            },
            {
              x: F.toObject(pub[0]).toString(),
              y: F.toObject(pub[1]).toString(),
            },
          ),
        ).toBe(true);
      }
    });

    it('refuses another accumulator, key or signature', () => {
      const other: Point = [accumulator[0], accumulator[1] + 1n];
      expect(verifyAccumulatorSignature(other, signature, key)).toBe(false);
      expect(
        verifyAccumulatorSignature(accumulator, signature, {
          x: key.y,
          y: key.x,
        }),
      ).toBe(false);
      expect(
        verifyAccumulatorSignature(
          accumulator,
          { ...signature, S: (BigInt(signature.S) + 1n).toString() },
          key,
        ),
      ).toBe(false);
    });

    it('refuses a malformed signature', () => {
      expect(
        verifyAccumulatorSignature(
          accumulator,
          { ...signature, S: 'not a number' },
          key,
        ),
      ).toBe(false);
    });
  });
});
