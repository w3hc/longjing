import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';

/** An RLN signal (x, y) stored under its nullifier N */
export interface StoredSignal {
  x: string;
  y: string;
}

interface NullifierRow {
  x: string;
  y: string;
}

interface CountRow {
  count: number;
}

interface CachedResponse<T> {
  signal: StoredSignal;
  response: T;
  expiresAt: number;
}

/**
 * SQLite store of spent nullifiers, holding (N, x, y) and nothing else
 * (docs/SETTLEMENT.md): enough to reject a replay and to recover k from a
 * second signal at the same index, never a commitment, an index, a payload
 * hash or a timestamp.
 *
 * Signed responses are kept in memory for a few minutes, keyed by N, so a
 * client that lost one can retry without being charged again.
 */
@Injectable()
export class NullifierStoreService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NullifierStoreService.name);
  private db: Database.Database;
  private dbPath: string;
  // In-memory rate limiting per nullifier
  private readonly nullifierAttempts = new Map<string, number[]>();
  private readonly RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
  private readonly RATE_LIMIT_MAX_ATTEMPTS = 3; // Max 3 attempts per minute per nullifier
  private readonly responses = new Map<string, CachedResponse<unknown>>();
  readonly RESPONSE_TTL_MS = 10 * 60 * 1000;
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    // Use environment variable or default to data directory
    const dataDir = process.env.DATA_DIR || join(process.cwd(), 'data');
    // Support in-memory database for testing
    this.dbPath =
      dataDir === ':memory:' ? ':memory:' : join(dataDir, 'nullifiers.db');
  }

  onModuleInit() {
    if (this.dbPath !== ':memory:') {
      const dir = join(this.dbPath, '..');
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new Database(this.dbPath);
    this.logger.log(`SQLite database initialized at ${this.dbPath}`);

    this.migrateToSignalsOnly();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nullifiers (
        nullifier TEXT PRIMARY KEY,
        x TEXT NOT NULL,
        y TEXT NOT NULL
      );
    `);

    // Clean up the rate limit map and expired responses every 5 minutes
    this.cleanupInterval = setInterval(
      () => {
        this.cleanupRateLimitMap();
        this.cleanupResponses();
      },
      5 * 60 * 1000,
    );
  }

  onModuleDestroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    if (this.db) {
      this.db.close();
      this.logger.log('SQLite database connection closed');
    }
  }

  /**
   * Migration: earlier versions stored a timestamp, the payload hash, the
   * ticket index and the identity commitment with each signal, and kept
   * redeemed refunds. Keep (N, x, y) and drop everything else.
   */
  private migrateToSignalsOnly(): void {
    const columns = this.db
      .prepare("PRAGMA table_info('nullifiers')")
      .all() as Array<{ name: string }>;
    const extra = columns.filter(
      (col) => !['nullifier', 'x', 'y'].includes(col.name),
    );
    const hasRefunds =
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'redeemed_refunds'",
        )
        .get() !== undefined;
    if (extra.length === 0 && !hasRefunds) return;

    this.logger.log(
      'Migrating database: keeping only (nullifier, x, y), dropping every identifier',
    );
    this.db.transaction(() => {
      if (extra.length > 0) {
        this.db.exec(`
          CREATE TABLE nullifiers_new (
            nullifier TEXT PRIMARY KEY,
            x TEXT NOT NULL,
            y TEXT NOT NULL
          );
          INSERT INTO nullifiers_new (nullifier, x, y)
            SELECT nullifier, x, y FROM nullifiers;
          DROP TABLE nullifiers;
          ALTER TABLE nullifiers_new RENAME TO nullifiers;
        `);
      }
      this.db.exec(`
        DROP INDEX IF EXISTS idx_nullifiers_timestamp;
        DROP TABLE IF EXISTS redeemed_refunds;
      `);
    })();
    // Freed pages could still hold the dropped values
    this.db.exec('VACUUM');
  }

  /**
   * Get the signal stored under a nullifier
   */
  get(nullifier: string): StoredSignal | null {
    const row = this.db
      .prepare('SELECT x, y FROM nullifiers WHERE nullifier = ?')
      .get(nullifier) as NullifierRow | undefined;
    return row ? { x: row.x, y: row.y } : null;
  }

  /**
   * Check if nullifier exists
   */
  exists(nullifier: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM nullifiers WHERE nullifier = ?')
        .get(nullifier) !== undefined
    );
  }

  /**
   * Atomically check if nullifier exists and insert if not.
   * @returns The stored signal if the nullifier was already spent, null if
   *          this call recorded it
   */
  checkAndSet(nullifier: string, signal: StoredSignal): StoredSignal | null {
    return this.db.transaction(() => {
      const existing = this.get(nullifier);
      if (existing) return existing;
      this.db
        .prepare('INSERT INTO nullifiers (nullifier, x, y) VALUES (?, ?, ?)')
        .run(nullifier, signal.x, signal.y);
      return null;
    })();
  }

  /**
   * Keep a signed response for RESPONSE_TTL_MS, so a retry of the same signal
   * gets it back without a second provider call
   */
  rememberResponse<T>(nullifier: string, signal: StoredSignal, response: T) {
    this.responses.set(nullifier, {
      signal,
      response,
      expiresAt: Date.now() + this.RESPONSE_TTL_MS,
    });
  }

  /**
   * The response kept for this nullifier, if the retry carries the same signal
   * and the response hasn't expired
   */
  recallResponse<T>(nullifier: string, signal: StoredSignal): T | null {
    const cached = this.responses.get(nullifier);
    if (!cached || cached.expiresAt <= Date.now()) return null;
    if (cached.signal.x !== signal.x || cached.signal.y !== signal.y) {
      return null;
    }
    return cached.response as T;
  }

  /**
   * Clear all nullifiers and kept responses (for testing)
   */
  clear(): void {
    this.db.exec('DELETE FROM nullifiers');
    this.responses.clear();
    this.logger.log('Cleared all nullifiers');
  }

  /**
   * Get count of stored nullifiers
   */
  count(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM nullifiers')
      .get() as CountRow | undefined;
    return row?.count ?? 0;
  }

  /**
   * Check if nullifier has exceeded rate limit
   * Returns true if within limit, false if exceeded
   */
  checkRateLimit(nullifier: string): boolean {
    const now = Date.now();

    // Get recent attempts for this nullifier
    const attempts = this.nullifierAttempts.get(nullifier) || [];
    const recentAttempts = attempts.filter(
      (timestamp) => now - timestamp < this.RATE_LIMIT_WINDOW_MS,
    );

    // Check if exceeded limit
    if (recentAttempts.length >= this.RATE_LIMIT_MAX_ATTEMPTS) {
      this.logger.warn(
        `Rate limit exceeded for nullifier ${nullifier.slice(0, 10)}... (${recentAttempts.length} attempts in last minute)`,
      );
      return false;
    }

    // Record this attempt
    recentAttempts.push(now);
    this.nullifierAttempts.set(nullifier, recentAttempts);

    // Clean up old entries periodically (when map gets large)
    if (this.nullifierAttempts.size > 1000) {
      this.cleanupRateLimitMap();
    }

    return true;
  }

  /**
   * Clean up expired entries from rate limit map
   */
  private cleanupRateLimitMap(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [nullifier, attempts] of this.nullifierAttempts.entries()) {
      const recentAttempts = attempts.filter(
        (timestamp) => now - timestamp < this.RATE_LIMIT_WINDOW_MS,
      );

      if (recentAttempts.length === 0) {
        this.nullifierAttempts.delete(nullifier);
        cleaned++;
      } else if (recentAttempts.length < attempts.length) {
        this.nullifierAttempts.set(nullifier, recentAttempts);
      }
    }

    if (cleaned > 0) {
      this.logger.debug(`Cleaned up ${cleaned} expired rate limit entries`);
    }
  }

  private cleanupResponses(): void {
    const now = Date.now();
    for (const [nullifier, cached] of this.responses.entries()) {
      if (cached.expiresAt <= now) this.responses.delete(nullifier);
    }
  }

  /**
   * Get remaining attempts for nullifier (for debugging/testing)
   */
  getRemainingAttempts(nullifier: string): number {
    const now = Date.now();
    const attempts = this.nullifierAttempts.get(nullifier) || [];
    const recentAttempts = attempts.filter(
      (timestamp) => now - timestamp < this.RATE_LIMIT_WINDOW_MS,
    );
    return Math.max(0, this.RATE_LIMIT_MAX_ATTEMPTS - recentAttempts.length);
  }
}
