/**
 * Cost quantization utility for Privacy fix: Response metadata linkability
 *
 * Implements quantized cost classes to prevent fine-grained cost tracking
 * that could be used to link requests based on token usage patterns.
 *
 * Instead of revealing exact token counts (e.g., 1,234 tokens = $0.003702),
 * we map costs to discrete buckets (e.g., "small", "medium", "large").
 *
 * Security benefit:
 * - Prevents correlation of requests by exact token count
 * - Reduces metadata leakage from response sizes
 * - Makes timing attacks based on response cost more difficult
 */

/**
 * Quantized cost class labels
 */
export enum CostClass {
  MICRO = 'micro', // ~$0.00 - $0.01
  SMALL = 'small', // ~$0.01 - $0.10
  MEDIUM = 'medium', // ~$0.10 - $1.00
  LARGE = 'large', // ~$1.00 - $10.00
  XLARGE = 'xlarge', // ~$10.00+
}

/**
 * Cost class boundaries in USD
 */
const COST_CLASS_BOUNDARIES = {
  [CostClass.MICRO]: { min: 0, max: 0.01 },
  [CostClass.SMALL]: { min: 0.01, max: 0.1 },
  [CostClass.MEDIUM]: { min: 0.1, max: 1.0 },
  [CostClass.LARGE]: { min: 1.0, max: 10.0 },
  [CostClass.XLARGE]: { min: 10.0, max: Infinity },
};

/**
 * Representative cost for each class (middle of range)
 * Used for billing when exact cost is not revealed
 */
const COST_CLASS_REPRESENTATIVE = {
  [CostClass.MICRO]: 0.005,
  [CostClass.SMALL]: 0.05,
  [CostClass.MEDIUM]: 0.5,
  [CostClass.LARGE]: 5.0,
  [CostClass.XLARGE]: 15.0,
};

/**
 * Unit class for token quantization
 */
export enum UnitClass {
  TINY = 'tiny', // 0-100 units
  SMALL = 'small', // 100-1k units
  MEDIUM = 'medium', // 1k-10k units
  LARGE = 'large', // 10k-100k units
  XLARGE = 'xlarge', // 100k+ units
}

/**
 * Unit class boundaries
 */
const UNIT_CLASS_BOUNDARIES = {
  [UnitClass.TINY]: { min: 0, max: 100 },
  [UnitClass.SMALL]: { min: 100, max: 1000 },
  [UnitClass.MEDIUM]: { min: 1000, max: 10000 },
  [UnitClass.LARGE]: { min: 10000, max: 100000 },
  [UnitClass.XLARGE]: { min: 100000, max: Infinity },
};

/**
 * Representative unit count for each class
 */
const UNIT_CLASS_REPRESENTATIVE = {
  [UnitClass.TINY]: 50,
  [UnitClass.SMALL]: 500,
  [UnitClass.MEDIUM]: 5000,
  [UnitClass.LARGE]: 50000,
  [UnitClass.XLARGE]: 150000,
};

/**
 * Quantize cost in USD to a cost class
 */
export function quantizeCost(costUSD: number): {
  costClass: CostClass;
  quantizedCost: number;
} {
  for (const [className, bounds] of Object.entries(COST_CLASS_BOUNDARIES)) {
    if (costUSD >= bounds.min && costUSD < bounds.max) {
      return {
        costClass: className as CostClass,
        quantizedCost: COST_CLASS_REPRESENTATIVE[className as CostClass],
      };
    }
  }

  // Default to XLARGE if above all boundaries
  return {
    costClass: CostClass.XLARGE,
    quantizedCost: COST_CLASS_REPRESENTATIVE[CostClass.XLARGE],
  };
}

/**
 * Quantize unit count to a unit class
 */
export function quantizeUnits(units: number): {
  unitClass: UnitClass;
  quantizedUnits: number;
} {
  for (const [className, bounds] of Object.entries(UNIT_CLASS_BOUNDARIES)) {
    if (units >= bounds.min && units < bounds.max) {
      return {
        unitClass: className as UnitClass,
        quantizedUnits: UNIT_CLASS_REPRESENTATIVE[className as UnitClass],
      };
    }
  }

  // Default to XLARGE if above all boundaries
  return {
    unitClass: UnitClass.XLARGE,
    quantizedUnits: UNIT_CLASS_REPRESENTATIVE[UnitClass.XLARGE],
  };
}

/**
 * Convert cost class back to USD for actual billing
 * Uses the representative value for the class
 */
export function costClassToUSD(costClass: CostClass): number {
  return COST_CLASS_REPRESENTATIVE[costClass];
}

/**
 * Convert unit class to actual unit count
 * Uses the representative value for the class
 */
export function unitClassToCount(unitClass: UnitClass): number {
  return UNIT_CLASS_REPRESENTATIVE[unitClass];
}

/**
 * Calculate the quantization error (information loss)
 * Useful for testing and validation
 */
export function calculateQuantizationError(
  actualCost: number,
  quantizedCost: number,
): number {
  return Math.abs(actualCost - quantizedCost) / actualCost;
}
