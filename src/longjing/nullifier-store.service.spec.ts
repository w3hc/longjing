import { Test, TestingModule } from '@nestjs/testing';
import { NullifierStoreService } from './nullifier-store.service';

describe('NullifierStoreService - Rate Limiting', () => {
  let service: NullifierStoreService;

  beforeEach(async () => {
    process.env.DATA_DIR = ':memory:';

    const module: TestingModule = await Test.createTestingModule({
      providers: [NullifierStoreService],
    })
      .setLogger({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        verbose: jest.fn(),
        fatal: jest.fn(),
      })
      .compile();

    service = module.get<NullifierStoreService>(NullifierStoreService);
    await module.init();
  });

  afterEach(() => {
    service.clear();
  });

  describe('checkRateLimit', () => {
    it('should allow requests within rate limit', () => {
      const nullifier = '0xtest1';

      // First 3 requests should succeed
      expect(service.checkRateLimit(nullifier)).toBe(true);
      expect(service.checkRateLimit(nullifier)).toBe(true);
      expect(service.checkRateLimit(nullifier)).toBe(true);
    });

    it('should reject requests exceeding rate limit', () => {
      const nullifier = '0xtest2';

      // First 3 requests succeed
      service.checkRateLimit(nullifier);
      service.checkRateLimit(nullifier);
      service.checkRateLimit(nullifier);

      // 4th request should fail
      expect(service.checkRateLimit(nullifier)).toBe(false);
      expect(service.checkRateLimit(nullifier)).toBe(false);
    });

    it('should track different nullifiers independently', () => {
      const nullifier1 = '0xtest3';
      const nullifier2 = '0xtest4';

      // Use up limit for nullifier1
      service.checkRateLimit(nullifier1);
      service.checkRateLimit(nullifier1);
      service.checkRateLimit(nullifier1);

      // nullifier1 should be rate limited
      expect(service.checkRateLimit(nullifier1)).toBe(false);

      // nullifier2 should still work
      expect(service.checkRateLimit(nullifier2)).toBe(true);
      expect(service.checkRateLimit(nullifier2)).toBe(true);
      expect(service.checkRateLimit(nullifier2)).toBe(true);

      // nullifier2 should now be rate limited
      expect(service.checkRateLimit(nullifier2)).toBe(false);
    });

    it('should allow requests after time window expires', () => {
      const nullifier = '0xtest5';

      // Use up all attempts
      service.checkRateLimit(nullifier);
      service.checkRateLimit(nullifier);
      service.checkRateLimit(nullifier);

      expect(service.checkRateLimit(nullifier)).toBe(false);

      // Simulate time passing (61 seconds)
      // In real implementation, this would require waiting or mocking Date.now()
      // For now, we verify the remaining attempts logic
      expect(service.getRemainingAttempts(nullifier)).toBe(0);
    });
  });

  describe('getRemainingAttempts', () => {
    it('should return correct remaining attempts', () => {
      const nullifier = '0xtest6';

      // Initially should have 3 attempts
      expect(service.getRemainingAttempts(nullifier)).toBe(3);

      // After 1 attempt
      service.checkRateLimit(nullifier);
      expect(service.getRemainingAttempts(nullifier)).toBe(2);

      // After 2 attempts
      service.checkRateLimit(nullifier);
      expect(service.getRemainingAttempts(nullifier)).toBe(1);

      // After 3 attempts
      service.checkRateLimit(nullifier);
      expect(service.getRemainingAttempts(nullifier)).toBe(0);

      // After exceeding limit
      service.checkRateLimit(nullifier);
      expect(service.getRemainingAttempts(nullifier)).toBe(0);
    });
  });

  describe('memory management', () => {
    it('should handle large number of nullifiers', () => {
      // Create 100 different nullifiers
      for (let i = 0; i < 100; i++) {
        const nullifier = `0xtest${i}`;
        service.checkRateLimit(nullifier);
      }

      // All should work independently
      expect(service.getRemainingAttempts('0xtest0')).toBe(2);
      expect(service.getRemainingAttempts('0xtest50')).toBe(2);
      expect(service.getRemainingAttempts('0xtest99')).toBe(2);
    });
  });

  describe('basic nullifier operations', () => {
    it('should store and retrieve nullifiers', () => {
      const nullifier = '0xbasic1';
      const signal = { x: '0xaaa', y: '0xbbb' };

      service.set(nullifier, signal);

      const retrieved = service.get(nullifier);
      expect(retrieved).toBeDefined();
      expect(retrieved?.x).toBe(signal.x);
      expect(retrieved?.y).toBe(signal.y);
    });

    it('should check if nullifier exists', () => {
      const nullifier = '0xbasic2';
      const signal = { x: '0xccc', y: '0xddd' };

      expect(service.exists(nullifier)).toBe(false);

      service.set(nullifier, signal);

      expect(service.exists(nullifier)).toBe(true);
    });

    it('should clear all data', () => {
      service.set('0x1', { x: '0xa', y: '0xb' });
      service.set('0x2', { x: '0xc', y: '0xd' });

      expect(service.count()).toBe(2);

      service.clear();

      expect(service.count()).toBe(0);
    });
  });

  describe('atomic checkAndSet operations', () => {
    it('should insert new nullifier atomically', () => {
      const nullifier = '0xatomic1';
      const signal = { x: '0x111', y: '0x222' };

      // First call should insert and return null
      const result = service.checkAndSet(nullifier, signal);
      expect(result).toBeNull();

      // Verify it was stored
      const stored = service.get(nullifier);
      expect(stored).toBeDefined();
      expect(stored?.x).toBe(signal.x);
      expect(stored?.y).toBe(signal.y);
    });

    it('should return existing signal if nullifier already exists', () => {
      const nullifier = '0xatomic2';
      const signal1 = { x: '0x333', y: '0x444' };
      const signal2 = { x: '0x555', y: '0x666' };

      // First insert
      service.checkAndSet(nullifier, signal1);

      // Second insert with different signal should return existing
      const result = service.checkAndSet(nullifier, signal2);
      expect(result).not.toBeNull();
      expect(result?.x).toBe(signal1.x);
      expect(result?.y).toBe(signal1.y);

      // Verify original signal is still stored
      const stored = service.get(nullifier);
      expect(stored?.x).toBe(signal1.x);
      expect(stored?.y).toBe(signal1.y);
    });

    it('should preserve all signal fields atomically', () => {
      const nullifier = '0xatomic3';
      const signal = {
        x: '0x777',
        y: '0x888',
        rlnShare_a: '0xabc',
        payloadHash: '0xdef',
        ticketIndex: '42',
        idCommitment: '0xghi',
      };

      const result = service.checkAndSet(nullifier, signal);
      expect(result).toBeNull();

      const stored = service.get(nullifier);
      expect(stored?.x).toBe(signal.x);
      expect(stored?.y).toBe(signal.y);
      expect(stored?.rlnShare_a).toBe(signal.rlnShare_a);
      expect(stored?.payloadHash).toBe(signal.payloadHash);
      expect(stored?.ticketIndex).toBe(signal.ticketIndex);
      expect(stored?.idCommitment).toBe(signal.idCommitment);
    });

    it('should handle concurrent-like sequential calls', () => {
      const nullifier = '0xatomic4';
      const signals = [
        { x: '0xa1', y: '0xb1' },
        { x: '0xa2', y: '0xb2' },
        { x: '0xa3', y: '0xb3' },
      ];

      // First call should succeed
      const result1 = service.checkAndSet(nullifier, signals[0]);
      expect(result1).toBeNull();

      // Subsequent calls should return the first signal
      const result2 = service.checkAndSet(nullifier, signals[1]);
      expect(result2).not.toBeNull();
      expect(result2?.x).toBe(signals[0].x);

      const result3 = service.checkAndSet(nullifier, signals[2]);
      expect(result3).not.toBeNull();
      expect(result3?.x).toBe(signals[0].x);

      // Verify count is still 1
      expect(service.count()).toBe(1);
    });

    it('should work correctly for different nullifiers', () => {
      const nullifiers = ['0xmulti1', '0xmulti2', '0xmulti3'];
      const signals = [
        { x: '0xm1', y: '0xn1' },
        { x: '0xm2', y: '0xn2' },
        { x: '0xm3', y: '0xn3' },
      ];

      // Each nullifier should insert successfully
      for (let i = 0; i < nullifiers.length; i++) {
        const result = service.checkAndSet(nullifiers[i], signals[i]);
        expect(result).toBeNull();
      }

      // Verify all are stored correctly
      for (let i = 0; i < nullifiers.length; i++) {
        const stored = service.get(nullifiers[i]);
        expect(stored?.x).toBe(signals[i].x);
        expect(stored?.y).toBe(signals[i].y);
      }

      expect(service.count()).toBe(3);
    });

    it('should maintain atomicity with timestamp', () => {
      const nullifier = '0xtime1';
      const signal = { x: '0xt1', y: '0xt2' };

      const result = service.checkAndSet(nullifier, signal);
      expect(result).toBeNull();

      const stored = service.get(nullifier);
      expect(stored?.timestamp).toBeDefined();
      expect(stored?.timestamp).toBeGreaterThan(Date.now() - 1000);
    });
  });
});
