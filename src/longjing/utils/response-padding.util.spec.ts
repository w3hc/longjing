import {
  padResponse,
  unpadResponse,
  getSizeClass,
  calculatePaddingOverhead,
} from './response-padding.util';

describe('ResponsePaddingUtil', () => {
  describe('padResponse', () => {
    it('should pad small response to 512 bytes', () => {
      const content = 'Hello World';
      const padded = padResponse(content);

      expect(Buffer.byteLength(padded, 'utf8')).toBe(512);
      expect(padded.startsWith(content)).toBe(true);
    });

    it('should pad medium response to next power of 2', () => {
      const content = 'x'.repeat(600);
      const padded = padResponse(content);

      expect(Buffer.byteLength(padded, 'utf8')).toBe(1024);
    });

    it('should pad to next size class', () => {
      const content = 'x'.repeat(1500);
      const padded = padResponse(content);

      expect(Buffer.byteLength(padded, 'utf8')).toBe(2048);
    });

    it('should handle large responses', () => {
      const content = 'x'.repeat(5000);
      const padded = padResponse(content);

      expect(Buffer.byteLength(padded, 'utf8')).toBe(8192);
    });

    it('should handle very large responses', () => {
      const content = 'x'.repeat(100000);
      const padded = padResponse(content);

      // Should pad to next power of 2
      expect(Buffer.byteLength(padded, 'utf8')).toBeGreaterThan(100000);
      expect(Buffer.byteLength(padded, 'utf8')).toBe(131072); // 2^17
    });
  });

  describe('unpadResponse', () => {
    it('should remove padding correctly', () => {
      const original = 'Hello World';
      const padded = padResponse(original);
      const unpadded = unpadResponse(padded);

      expect(unpadded).toBe(original);
    });

    it('should handle medium responses', () => {
      const original = 'x'.repeat(1500);
      const padded = padResponse(original);
      const unpadded = unpadResponse(padded);

      expect(unpadded).toBe(original);
    });

    it('should handle responses without padding', () => {
      const content = 'No padding here';
      const result = unpadResponse(content);

      expect(result).toBe(content);
    });

    it('should handle JSON content', () => {
      const original = JSON.stringify({ message: 'Hello', data: [1, 2, 3] });
      const padded = padResponse(original);
      const unpadded = unpadResponse(padded);

      expect(unpadded).toBe(original);
      expect(JSON.parse(unpadded)).toEqual({
        message: 'Hello',
        data: [1, 2, 3],
      });
    });
  });

  describe('getSizeClass', () => {
    it('should return correct size class for small content', () => {
      expect(getSizeClass(100)).toBe(512);
      expect(getSizeClass(500)).toBe(512);
    });

    it('should return correct size class for medium content', () => {
      expect(getSizeClass(600)).toBe(1024);
      expect(getSizeClass(1500)).toBe(2048);
    });

    it('should return correct size class for large content', () => {
      expect(getSizeClass(5000)).toBe(8192);
      expect(getSizeClass(10000)).toBe(16384);
    });

    it('should handle content larger than predefined classes', () => {
      const size = getSizeClass(300000);
      expect(size).toBeGreaterThan(262144);
      // Should be next power of 2
      expect(Math.log2(size) % 1).toBe(0);
    });
  });

  describe('calculatePaddingOverhead', () => {
    it('should calculate overhead percentage', () => {
      const overhead = calculatePaddingOverhead(256, 512);
      expect(overhead).toBe(100); // 100% overhead
    });

    it('should calculate overhead for various sizes', () => {
      expect(calculatePaddingOverhead(100, 512)).toBeCloseTo(412, 0);
      expect(calculatePaddingOverhead(500, 512)).toBeCloseTo(2.4, 1);
      expect(calculatePaddingOverhead(1000, 1024)).toBeCloseTo(2.4, 1);
    });

    it('should handle zero original size', () => {
      expect(calculatePaddingOverhead(0, 512)).toBe(0);
    });

    it('should handle same size (no padding)', () => {
      expect(calculatePaddingOverhead(512, 512)).toBe(0);
    });
  });

  describe('Privacy guarantees', () => {
    it('should map many response sizes to fewer size classes (k-anonymity)', () => {
      const sizes = [100, 200, 300, 400, 500]; // All should pad to 512
      const paddedSizes = sizes.map((size) =>
        Buffer.byteLength(padResponse('x'.repeat(size)), 'utf8'),
      );

      // All different sizes map to same padded size
      const uniqueSizes = new Set(paddedSizes);
      expect(uniqueSizes.size).toBe(1);
      expect(paddedSizes[0]).toBe(512);
    });

    it('should prevent fine-grained size fingerprinting', () => {
      // Responses differing by a few bytes get same size
      const response1 = 'x'.repeat(1000);
      const response2 = 'x'.repeat(1010);
      const response3 = 'x'.repeat(1020);

      const padded1 = Buffer.byteLength(padResponse(response1), 'utf8');
      const padded2 = Buffer.byteLength(padResponse(response2), 'utf8');
      const padded3 = Buffer.byteLength(padResponse(response3), 'utf8');

      // All map to same size class (1024 for ~1000 byte responses)
      expect(padded1).toBe(padded2);
      expect(padded2).toBe(padded3);
      expect(padded1).toBe(1024);
    });

    it('should reduce information leakage from response length', () => {
      // Test multiple responses in a size range
      const responses = Array.from({ length: 50 }, (_, i) =>
        'x'.repeat(1000 + i * 10),
      );

      const paddedSizes = responses.map((r) =>
        Buffer.byteLength(padResponse(r), 'utf8'),
      );

      // 50 different sizes should map to only 1-2 size classes
      const uniqueSizes = new Set(paddedSizes);
      expect(uniqueSizes.size).toBeLessThanOrEqual(2);
    });
  });
});
