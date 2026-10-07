/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';
import { BlockchainService } from './blockchain.service';
import { KeyDerivationService } from '../keys/key-derivation.service';

describe('BlockchainService', () => {
  let service: BlockchainService;
  let mockContract: any;
  let mockProvider: any;

  beforeEach(async () => {
    // Mock contract
    mockContract = {
      merkleRoot: jest.fn(),
      isKnownRoot: jest.fn(),
    };

    // Mock provider
    mockProvider = {
      on: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BlockchainService,
        { provide: KeyDerivationService, useValue: {} },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const config: Record<string, string> = {
                ANVIL_RPC_URL: 'http://localhost:8545',
                ZK_CONTRACT_ADDRESS:
                  '0x1234567890123456789012345678901234567890',
                SERVER_TX_PRIVATE_KEY:
                  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
              };
              return config[key];
            }),
          },
        },
      ],
    })
      .setLogger({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        verbose: jest.fn(),
        fatal: jest.fn(),
      })
      .compile();

    service = module.get<BlockchainService>(BlockchainService);

    // Inject mocks
    (service as any).contract = mockContract;
    (service as any).provider = mockProvider;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('Contract reads', () => {
    it('should be available when contract and provider are initialized', () => {
      expect(service.isAvailable()).toBe(true);
    });

    it('should not be available without a contract', () => {
      (service as any).contract = null;
      expect(service.isAvailable()).toBe(false);
    });

    it('asks the contract about a root as bytes32, whatever its encoding', async () => {
      mockContract.isKnownRoot.mockResolvedValue(true);

      await expect(service.isKnownRoot('255')).resolves.toBe(true);
      expect(mockContract.isKnownRoot).toHaveBeenCalledWith(
        '0x' + 'ff'.padStart(64, '0'),
      );
    });

    it('returns the C_MAX read at startup', () => {
      (service as any).cMax = 10n ** 15n;
      expect(service.getCMax()).toBe(10n ** 15n);
    });

    it('refuses C_MAX before it was read', () => {
      expect(() => service.getCMax()).toThrow('C_MAX not read');
    });

    it('stops polling the chain on shutdown', async () => {
      mockContract.removeAllListeners = jest.fn().mockResolvedValue(undefined);
      mockProvider.destroy = jest.fn();

      await service.onModuleDestroy();

      expect(mockContract.removeAllListeners).toHaveBeenCalled();
      expect(mockProvider.destroy).toHaveBeenCalled();
    });

    it('refuses reads without a contract', async () => {
      (service as any).contract = null;
      await expect(service.isKnownRoot('1')).rejects.toThrow(
        'Blockchain service not initialized',
      );
    });
  });

  describe('Startup environment', () => {
    const LOCAL = {
      ANVIL_RPC_URL: 'http://127.0.0.1:8545',
      ZK_CONTRACT_ADDRESS: '0x1234567890123456789012345678901234567890',
    };
    const PROD = {
      ETHEREUM_RPC_URLS: 'https://eth.drpc.org',
      ZK_CONTRACT_ADDRESS: '0x1234567890123456789012345678901234567890',
    };

    function startup(nodeEnv: string, values: Record<string, string>) {
      process.env.NODE_ENV = nodeEnv;
      const config = { get: (key: string) => values[key] } as ConfigService;
      const blockchain = new BlockchainService(
        config,
        {} as KeyDerivationService,
      );
      (blockchain as any).logger = { log: jest.fn(), warn: jest.fn() };
      return blockchain.onModuleInit();
    }

    function chainId(hex: string) {
      return jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(
          Response.json({ jsonrpc: '2.0', id: 1, result: hex }),
        );
    }

    afterEach(() => {
      process.env.NODE_ENV = 'test';
      jest.restoreAllMocks();
    });

    it('starts without blockchain config in local', async () => {
      await expect(startup('test', {})).resolves.toBeUndefined();
    });

    it.each(['ETHEREUM_RPC_URLS', 'ZK_CONTRACT_ADDRESS'])(
      'refuses to start in prod without %s',
      async (name) => {
        await expect(
          startup('production', { ...PROD, [name]: '' }),
        ).rejects.toThrow('NODE_ENV=production requires');
      },
    );

    it('refuses a non-Anvil chain in local', async () => {
      chainId('0x1');

      await expect(startup('test', LOCAL)).rejects.toThrow(
        'NODE_ENV=development or test runs on Anvil only',
      );
    });

    it('refuses Anvil in prod', async () => {
      chainId('0x7a69');

      await expect(startup('production', PROD)).rejects.toThrow(
        'NODE_ENV=production refuses chain 31337',
      );
    });

    it('builds the contract once the chain matches', async () => {
      chainId('0x7a69');
      // A closed port: the C_MAX read fails after the contract is built
      process.env.NODE_ENV = 'test';
      const values: Record<string, string> = {
        ...LOCAL,
        ANVIL_RPC_URL: 'http://127.0.0.1:1',
      };
      const blockchain = new BlockchainService(
        { get: (key: string) => values[key] } as unknown as ConfigService,
        {} as KeyDerivationService,
      );
      (blockchain as any).logger = {
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      };

      await blockchain.onModuleInit();

      expect(blockchain.getContractAddress()).toBe(LOCAL.ZK_CONTRACT_ADDRESS);
    });

    it('disables the contract when the RPC is unreachable in local', async () => {
      jest
        .spyOn(global, 'fetch')
        .mockRejectedValue(new TypeError('fetch failed'));

      await expect(startup('test', LOCAL)).resolves.toBeUndefined();
    });

    it('refuses to start when the RPC is unreachable in prod', async () => {
      jest
        .spyOn(global, 'fetch')
        .mockRejectedValue(new TypeError('fetch failed'));

      await expect(startup('production', PROD)).rejects.toThrow(
        'Cannot start in production: RPC unreachable',
      );
    });

    it('never reads SERVER_TX_PRIVATE_KEY in prod', async () => {
      chainId('0x1');
      // A closed port, so ethers fails fast instead of reaching the network
      const values: Record<string, string> = {
        ...PROD,
        ETHEREUM_RPC_URLS: 'http://127.0.0.1:1',
      };
      const get = jest.fn((key: string) => values[key]);
      process.env.NODE_ENV = 'production';
      const blockchain = new BlockchainService(
        { get } as unknown as ConfigService,
        {} as KeyDerivationService,
      );
      (blockchain as any).logger = { log: jest.fn(), warn: jest.fn() };

      await blockchain.onModuleInit().catch(() => undefined);

      expect(get).not.toHaveBeenCalledWith('SERVER_TX_PRIVATE_KEY');
      expect(get).not.toHaveBeenCalledWith('ANVIL_RPC_URL');
    });
  });

  describe('Transaction signer', () => {
    const ANVIL_KEY =
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    const provider = new ethers.JsonRpcProvider('http://127.0.0.1:1', 1n, {
      staticNetwork: true,
    });

    function signerFor(
      prod: boolean,
      txSigner: ethers.Wallet | null,
      values: Record<string, string> = { SERVER_TX_PRIVATE_KEY: ANVIL_KEY },
    ) {
      const get = jest.fn((key: string) => values[key]);
      const keyDerivation = {
        getTxSigner: jest.fn(() => txSigner),
      } as unknown as KeyDerivationService;
      const blockchain = new BlockchainService(
        { get } as unknown as ConfigService,
        keyDerivation,
      );
      const signer = (blockchain as any).createSigner(
        prod,
        provider,
      ) as ethers.Wallet | null;
      return { signer, get };
    }

    it('signs with the derived transaction signer in prod, never SERVER_TX_PRIVATE_KEY', () => {
      const txSigner = ethers.Wallet.createRandom().connect(
        provider,
      ) as unknown as ethers.Wallet;

      const { signer, get } = signerFor(true, txSigner);

      expect(signer?.address).toBe(txSigner.address);
      expect(get).not.toHaveBeenCalledWith('SERVER_TX_PRIVATE_KEY');
    });

    it('is read-only in prod without a derived transaction signer', () => {
      expect(signerFor(true, null).signer).toBeNull();
    });

    it('signs with SERVER_TX_PRIVATE_KEY in local', () => {
      expect(signerFor(false, null).signer?.address).toBe(
        '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      );
    });

    it('is read-only in local without SERVER_TX_PRIVATE_KEY', () => {
      expect(signerFor(false, null, {}).signer).toBeNull();
    });
  });
});
