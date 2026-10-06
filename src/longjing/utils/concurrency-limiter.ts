import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Caps how many tasks run at once. A task over the cap is rejected right away
 * with 503 rather than queued, so a flood of requests can't pile up work.
 */
export class ConcurrencyLimiter {
  private active = 0;

  constructor(readonly max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(`Concurrency limit must be a positive integer: ${max}`);
    }
  }

  get running(): number {
    return this.active;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      throw new ServiceUnavailableException('Server busy, retry later');
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
    }
  }
}
