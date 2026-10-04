import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';

interface StoredSignal {
  x: string;
  y: string;
  timestamp: number;
  rlnShare_a?: string; // RLN share 'a' for policy violation proofs
  payloadHash?: string; // Hash of the payload for policy violation evidence
  ticketIndex?: string; // Ticket index for double-spend proof generation
  idCommitment?: string; // Identity commitment for double-spend proof generation
}

interface RefundRedemption {
  idCommitment: string;
  value: string;
  timestamp: number;
  recipient: string;
  txHash: string;
  redeemedAt: number;
}

interface NullifierRow {
  nullifier: string;
  x: string;
  y: string;
  timestamp: number;
  rln_share_a: string | null;
  payload_hash: string | null;
  ticket_index: string | null;
  id_commitment: string | null;
}

interface RefundRow {
  nullifier: string;
  id_commitment: string;
  value: string;
  timestamp: number;
  recipient: string;
  tx_hash: string;
  redeemed_at: number;
}

interface CountRow {
  count: number;
}

/**
 * SQLite-backed store for tracking used nullifiers and their associated RLN signals
 * Also tracks redeemed refunds for auditing
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
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    // Use environment variable or default to data directory
    const dataDir = process.env.DATA_DIR || join(process.cwd(), 'data');
    // Support in-memory database for testing
    this.dbPath =
      dataDir === ':memory:' ? ':memory:' : join(dataDir, 'nullifiers.db');
  }

  onModuleInit() {
    // Create data directory if it doesn't exist (unless using in-memory DB)
    if (this.dbPath !== ':memory:') {
      const dir = join(this.dbPath, '..');
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new Database(this.dbPath);
    this.logger.log(`SQLite database initialized at ${this.dbPath}`);

    // Create tables if they don't exist
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nullifiers (
        nullifier TEXT PRIMARY KEY,
        x TEXT NOT NULL,
        y TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        rln_share_a TEXT,
        payload_hash TEXT,
        ticket_index TEXT,
        id_commitment TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_nullifiers_timestamp ON nullifiers(timestamp);
    `);

    // Migration: Add new columns if they don't exist
    this.migrateAddPolicyViolationColumns();
    this.migrateAddSlashingColumns();

    // Create redeemed_refunds table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS redeemed_refunds (
        nullifier TEXT PRIMARY KEY,
        id_commitment TEXT NOT NULL,
        value TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        recipient TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        redeemed_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_redeemed_timestamp ON redeemed_refunds(redeemed_at);
    `);

    // Migration: Remove payload column if it exists (for privacy)
    this.migrateRemovePayloadColumn();

    // Clean up rate limit map every 5 minutes
    this.cleanupInterval = setInterval(
      () => {
        this.cleanupRateLimitMap();
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
   * Migration: Add columns for policy violation proof generation
   */
  private migrateAddPolicyViolationColumns(): void {
    try {
      const columns = this.db
        .prepare("PRAGMA table_info('nullifiers')")
        .all() as Array<{ name: string }>;

      const hasRlnShareA = columns.some((col) => col.name === 'rln_share_a');
      const hasPayloadHash = columns.some((col) => col.name === 'payload_hash');

      if (!hasRlnShareA) {
        this.logger.log(
          'Adding rln_share_a column for policy violation proofs',
        );
        this.db.exec('ALTER TABLE nullifiers ADD COLUMN rln_share_a TEXT');
      }

      if (!hasPayloadHash) {
        this.logger.log(
          'Adding payload_hash column for policy violation proofs',
        );
        this.db.exec('ALTER TABLE nullifiers ADD COLUMN payload_hash TEXT');
      }
    } catch (error) {
      this.logger.error('Failed to migrate policy violation columns', error);
      throw error;
    }
  }

  /**
   * Migration: Add columns for double-spend slashing proof generation
   */
  private migrateAddSlashingColumns(): void {
    try {
      const columns = this.db
        .prepare("PRAGMA table_info('nullifiers')")
        .all() as Array<{ name: string }>;

      const hasTicketIndex = columns.some((col) => col.name === 'ticket_index');
      const hasIdCommitment = columns.some(
        (col) => col.name === 'id_commitment',
      );

      if (!hasTicketIndex) {
        this.logger.log(
          'Adding ticket_index column for double-spend slashing proofs',
        );
        this.db.exec('ALTER TABLE nullifiers ADD COLUMN ticket_index TEXT');
      }

      if (!hasIdCommitment) {
        this.logger.log(
          'Adding id_commitment column for double-spend slashing proofs',
        );
        this.db.exec('ALTER TABLE nullifiers ADD COLUMN id_commitment TEXT');
      }
    } catch (error) {
      this.logger.error('Failed to migrate slashing columns', error);
      throw error;
    }
  }

  /**
   * Migration: Remove payload column for privacy
   * SQLite doesn't support DROP COLUMN, so we recreate the table
   */
  private migrateRemovePayloadColumn(): void {
    try {
      // Check if payload column exists
      const columns = this.db
        .prepare("PRAGMA table_info('nullifiers')")
        .all() as Array<{ name: string }>;

      const hasPayload = columns.some((col) => col.name === 'payload');

      if (hasPayload) {
        this.logger.log(
          'Migrating database: removing payload column for privacy',
        );

        // SQLite doesn't support DROP COLUMN, so we need to recreate the table
        this.db.exec(`
          BEGIN TRANSACTION;

          -- Create new table without payload
          CREATE TABLE nullifiers_new (
            nullifier TEXT PRIMARY KEY,
            x TEXT NOT NULL,
            y TEXT NOT NULL,
            timestamp INTEGER NOT NULL
          );

          -- Copy data (excluding payload)
          INSERT INTO nullifiers_new (nullifier, x, y, timestamp)
          SELECT nullifier, x, y, timestamp FROM nullifiers;

          -- Drop old table
          DROP TABLE nullifiers;

          -- Rename new table
          ALTER TABLE nullifiers_new RENAME TO nullifiers;

          -- Recreate index
          CREATE INDEX idx_nullifiers_timestamp ON nullifiers(timestamp);

          COMMIT;
        `);

        // Verify migration succeeded
        const columnsAfter = this.db
          .prepare("PRAGMA table_info('nullifiers')")
          .all() as Array<{ name: string }>;
        const stillHasPayload = columnsAfter.some(
          (col) => col.name === 'payload',
        );

        if (stillHasPayload) {
          throw new Error('Migration failed: payload column still exists');
        }

        this.logger.log('Migration completed successfully');
      }
    } catch (error) {
      this.logger.error('Migration failed:', error);
      // In production, throw the error to prevent service from starting with corrupted database
      if (process.env.NODE_ENV === 'production') {
        throw error;
      }
    }
  }

  /**
   * Get signal associated with a nullifier
   */
  get(nullifier: string): StoredSignal | null {
    const stmt = this.db.prepare(
      'SELECT x, y, timestamp, rln_share_a, payload_hash, ticket_index, id_commitment FROM nullifiers WHERE nullifier = ?',
    );
    const row = stmt.get(nullifier) as NullifierRow | undefined;

    if (!row) return null;

    return {
      x: row.x,
      y: row.y,
      timestamp: row.timestamp,
      rlnShare_a: row.rln_share_a || undefined,
      payloadHash: row.payload_hash || undefined,
      ticketIndex: row.ticket_index || undefined,
      idCommitment: row.id_commitment || undefined,
    };
  }

  /**
   * Store a new nullifier and its signal
   */
  set(
    nullifier: string,
    signal: {
      x: string;
      y: string;
      rlnShare_a?: string;
      payloadHash?: string;
      ticketIndex?: string;
      idCommitment?: string;
    },
  ): void {
    const timestamp = Date.now();
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO nullifiers (nullifier, x, y, timestamp, rln_share_a, payload_hash, ticket_index, id_commitment) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    stmt.run(
      nullifier,
      signal.x,
      signal.y,
      timestamp,
      signal.rlnShare_a || null,
      signal.payloadHash || null,
      signal.ticketIndex || null,
      signal.idCommitment || null,
    );
    this.logger.debug(`Stored nullifier: ${nullifier.slice(0, 10)}...`);
  }

  /**
   * Check if nullifier exists
   */
  exists(nullifier: string): boolean {
    const stmt = this.db.prepare(
      'SELECT 1 FROM nullifiers WHERE nullifier = ?',
    );
    return stmt.get(nullifier) !== undefined;
  }

  /**
   * Atomically check if nullifier exists and insert if not.
   * Returns the existing signal if found, or null if successfully inserted.
   *
   * This operation is atomic and thread-safe:
   * - Uses a transaction to ensure atomicity
   * - SQLite's write serialization prevents race conditions
   * - Either the nullifier exists (returns existing signal) or is inserted (returns null)
   *
   * @param nullifier - The nullifier to check and potentially insert
   * @param signal - The signal data to insert if nullifier doesn't exist
   * @returns Existing signal if nullifier was already present, null if newly inserted
   */
  checkAndSet(
    nullifier: string,
    signal: {
      x: string;
      y: string;
      rlnShare_a?: string;
      payloadHash?: string;
      ticketIndex?: string;
      idCommitment?: string;
    },
  ): StoredSignal | null {
    // SQLite's default transaction mode (DEFERRED) ensures atomicity
    // All operations within this transaction are serialized
    const transaction = this.db.transaction(() => {
      // First, check if nullifier exists
      const checkStmt = this.db.prepare(
        'SELECT x, y, timestamp, rln_share_a, payload_hash, ticket_index, id_commitment FROM nullifiers WHERE nullifier = ?',
      );
      const existing = checkStmt.get(nullifier) as NullifierRow | undefined;

      if (existing) {
        // Nullifier already exists, return the existing signal
        return {
          x: existing.x,
          y: existing.y,
          timestamp: existing.timestamp,
          rlnShare_a: existing.rln_share_a || undefined,
          payloadHash: existing.payload_hash || undefined,
          ticketIndex: existing.ticket_index || undefined,
          idCommitment: existing.id_commitment || undefined,
        };
      }

      // Nullifier doesn't exist, insert it
      const timestamp = Date.now();
      const insertStmt = this.db.prepare(
        'INSERT INTO nullifiers (nullifier, x, y, timestamp, rln_share_a, payload_hash, ticket_index, id_commitment) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      );
      insertStmt.run(
        nullifier,
        signal.x,
        signal.y,
        timestamp,
        signal.rlnShare_a || null,
        signal.payloadHash || null,
        signal.ticketIndex || null,
        signal.idCommitment || null,
      );

      this.logger.debug(
        `Stored nullifier atomically: ${nullifier.slice(0, 10)}...`,
      );
      return null;
    });

    // Execute the transaction
    return transaction();
  }

  /**
   * Get all stored nullifiers (for debugging)
   */
  getAll(): Map<string, StoredSignal> {
    const stmt = this.db.prepare(
      'SELECT nullifier, x, y, timestamp FROM nullifiers',
    );
    const rows = stmt.all() as NullifierRow[];

    const map = new Map<string, StoredSignal>();
    for (const row of rows) {
      map.set(row.nullifier, {
        x: row.x,
        y: row.y,
        timestamp: row.timestamp,
      });
    }
    return map;
  }

  /**
   * Clear all nullifiers (for testing)
   */
  clear(): void {
    this.db.exec('DELETE FROM nullifiers');
    this.db.exec('DELETE FROM redeemed_refunds');
    this.logger.log('Cleared all nullifiers and redeemed refunds');
  }

  /**
   * Get count of stored nullifiers
   */
  count(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM nullifiers');
    const row = stmt.get() as CountRow | undefined;
    return row?.count ?? 0;
  }

  /**
   * Mark a refund as redeemed
   */
  markRefundRedeemed(
    nullifier: string,
    redemption: {
      idCommitment: string;
      value: string;
      timestamp: number;
      recipient: string;
      txHash: string;
    },
  ): void {
    const redeemedAt = Date.now();
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO redeemed_refunds (nullifier, id_commitment, value, timestamp, recipient, tx_hash, redeemed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    stmt.run(
      nullifier,
      redemption.idCommitment,
      redemption.value,
      redemption.timestamp,
      redemption.recipient,
      redemption.txHash,
      redeemedAt,
    );
    this.logger.log(
      `Marked refund as redeemed: nullifier=${nullifier.slice(0, 10)}..., value=${redemption.value} wei`,
    );
  }

  /**
   * Check if a refund has been redeemed (from local cache)
   */
  isRefundRedeemed(nullifier: string): boolean {
    const stmt = this.db.prepare(
      'SELECT 1 FROM redeemed_refunds WHERE nullifier = ?',
    );
    return stmt.get(nullifier) !== undefined;
  }

  /**
   * Get refund redemption details
   */
  getRefundRedemption(nullifier: string): RefundRedemption | null {
    const stmt = this.db.prepare(
      'SELECT id_commitment, value, timestamp, recipient, tx_hash, redeemed_at FROM redeemed_refunds WHERE nullifier = ?',
    );
    const row = stmt.get(nullifier) as Omit<RefundRow, 'nullifier'> | undefined;

    if (!row) return null;

    return {
      idCommitment: row.id_commitment,
      value: row.value,
      timestamp: row.timestamp,
      recipient: row.recipient,
      txHash: row.tx_hash,
      redeemedAt: row.redeemed_at,
    };
  }

  /**
   * Get all redeemed refunds (for auditing)
   */
  getAllRedeemedRefunds(): Map<string, RefundRedemption> {
    const stmt = this.db.prepare(
      'SELECT nullifier, id_commitment, value, timestamp, recipient, tx_hash, redeemed_at FROM redeemed_refunds',
    );
    const rows = stmt.all() as RefundRow[];

    const map = new Map<string, RefundRedemption>();
    for (const row of rows) {
      map.set(row.nullifier, {
        idCommitment: row.id_commitment,
        value: row.value,
        timestamp: row.timestamp,
        recipient: row.recipient,
        txHash: row.tx_hash,
        redeemedAt: row.redeemed_at,
      });
    }
    return map;
  }

  /**
   * Get count of redeemed refunds
   */
  redeemedCount(): number {
    const stmt = this.db.prepare(
      'SELECT COUNT(*) as count FROM redeemed_refunds',
    );
    const row = stmt.get() as CountRow | undefined;
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
