import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import {
  PricingModel,
  PricingHistory,
  PricingRate,
} from './dto/pricing-model.dto';

interface PricingModelRow {
  id: number;
  provider_id: string;
  endpoint: string | null;
  pricing_type: string;
  currency: string;
  rates: string;
  effective_from: string;
  effective_until: string | null;
  created_at: string;
  updated_at: string;
}

interface PricingHistoryRow {
  id: number;
  provider_id: string;
  endpoint: string | null;
  old_rates: string | null;
  new_rates: string;
  changed_by: string;
  changed_at: string;
  reason: string;
}

/**
 * Repository for pricing model database operations
 */
@Injectable()
export class PricingRepository {
  private readonly logger = new Logger(PricingRepository.name);

  constructor(private readonly db: DatabaseService) {}

  /**
   * Get current active pricing for a provider and endpoint
   */
  getPricing(providerId: string, endpoint?: string): PricingModel | null {
    const now = new Date().toISOString();

    // First try to find endpoint-specific pricing
    if (endpoint) {
      const specific = this.db.db
        .prepare(
          `
        SELECT * FROM pricing_models
        WHERE provider_id = ?
          AND endpoint = ?
          AND effective_from <= ?
          AND (effective_until IS NULL OR effective_until > ?)
        ORDER BY effective_from DESC
        LIMIT 1
      `,
        )
        .get(providerId, endpoint, now, now) as PricingModelRow | undefined;

      if (specific) {
        return this.rowToPricingModel(specific);
      }
    }

    // Fall back to provider-level pricing (endpoint = NULL)
    const general = this.db.db
      .prepare(
        `
      SELECT * FROM pricing_models
      WHERE provider_id = ?
        AND endpoint IS NULL
        AND effective_from <= ?
        AND (effective_until IS NULL OR effective_until > ?)
      ORDER BY effective_from DESC
      LIMIT 1
    `,
      )
      .get(providerId, now, now) as PricingModelRow | undefined;

    return general ? this.rowToPricingModel(general) : null;
  }

  /**
   * Insert or update pricing model
   */
  upsertPricing(model: PricingModel): void {
    const existing = this.getPricing(model.providerId, model.endpoint);

    // If existing pricing is active, set its effective_until to now
    if (existing) {
      this.db.db
        .prepare(
          `
        UPDATE pricing_models
        SET effective_until = ?, updated_at = ?
        WHERE provider_id = ?
          AND ${model.endpoint ? 'endpoint = ?' : 'endpoint IS NULL'}
          AND effective_until IS NULL
      `,
        )
        .run(
          new Date().toISOString(),
          new Date().toISOString(),
          model.providerId,
          ...(model.endpoint ? [model.endpoint] : []),
        );
    }

    // Insert new pricing model
    this.db.db
      .prepare(
        `
      INSERT INTO pricing_models (
        provider_id, endpoint, pricing_type, currency, rates,
        effective_from, effective_until, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        model.providerId,
        model.endpoint ?? null,
        model.pricingType,
        model.currency,
        JSON.stringify(model.rates),
        model.effectiveFrom.toISOString(),
        model.effectiveUntil?.toISOString() ?? null,
        new Date().toISOString(),
        new Date().toISOString(),
      );

    this.logger.log(
      `Upserted pricing for ${model.providerId}${model.endpoint ? ` (${model.endpoint})` : ''}`,
    );
  }

  /**
   * Add pricing history record
   */
  addHistory(
    providerId: string,
    endpoint: string | undefined,
    oldRates: PricingRate[] | undefined,
    newRates: PricingRate[],
    changedBy: string,
    reason: string,
  ): void {
    this.db.db
      .prepare(
        `
      INSERT INTO pricing_history (
        provider_id, endpoint, old_rates, new_rates, changed_by, changed_at, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        providerId,
        endpoint ?? null,
        oldRates ? JSON.stringify(oldRates) : null,
        JSON.stringify(newRates),
        changedBy,
        new Date().toISOString(),
        reason,
      );
  }

  /**
   * Get pricing history for a provider
   */
  getHistory(providerId: string, limit = 50): PricingHistory[] {
    const rows = this.db.db
      .prepare(
        `
      SELECT * FROM pricing_history
      WHERE provider_id = ?
      ORDER BY changed_at DESC
      LIMIT ?
    `,
      )
      .all(providerId, limit) as PricingHistoryRow[];

    return rows.map((row) => ({
      id: row.id,
      providerId: row.provider_id,
      endpoint: row.endpoint ?? undefined,
      oldRates: row.old_rates ?? undefined,
      newRates: row.new_rates,
      changedBy: row.changed_by,
      changedAt: new Date(row.changed_at),
      reason: row.reason,
    }));
  }

  /**
   * Convert database row to PricingModel
   */
  private rowToPricingModel(row: PricingModelRow): PricingModel {
    const pricingType = row.pricing_type as
      'per-token' | 'per-call' | 'per-unit' | 'tiered' | 'composite';

    return {
      providerId: row.provider_id,
      endpoint: row.endpoint ?? undefined,
      pricingType,
      rates: JSON.parse(row.rates) as PricingRate[],
      currency: row.currency,
      effectiveFrom: new Date(row.effective_from),
      effectiveUntil: row.effective_until
        ? new Date(row.effective_until)
        : undefined,
    };
  }
}
