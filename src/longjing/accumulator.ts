import { createHash } from 'crypto';

/**
 * Baby Jubjub arithmetic for the refund accumulator of docs/SETTLEMENT.md:
 * A = R·G + m·J + c·K + s·H, with generators hashed to the curve from
 * public seeds so nobody knows a discrete log between them.
 */

export const FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const SUBGROUP_ORDER =
  2736030358979909402780800718157159386076813972158567259200215660948447373041n;

const A = 168700n;
const D = 168696n;
const COFACTOR = 8n;

export type Point = readonly [bigint, bigint];

export const IDENTITY: Point = [0n, 1n];

const mod = (x: bigint): bigint =>
  ((x % FIELD_MODULUS) + FIELD_MODULUS) % FIELD_MODULUS;

function pow(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % FIELD_MODULUS;
    b = (b * b) % FIELD_MODULUS;
    e >>= 1n;
  }
  return result;
}

const inv = (x: bigint): bigint => pow(x, FIELD_MODULUS - 2n);

// Tonelli-Shanks, or undefined when x is not a square
function sqrt(x: bigint): bigint | undefined {
  const n = mod(x);
  if (n === 0n) return 0n;
  if (pow(n, (FIELD_MODULUS - 1n) / 2n) !== 1n) return undefined;

  let q = FIELD_MODULUS - 1n;
  let s = 0n;
  while (!(q & 1n)) {
    q >>= 1n;
    s++;
  }
  let z = 2n;
  while (pow(z, (FIELD_MODULUS - 1n) / 2n) === 1n) z++;

  let m = s;
  let c = pow(z, q);
  let t = pow(n, q);
  let r = pow(n, (q + 1n) / 2n);
  while (t !== 1n) {
    let i = 0n;
    let t2 = t;
    while (t2 !== 1n) {
      t2 = (t2 * t2) % FIELD_MODULUS;
      i++;
    }
    const b = pow(c, 1n << (m - i - 1n));
    m = i;
    c = (b * b) % FIELD_MODULUS;
    t = (t * c) % FIELD_MODULUS;
    r = (r * b) % FIELD_MODULUS;
  }
  return r;
}

export function addPoints(p: Point, q: Point): Point {
  const [x1, y1] = p;
  const [x2, y2] = q;
  const k = mod(D * x1 * x2 * y1 * y2);
  return [
    mod((x1 * y2 + y1 * x2) * inv(1n + k)),
    mod((y1 * y2 - A * x1 * x2) * inv(1n - k)),
  ];
}

export function mulPoint(p: Point, scalar: bigint): Point {
  let result = IDENTITY;
  let base = p;
  for (let e = scalar; e > 0n; e >>= 1n) {
    if (e & 1n) result = addPoints(result, base);
    base = addPoints(base, base);
  }
  return result;
}

export const isOnCurve = ([x, y]: Point): boolean =>
  mod(A * x * x + y * y) === mod(1n + D * x * x * y * y);

export const isIdentity = ([x, y]: Point): boolean => x === 0n && y === 1n;

export const inSubgroup = (p: Point): boolean =>
  isOnCurve(p) && isIdentity(mulPoint(p, SUBGROUP_ORDER));

/**
 * Try-and-increment: x = sha256(seed ‖ counter) mod p until x is on the
 * curve, take the smaller y, then clear the cofactor
 */
export function hashToCurve(seed: string): Point {
  for (let counter = 0; ; counter++) {
    const tag = Buffer.alloc(4);
    tag.writeUInt32BE(counter);
    const digest = createHash('sha256')
      .update(Buffer.concat([Buffer.from(seed), tag]))
      .digest('hex');
    const x = mod(BigInt(`0x${digest}`));
    const y = sqrt((1n - A * x * x) * inv(1n - D * x * x));
    if (y === undefined) continue;
    const point = mulPoint(
      [x, y < FIELD_MODULUS - y ? y : FIELD_MODULUS - y],
      COFACTOR,
    );
    if (!isIdentity(point)) return point;
  }
}

export const GENERATOR_SEEDS = {
  G: 'longjing/accumulator/G',
  J: 'longjing/accumulator/J',
  K: 'longjing/accumulator/K',
  H: 'longjing/accumulator/H',
} as const;

export type Generators = Record<keyof typeof GENERATOR_SEEDS, Point>;

let generators: Generators | undefined;

export function accumulatorGenerators(): Generators {
  generators ??= {
    G: hashToCurve(GENERATOR_SEEDS.G),
    J: hashToCurve(GENERATOR_SEEDS.J),
    K: hashToCurve(GENERATOR_SEEDS.K),
    H: hashToCurve(GENERATOR_SEEDS.H),
  };
  return generators;
}

/** What an accumulator opens to: refunds, next index, note commitment, blinding */
export interface Opening {
  refunds: bigint;
  index: bigint;
  commitment: bigint;
  blinding: bigint;
}

export function commit({
  refunds,
  index,
  commitment,
  blinding,
}: Opening): Point {
  const { G, J, K, H } = accumulatorGenerators();
  return [
    mulPoint(G, refunds),
    mulPoint(J, index),
    mulPoint(K, commitment),
    mulPoint(H, blinding),
  ].reduce(addPoints);
}

/** The genesis accumulator c·K, which needs no signature */
export const genesis = (commitment: bigint): Point =>
  commit({ refunds: 0n, index: 0n, commitment, blinding: 0n });

/** A_pub = A + s'·H, what a request proof reveals */
export const rerandomize = (accumulator: Point, blinding: bigint): Point =>
  addPoints(accumulator, mulPoint(accumulatorGenerators().H, blinding));

/** A' = A_pub + v·G + J, what the server signs after a request */
export function applyRefund(accumulator: Point, refund: bigint): Point {
  const { G, J } = accumulatorGenerators();
  return addPoints(addPoints(accumulator, mulPoint(G, refund)), J);
}
