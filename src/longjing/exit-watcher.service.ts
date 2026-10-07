import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { BlockchainService, WithdrawalInitiated } from './blockchain.service';
import { NullifierStoreService } from './nullifier-store.service';
import { SlashingService } from './slashing.service';

/**
 * Challenges exits that understate usage (docs/SETTLEMENT.md). An exit's RLN
 * signal sits at its claimed index n. If a request already used n, the store
 * holds another signal under the same nullifier, the two reveal k, and the
 * note is slashed within the window. Otherwise N is recorded, so no request
 * can use index n afterwards.
 */
@Injectable()
export class ExitWatcherService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ExitWatcherService.name);

  constructor(
    private readonly blockchain: BlockchainService,
    private readonly nullifierStore: NullifierStoreService,
    private readonly slashing: SlashingService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.blockchain.isAvailable()) {
      this.logger.warn('No contract: exits are watched once it answers');
    }
    await this.blockchain.onConnected(() => this.watch());
  }

  private async watch(): Promise<void> {
    await this.blockchain.watchWithdrawals(async (exit) => {
      try {
        await this.ingest(exit);
      } catch (error) {
        this.logger.error('Failed to check an exit', error);
      }
    });
    this.logger.log('Watching WithdrawalInitiated');
  }

  async ingest(exit: WithdrawalInitiated): Promise<void> {
    const signal = { x: exit.signalX.toString(), y: exit.signalY.toString() };
    const existing = this.nullifierStore.checkAndSet(
      exit.nullifier.toString(),
      signal,
    );
    if (existing && existing.x !== signal.x) {
      this.logger.warn('An exit reuses a spent nullifier, slashing the note');
      await this.slashing.slashRevealed(existing, signal);
    }
  }
}
