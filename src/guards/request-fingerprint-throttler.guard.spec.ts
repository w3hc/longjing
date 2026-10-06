/* eslint-disable @typescript-eslint/no-unsafe-argument */

import { RequestFingerprintThrottler } from './request-fingerprint-throttler.guard';
import { ThrottlerException } from '@nestjs/throttler';
import { ExecutionContext } from '@nestjs/common';

describe('RequestFingerprintThrottler', () => {
  let guard: RequestFingerprintThrottler;

  beforeEach(() => {
    // Create instance without NestJS DI
    guard = new RequestFingerprintThrottler(
      { throttlers: [{ ttl: 60000, limit: 10 }] },
      null as any,
      null as any,
    );
  });

  it('should be defined', () => {
    expect(guard).toBeDefined();
  });

  describe('getTracker', () => {
    beforeEach(() => {
      // Mock Date.now() to get consistent time windows
      jest.spyOn(Date, 'now').mockReturnValue(1000000000);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should generate a tracker from request body', async () => {
      const req = {
        body: {
          proof: 'test-proof',
          nullifier: '0x123',
        },
      };

      const tracker = await guard['getTracker'](req);

      expect(tracker).toBeDefined();
      expect(typeof tracker).toBe('string');
      expect(tracker).toHaveLength(64); // SHA-256 hex string
    });

    it('should generate same tracker for same body and time window', async () => {
      const req = {
        body: {
          proof: 'test-proof',
          nullifier: '0x123',
        },
      };

      const tracker1 = await guard['getTracker'](req);
      const tracker2 = await guard['getTracker'](req);

      expect(tracker1).toEqual(tracker2);
    });

    it('should generate different tracker for different bodies', async () => {
      const req1 = {
        body: {
          proof: 'test-proof-1',
          nullifier: '0x123',
        },
      };

      const req2 = {
        body: {
          proof: 'test-proof-2',
          nullifier: '0x456',
        },
      };

      const tracker1 = await guard['getTracker'](req1);
      const tracker2 = await guard['getTracker'](req2);

      expect(tracker1).not.toEqual(tracker2);
    });

    it('should generate different tracker for different time windows', async () => {
      const req = {
        body: {
          proof: 'test-proof',
          nullifier: '0x123',
        },
      };

      jest.spyOn(Date, 'now').mockReturnValue(1000000000);
      const tracker1 = await guard['getTracker'](req);

      // Move to next time window (60 seconds later)
      jest.spyOn(Date, 'now').mockReturnValue(1000000000 + 60001);
      const tracker2 = await guard['getTracker'](req);

      expect(tracker1).not.toEqual(tracker2);
    });

    it('should not share a bucket between clients with different bodies', async () => {
      // RequestSanitizerMiddleware pins every client to the same IP
      const req1 = { ip: '0.0.0.0', body: { nullifier: '0x1' } };
      const req2 = { ip: '0.0.0.0', body: { nullifier: '0x2' } };

      const tracker1 = await guard['getTracker'](req1);
      const tracker2 = await guard['getTracker'](req2);

      expect(tracker1).not.toEqual(tracker2);
    });

    it('should handle empty body', async () => {
      const req = { body: {} };

      const tracker = await guard['getTracker'](req);

      expect(tracker).toBeDefined();
      expect(typeof tracker).toBe('string');
      expect(tracker).toHaveLength(64);
    });

    it('should handle missing body', async () => {
      const req = {};

      const tracker = await guard['getTracker'](req);

      expect(tracker).toBeDefined();
      expect(typeof tracker).toBe('string');
      expect(tracker).toHaveLength(64);
    });

    it('should use 1-minute time windows', async () => {
      const req = { body: { test: 'data' } };

      // First time window
      jest.spyOn(Date, 'now').mockReturnValue(0);
      const tracker1 = await guard['getTracker'](req);

      // Same time window (59 seconds later)
      jest.spyOn(Date, 'now').mockReturnValue(59000);
      const tracker2 = await guard['getTracker'](req);

      // Next time window (60 seconds from start)
      jest.spyOn(Date, 'now').mockReturnValue(60000);
      const tracker3 = await guard['getTracker'](req);

      expect(tracker1).toEqual(tracker2);
      expect(tracker1).not.toEqual(tracker3);
    });
  });

  describe('throwThrottlingException', () => {
    it('should throw ThrottlerException with custom message', () => {
      expect(() => guard['throwThrottlingException']()).toThrow(
        ThrottlerException,
      );

      expect(() => guard['throwThrottlingException']()).toThrow(
        'Request temporarily unavailable',
      );
    });
  });

  describe('canActivate', () => {
    const makeContext = (removeHeader: jest.Mock): ExecutionContext =>
      ({
        switchToHttp: () => ({ getResponse: () => ({ removeHeader }) }),
      }) as unknown as ExecutionContext;

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should remove rate limit headers when the request passes', async () => {
      const removeHeader = jest.fn();
      jest
        .spyOn(
          Object.getPrototypeOf(RequestFingerprintThrottler.prototype),
          'canActivate',
        )
        .mockResolvedValue(true);

      await expect(guard.canActivate(makeContext(removeHeader))).resolves.toBe(
        true,
      );
      expect(removeHeader).toHaveBeenCalledWith('X-RateLimit-Remaining');
      expect(removeHeader).toHaveBeenCalledWith('Retry-After');
    });

    it('should remove rate limit headers when the request is throttled', async () => {
      const removeHeader = jest.fn();
      jest
        .spyOn(
          Object.getPrototypeOf(RequestFingerprintThrottler.prototype),
          'canActivate',
        )
        .mockRejectedValue(new ThrottlerException());

      await expect(
        guard.canActivate(makeContext(removeHeader)),
      ).rejects.toThrow(ThrottlerException);
      expect(removeHeader).toHaveBeenCalledWith('Retry-After');
    });
  });
});
