import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';

/**
 * Shared database service for managing SQLite database connection
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  public db: Database.Database;
  private dbPath: string;

  constructor() {
    // Use environment variable or default to data directory
    const dataDir = process.env.DATA_DIR || join(process.cwd(), 'data');
    // Support in-memory database for testing
    this.dbPath =
      dataDir === ':memory:' ? ':memory:' : join(dataDir, 'longjing.db');
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

    // Enable foreign keys
    this.db.pragma('foreign_keys = ON');

    // Run migrations
    this.runMigrations();
  }

  onModuleDestroy() {
    if (this.db) {
      this.db.close();
      this.logger.log('Database connection closed');
    }
  }

  /**
   * Run database migrations
   */
  private runMigrations() {
    // Create pricing tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pricing_models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id TEXT NOT NULL,
        endpoint TEXT,
        pricing_type TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        rates TEXT NOT NULL,
        effective_from DATETIME NOT NULL,
        effective_until DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_pricing_provider
        ON pricing_models(provider_id, endpoint);
      CREATE INDEX IF NOT EXISTS idx_pricing_effective
        ON pricing_models(effective_from, effective_until);

      CREATE TABLE IF NOT EXISTS pricing_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id TEXT NOT NULL,
        endpoint TEXT,
        old_rates TEXT,
        new_rates TEXT,
        changed_by TEXT,
        changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        reason TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_pricing_history_provider
        ON pricing_history(provider_id);
    `);

    this.logger.log('Database migrations completed');
  }
}
