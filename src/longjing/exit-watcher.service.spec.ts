import { BlockchainService } from './blockchain.service';
import { ExitWatcherService } from './exit-watcher.service';
import { NullifierStoreService } from './nullifier-store.service';
import { SlashingService } from './slashing.service';

describe('ExitWatcherService', () => {
  let store: NullifierStoreService;
  let slashRevealed: jest.Mock;
  let watcher: ExitWatcherService;

  beforeEach(() => {
    process.env.DATA_DIR = ':memory:';
    store = new NullifierStoreService();
    (store as unknown as { logger: object }).logger = {
      log: jest.fn(),
      debug: jest.fn(),
    };
    store.onModuleInit();
    slashRevealed = jest.fn().mockResolvedValue(undefined);
    watcher = new ExitWatcherService({} as BlockchainService, store, {
      slashRevealed,
    } as unknown as SlashingService);
  });

  afterEach(() => store.onModuleDestroy());

  it('records the exit nullifier, so no request can use index n afterwards', async () => {
    await watcher.ingest({ nullifier: 5n, signalX: 7n, signalY: 9n });

    expect(store.get('5')).toEqual({ x: '7', y: '9' });
    expect(store.checkAndSet('5', { x: '8', y: '10' })).toEqual({
      x: '7',
      y: '9',
    });
    expect(slashRevealed).not.toHaveBeenCalled();
  });

  it('slashes an exit whose index a request already used', async () => {
    store.checkAndSet('5', { x: '3', y: '4' });

    await watcher.ingest({ nullifier: 5n, signalX: 7n, signalY: 9n });

    expect(slashRevealed.mock.calls).toEqual([
      [
        { x: '3', y: '4' },
        { x: '7', y: '9' },
      ],
    ]);
  });

  it('ignores the same exit seen twice', async () => {
    await watcher.ingest({ nullifier: 5n, signalX: 7n, signalY: 9n });
    await watcher.ingest({ nullifier: 5n, signalX: 7n, signalY: 9n });
    expect(slashRevealed).not.toHaveBeenCalled();
  });
});
