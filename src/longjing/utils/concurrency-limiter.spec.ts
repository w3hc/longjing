import { ServiceUnavailableException } from '@nestjs/common';
import { ConcurrencyLimiter } from './concurrency-limiter';

describe('ConcurrencyLimiter', () => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  };

  it('runs tasks up to the cap and rejects the next one with 503', async () => {
    const limiter = new ConcurrencyLimiter(2);
    const gate = deferred();

    const first = limiter.run(() => gate.promise);
    const second = limiter.run(() => gate.promise);

    await expect(limiter.run(() => Promise.resolve())).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(limiter.running).toBe(2);

    gate.resolve();
    await Promise.all([first, second]);
    expect(limiter.running).toBe(0);
  });

  it('frees the slot when a task throws', async () => {
    const limiter = new ConcurrencyLimiter(1);

    await expect(
      limiter.run(() => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');

    await expect(limiter.run(() => Promise.resolve(42))).resolves.toBe(42);
  });

  it.each([0, -1, 1.5, NaN])('refuses a limit of %p', (max) => {
    expect(() => new ConcurrencyLimiter(max)).toThrow();
  });
});
