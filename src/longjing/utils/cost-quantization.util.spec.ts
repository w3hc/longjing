import {
  quantizeCost,
  quantizeUnits,
  costClassToUSD,
  unitClassToCount,
  calculateQuantizationError,
  CostClass,
  UnitClass,
} from './cost-quantization.util';

describe('CostQuantizationUtil', () => {
  describe('quantizeCost', () => {
    it('should quantize micro costs', () => {
      const { costClass, quantizedCost } = quantizeCost(0.005);
      expect(costClass).toBe(CostClass.MICRO);
      expect(quantizedCost).toBe(0.005);
    });

    it('should quantize small costs', () => {
      const { costClass, quantizedCost } = quantizeCost(0.05);
      expect(costClass).toBe(CostClass.SMALL);
      expect(quantizedCost).toBe(0.05);
    });

    it('should quantize medium costs', () => {
      const { costClass, quantizedCost } = quantizeCost(0.5);
      expect(costClass).toBe(CostClass.MEDIUM);
      expect(quantizedCost).toBe(0.5);
    });

    it('should quantize large costs', () => {
      const { costClass, quantizedCost } = quantizeCost(5.0);
      expect(costClass).toBe(CostClass.LARGE);
      expect(quantizedCost).toBe(5.0);
    });

    it('should quantize xlarge costs', () => {
      const { costClass, quantizedCost } = quantizeCost(15.0);
      expect(costClass).toBe(CostClass.XLARGE);
      expect(quantizedCost).toBe(15.0);
    });

    it('should map edge cases correctly', () => {
      // Just below boundary
      expect(quantizeCost(0.0099).costClass).toBe(CostClass.MICRO);
      // At boundary
      expect(quantizeCost(0.01).costClass).toBe(CostClass.SMALL);
      // Just above boundary
      expect(quantizeCost(0.0101).costClass).toBe(CostClass.SMALL);
    });
  });

  describe('quantizeUnits', () => {
    it('should quantize tiny unit counts', () => {
      const { unitClass, quantizedUnits } = quantizeUnits(50);
      expect(unitClass).toBe(UnitClass.TINY);
      expect(quantizedUnits).toBe(50);
    });

    it('should quantize small unit counts', () => {
      const { unitClass, quantizedUnits } = quantizeUnits(500);
      expect(unitClass).toBe(UnitClass.SMALL);
      expect(quantizedUnits).toBe(500);
    });

    it('should quantize medium unit counts', () => {
      const { unitClass, quantizedUnits } = quantizeUnits(5000);
      expect(unitClass).toBe(UnitClass.MEDIUM);
      expect(quantizedUnits).toBe(5000);
    });

    it('should quantize large unit counts', () => {
      const { unitClass, quantizedUnits } = quantizeUnits(50000);
      expect(unitClass).toBe(UnitClass.LARGE);
      expect(quantizedUnits).toBe(50000);
    });

    it('should quantize xlarge unit counts', () => {
      const { unitClass, quantizedUnits } = quantizeUnits(150000);
      expect(unitClass).toBe(UnitClass.XLARGE);
      expect(quantizedUnits).toBe(150000);
    });

    it('should map boundaries correctly', () => {
      // Just below boundary
      expect(quantizeUnits(99).unitClass).toBe(UnitClass.TINY);
      // At boundary
      expect(quantizeUnits(100).unitClass).toBe(UnitClass.SMALL);
      // Just above boundary
      expect(quantizeUnits(101).unitClass).toBe(UnitClass.SMALL);
    });
  });

  describe('costClassToUSD', () => {
    it('should convert cost classes to USD', () => {
      expect(costClassToUSD(CostClass.MICRO)).toBe(0.005);
      expect(costClassToUSD(CostClass.SMALL)).toBe(0.05);
      expect(costClassToUSD(CostClass.MEDIUM)).toBe(0.5);
      expect(costClassToUSD(CostClass.LARGE)).toBe(5.0);
      expect(costClassToUSD(CostClass.XLARGE)).toBe(15.0);
    });
  });

  describe('unitClassToCount', () => {
    it('should convert unit classes to counts', () => {
      expect(unitClassToCount(UnitClass.TINY)).toBe(50);
      expect(unitClassToCount(UnitClass.SMALL)).toBe(500);
      expect(unitClassToCount(UnitClass.MEDIUM)).toBe(5000);
      expect(unitClassToCount(UnitClass.LARGE)).toBe(50000);
      expect(unitClassToCount(UnitClass.XLARGE)).toBe(150000);
    });
  });

  describe('calculateQuantizationError', () => {
    it('should calculate quantization error', () => {
      // Exact match (0% error)
      expect(calculateQuantizationError(0.005, 0.005)).toBe(0);

      // 50% error
      const error = calculateQuantizationError(0.01, 0.005);
      expect(error).toBeCloseTo(0.5, 2);

      // 100% error
      const error2 = calculateQuantizationError(0.01, 0.02);
      expect(error2).toBeCloseTo(1.0, 2);
    });
  });

  describe('Privacy guarantees', () => {
    it('should map many actual costs to fewer cost classes (k-anonymity)', () => {
      const costs = [
        0.001,
        0.003,
        0.007, // All map to MICRO
        0.02,
        0.05,
        0.08, // All map to SMALL
        0.15,
        0.5,
        0.9, // All map to MEDIUM
      ];

      const classes = costs.map((c) => quantizeCost(c).costClass);
      const uniqueClasses = new Set(classes);

      // 9 different costs map to only 3 classes
      expect(classes.length).toBe(9);
      expect(uniqueClasses.size).toBe(3);
    });

    it('should map many token counts to fewer unit classes', () => {
      const counts = [
        10,
        50,
        90, // All map to TINY
        150,
        500,
        900, // All map to SMALL
        1500,
        5000,
        9000, // All map to MEDIUM
      ];

      const classes = counts.map((c) => quantizeUnits(c).unitClass);
      const uniqueClasses = new Set(classes);

      // 9 different counts map to only 3 classes
      expect(counts.length).toBe(9);
      expect(uniqueClasses.size).toBe(3);
    });
  });
});
