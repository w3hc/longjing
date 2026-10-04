import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { ethers } from 'ethers';

interface KrakenTickerResponse {
  error: string[];
  result: {
    XETHZUSD: {
      c: [string, string]; // Last trade: [price, lot volume]
    };
  };
}

interface EthRateRow {
  rate: number;
  source: string;
  timestamp: number;
}

@Injectable()
export class EthRateOracleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EthRateOracleService.name);
  private db: Database.Database;
  private dbPath: string;
  private cache: { rate: number; timestamp: number } | null = null;
  private readonly CACHE_TTL = 60_000; // 1 minute
  private readonly MAX_DB_RATE_AGE = 60 * 60 * 1000; // 1 hour
  private readonly KRAKEN_API_URL =
    'https://api.kraken.com/0/public/Ticker?pair=ETHUSD';
  // Chainlink ETH/USD Price Feed on Ethereum Mainnet
  private readonly CHAINLINK_ETH_USD_FEED =
    '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';
  private chainlinkProvider: ethers.JsonRpcProvider | null = null;

  constructor() {
    const dataDir = process.env.DATA_DIR || join(process.cwd(), 'data');
    this.dbPath =
      dataDir === ':memory:' ? ':memory:' : join(dataDir, 'eth-rates.db');
  }

  onModuleInit() {
    // Create data directory if it doesn't exist
    if (this.dbPath !== ':memory:') {
      const dir = join(this.dbPath, '..');
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new Database(this.dbPath);
    this.logger.log(`ETH rate database initialized at ${this.dbPath}`);

    // Create eth_rates table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS eth_rates (
        id INTEGER PRIMARY KEY,
        rate REAL NOT NULL,
        source TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_eth_rates_timestamp ON eth_rates(timestamp);
    `);

    // Initialize Chainlink provider from random endpoints
    this.initializeChainlinkProvider();
  }

  onModuleDestroy() {
    if (this.db) {
      this.db.close();
      this.logger.log('ETH rate database connection closed');
    }
  }

  /**
   * Initialize Chainlink provider with random RPC endpoints
   */
  private initializeChainlinkProvider(): void {
    try {
      const endpoints = [
        'https://ethereum-rpc.publicnode.com',
        'https://eth.merkle.io',
        'https://rpc.ankr.com/eth',
        'https://eth.llamarpc.com',
        'https://cloudflare-eth.com',
      ];

      const randomEndpoint =
        endpoints[Math.floor(Math.random() * endpoints.length)];
      this.chainlinkProvider = new ethers.JsonRpcProvider(randomEndpoint);
      this.logger.log(`Chainlink provider initialized: ${randomEndpoint}`);
    } catch (error) {
      this.logger.error('Failed to initialize Chainlink provider', error);
    }
  }

  /**
   * Get the current ETH/USD exchange rate
   * Priority: 1) Memory cache (1 min) -> 2) Kraken API -> 3) DB cache (<1h) -> 4) Chainlink
   */
  async getEthUsdRate(): Promise<number> {
    const now = Date.now();

    // 1. Return in-memory cached rate if still valid (< 1 minute)
    if (this.cache && now - this.cache.timestamp < this.CACHE_TTL) {
      this.logger.debug(`Using cached ETH/USD rate: ${this.cache.rate}`);
      return this.cache.rate;
    }

    // 2. Try to fetch from Kraken
    try {
      const rate = await this.fetchFromKraken();
      // Save to database and update cache
      this.saveRateToDb(rate, 'kraken');
      this.cache = { rate, timestamp: now };
      this.logger.log(`ETH/USD rate updated from Kraken: $${rate.toFixed(2)}`);
      return rate;
    } catch (error) {
      this.logger.error('Failed to fetch ETH/USD rate from Kraken', error);
    }

    // 3. Try to use database cache (if < 1 hour old)
    const dbRate = this.getLatestRateFromDb();
    if (dbRate && now - dbRate.timestamp < this.MAX_DB_RATE_AGE) {
      const ageMinutes = Math.floor((now - dbRate.timestamp) / 60000);
      this.logger.warn(
        `Using database cached rate (${ageMinutes} min old): $${dbRate.rate.toFixed(2)} from ${dbRate.source}`,
      );
      this.cache = { rate: dbRate.rate, timestamp: now };
      return dbRate.rate;
    }

    // 4. Fallback to Chainlink price feed
    try {
      const rate = await this.fetchFromChainlink();
      this.saveRateToDb(rate, 'chainlink');
      this.cache = { rate, timestamp: now };
      this.logger.log(
        `ETH/USD rate updated from Chainlink: $${rate.toFixed(2)}`,
      );
      return rate;
    } catch (error) {
      this.logger.error('Failed to fetch ETH/USD rate from Chainlink', error);
    }

    throw new Error(
      'Unable to fetch ETH/USD rate from any source (Kraken, DB cache, or Chainlink)',
    );
  }

  /**
   * Fetch ETH/USD rate from Kraken API
   */
  private async fetchFromKraken(): Promise<number> {
    const response = await fetch(this.KRAKEN_API_URL);

    if (!response.ok) {
      throw new Error(`Kraken API returned ${response.status}`);
    }

    const data = (await response.json()) as KrakenTickerResponse;

    if (data.error && data.error.length > 0) {
      throw new Error(`Kraken API error: ${data.error.join(', ')}`);
    }

    const rate = parseFloat(data.result.XETHZUSD.c[0]);

    if (isNaN(rate) || rate <= 0) {
      throw new Error(`Invalid ETH/USD rate received: ${rate}`);
    }

    return rate;
  }

  /**
   * Fetch ETH/USD rate from Chainlink price feed
   */
  private async fetchFromChainlink(): Promise<number> {
    if (!this.chainlinkProvider) {
      throw new Error('Chainlink provider not initialized');
    }

    // Chainlink Price Feed ABI (only the latestRoundData function we need)
    const aggregatorV3InterfaceABI = [
      {
        inputs: [],
        name: 'latestRoundData',
        outputs: [
          { internalType: 'uint80', name: 'roundId', type: 'uint80' },
          { internalType: 'int256', name: 'answer', type: 'int256' },
          { internalType: 'uint256', name: 'startedAt', type: 'uint256' },
          { internalType: 'uint256', name: 'updatedAt', type: 'uint256' },
          { internalType: 'uint80', name: 'answeredInRound', type: 'uint80' },
        ],
        stateMutability: 'view',
        type: 'function',
      },
    ];

    const priceFeed = new ethers.Contract(
      this.CHAINLINK_ETH_USD_FEED,
      aggregatorV3InterfaceABI,
      this.chainlinkProvider,
    );

    const roundData = (await priceFeed.latestRoundData()) as [
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
    ];
    const answer = roundData[1];

    // Chainlink ETH/USD has 8 decimals
    const rate = Number(answer) / 1e8;

    if (isNaN(rate) || rate <= 0) {
      throw new Error(`Invalid ETH/USD rate from Chainlink: ${rate}`);
    }

    return rate;
  }

  /**
   * Save rate to database
   */
  private saveRateToDb(rate: number, source: string): void {
    const timestamp = Date.now();
    const stmt = this.db.prepare(
      'INSERT INTO eth_rates (rate, source, timestamp) VALUES (?, ?, ?)',
    );
    stmt.run(rate, source, timestamp);
  }

  /**
   * Get latest rate from database
   */
  private getLatestRateFromDb(): EthRateRow | null {
    const stmt = this.db.prepare(
      'SELECT rate, source, timestamp FROM eth_rates ORDER BY timestamp DESC LIMIT 1',
    );
    const row = stmt.get() as EthRateRow | undefined;
    return row || null;
  }

  /**
   * Convert USD amount to ETH (in wei)
   */
  async usdToWei(usdAmount: number): Promise<bigint> {
    const ethUsdRate = await this.getEthUsdRate();
    const ethAmount = usdAmount / ethUsdRate;
    return BigInt(Math.ceil(ethAmount * 1e18));
  }

  /**
   * Convert wei to USD
   */
  async weiToUsd(weiAmount: bigint): Promise<number> {
    const ethUsdRate = await this.getEthUsdRate();
    const ethAmount = Number(weiAmount) / 1e18;
    return ethAmount * ethUsdRate;
  }
}
