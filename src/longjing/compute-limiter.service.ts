import { Injectable } from '@nestjs/common';
import { ConcurrencyLimiter } from './utils/concurrency-limiter';

export const DEFAULT_MAX_CONCURRENT_VERIFICATIONS = 8;
export const DEFAULT_MAX_CONCURRENT_PROOFS = 2;

function limitFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  return value ? Number(value) : fallback;
}

/**
 * Concurrency caps on the expensive paths, shared across requests:
 * - verification: the RPC round-trip and Groth16 pairing check per request
 * - proving: server-side proof generation for public endpoints
 */
@Injectable()
export class ComputeLimiterService {
  readonly verification = new ConcurrencyLimiter(
    limitFromEnv(
      'MAX_CONCURRENT_VERIFICATIONS',
      DEFAULT_MAX_CONCURRENT_VERIFICATIONS,
    ),
  );

  readonly proving = new ConcurrencyLimiter(
    limitFromEnv('MAX_CONCURRENT_PROOFS', DEFAULT_MAX_CONCURRENT_PROOFS),
  );
}
