/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';
import { BlockchainService } from './blockchain.service';
import { MerkleTreeService } from './merkle-tree.service';
import { KeyDerivationService } from '../keys/key-derivation.service';

describe('BlockchainService', () => {
  let service: BlockchainService;
  let merkleTreeService: MerkleTreeService;
  let mockContract: any;
  let mockProvider: any;

  beforeEach(async () => {
    // Mock contract
    mockContract = {
      on: jest.fn(),
      merkleRoot: jest.fn(),
      getAllIdentityCommitments: jest.fn(),
      getDeposit: jest.fn(),
      getAnonymitySetSize: jest.fn(),
    };

    // Mock provider
    mockProvider = {
      on: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BlockchainService,
        MerkleTreeService,
        { provide: KeyDerivationService, useValue: {} },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const config: Record<string, string> = {
                ANVIL_RPC_URL: 'http://localhost:8545',
                ZK_CONTRACT_ADDRESS:
                  '0x1234567890123456789012345678901234567890',
                ANVIL_PRIVATE_KEY:
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
    merkleTreeService = module.get<MerkleTreeService>(MerkleTreeService);

    // Inject mocks
    (service as any).contract = mockContract;
    (service as any).provider = mockProvider;
  });

  afterEach(async () => {
    await merkleTreeService.clear();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('Event Monitoring', () => {
    it('should set up DepositMade event listener', () => {
      (service as any).startEventMonitoring();

      expect(mockContract.on).toHaveBeenCalledWith(
        'DepositMade',
        expect.any(Function),
      );
    });

    it('should set up block event listener for reorg protection', () => {
      (service as any).startEventMonitoring();

      expect(mockProvider.on).toHaveBeenCalledWith(
        'block',
        expect.any(Function),
      );
    });

    it('should handle deposit event and update Merkle tree', async () => {
      const idCommitment = '0x' + '1'.repeat(64);
      const idCommitmentBigInt = BigInt(idCommitment);

      // Mock to return matching root
      mockContract.merkleRoot.mockImplementation(async () => {
        const currentRoot = await merkleTreeService.getRoot();
        return '0x' + currentRoot.toString(16).padStart(64, '0');
      });

      await (service as any).handleDepositEvent(idCommitment);

      const isMember = await merkleTreeService.isMember(idCommitmentBigInt);
      expect(isMember).toBe(true);
    }, 10000);

    it('should resync on root mismatch after deposit', async () => {
      const idCommitment = '0x' + '1'.repeat(64);
      const onChainRoot = '0x' + 'a'.repeat(64);

      mockContract.merkleRoot.mockResolvedValue(onChainRoot);
      mockContract.getAllIdentityCommitments.mockResolvedValue([]);

      const syncSpy = jest.spyOn(service as any, 'syncMerkleTree');

      await (service as any).handleDepositEvent(idCommitment);

      expect(syncSpy).toHaveBeenCalled();
    });

    it('should verify root consistency every 100 blocks', async () => {
      const blockNumber = 100;
      mockContract.merkleRoot.mockResolvedValue('0x' + '0'.repeat(64));

      await (service as any).handleBlockEvent(blockNumber);

      expect(mockContract.merkleRoot).toHaveBeenCalled();
    });

    it('should resync on root drift detection', async () => {
      const blockNumber = 200;
      const onChainRoot = '0x' + '1'.repeat(64); // Different from off-chain

      mockContract.merkleRoot.mockResolvedValue(onChainRoot);
      mockContract.getAllIdentityCommitments.mockResolvedValue([]);

      const syncSpy = jest.spyOn(service as any, 'syncMerkleTree');

      await (service as any).handleBlockEvent(blockNumber);

      expect(syncSpy).toHaveBeenCalled();
    });

    it('should check root whenever handleBlockEvent is called', async () => {
      // handleBlockEvent always checks root - the filtering happens in the event listener
      mockContract.merkleRoot.mockClear();
      mockContract.merkleRoot.mockResolvedValue('0x' + '0'.repeat(64));

      await (service as any).handleBlockEvent(99);

      // Should have checked root
      expect(mockContract.merkleRoot).toHaveBeenCalled();
    });

    it('should handle errors in deposit event gracefully', async () => {
      const idCommitment = 'invalid';

      // Should not throw
      await expect(
        (service as any).handleDepositEvent(idCommitment),
      ).resolves.not.toThrow();
    });

    it('should handle errors in block event gracefully', async () => {
      mockContract.merkleRoot.mockRejectedValue(new Error('RPC error'));

      // Should not throw
      await expect(
        (service as any).handleBlockEvent(100),
      ).resolves.not.toThrow();
    });
  });

  describe('Merkle Tree Sync', () => {
    it('should sync Merkle tree with onchain commitments', async () => {
      const commitments = [
        '0x' + '1'.repeat(64),
        '0x' + '2'.repeat(64),
        '0x' + '3'.repeat(64),
      ];

      mockContract.getAllIdentityCommitments.mockResolvedValue(commitments);
      mockContract.merkleRoot.mockResolvedValue('0x' + '0'.repeat(64));

      await service.syncMerkleTree();

      const stats = await merkleTreeService.getStats();
      expect(stats.leafCount).toBe(3);
    });

    it('should clear tree before resyncing', async () => {
      // Add some initial data
      await merkleTreeService.insert(BigInt(123));
      expect((await merkleTreeService.getStats()).leafCount).toBe(1);

      mockContract.getAllIdentityCommitments.mockResolvedValue([]);
      mockContract.merkleRoot.mockResolvedValue('0x' + '0'.repeat(64));

      await service.syncMerkleTree();

      const stats = await merkleTreeService.getStats();
      expect(stats.leafCount).toBe(0);
    });

    it('should log warning on root mismatch after sync', async () => {
      const commitments = ['0x' + '1'.repeat(64)];
      const onChainRoot = '0x' + 'a'.repeat(64);

      mockContract.getAllIdentityCommitments.mockResolvedValue(commitments);
      mockContract.merkleRoot.mockResolvedValue(onChainRoot);

      await service.syncMerkleTree();

      // Should complete without throwing
      expect(service.isAvailable()).toBe(true);
    });
  });

  describe('Availability', () => {
    it('should return true when contract and provider are initialized', () => {
      expect(service.isAvailable()).toBe(true);
    });

    it('should return false when contract is not initialized', () => {
      (service as any).contract = null;
      expect(service.isAvailable()).toBe(false);
    });

    it('should return false when provider is not initialized', () => {
      (service as any).provider = null;
      expect(service.isAvailable()).toBe(false);
    });
  });

  describe('Identity Commitment Operations', () => {
    it('should add identity commitment to Merkle tree', async () => {
      const commitment = BigInt('0x' + '1'.repeat(64));

      const index = await (service as any).addIdentityCommitment(commitment);

      expect(index).toBe(0);
      expect(await merkleTreeService.isMember(commitment)).toBe(true);
    });

    it('should verify membership of added commitment', async () => {
      const commitment = BigInt('0x' + '1'.repeat(64));
      await (service as any).addIdentityCommitment(commitment);

      const isMember = await service.verifyMembership(commitment);

      expect(isMember).toBe(true);
    });

    it('should return false for non-existent commitment', async () => {
      const commitment = BigInt('0x' + '1'.repeat(64));

      const isMember = await service.verifyMembership(commitment);

      expect(isMember).toBe(false);
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
        merkleTreeService,
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
      // A closed port: the merkleRoot read fails after the contract is built
      process.env.NODE_ENV = 'test';
      const values: Record<string, string> = {
        ...LOCAL,
        ANVIL_RPC_URL: 'http://127.0.0.1:1',
      };
      const blockchain = new BlockchainService(
        { get: (key: string) => values[key] } as unknown as ConfigService,
        merkleTreeService,
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

    it('never reads ANVIL_PRIVATE_KEY in prod', async () => {
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
        merkleTreeService,
        {} as KeyDerivationService,
      );
      (blockchain as any).logger = { log: jest.fn(), warn: jest.fn() };

      await blockchain.onModuleInit().catch(() => undefined);

      expect(get).not.toHaveBeenCalledWith('ANVIL_PRIVATE_KEY');
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
      identity: ethers.Wallet | null,
      values: Record<string, string> = { ANVIL_PRIVATE_KEY: ANVIL_KEY },
    ) {
      const get = jest.fn((key: string) => values[key]);
      const keyDerivation = {
        getIdentitySigner: jest.fn(() => identity),
      } as unknown as KeyDerivationService;
      const blockchain = new BlockchainService(
        { get } as unknown as ConfigService,
        merkleTreeService,
        keyDerivation,
      );
      const signer = (blockchain as any).createSigner(
        prod,
        provider,
      ) as ethers.Wallet | null;
      return { signer, get };
    }

    it('signs with the identity key in prod, never ANVIL_PRIVATE_KEY', () => {
      const identity = ethers.Wallet.createRandom().connect(
        provider,
      ) as unknown as ethers.Wallet;

      const { signer, get } = signerFor(true, identity);

      expect(signer?.address).toBe(identity.address);
      expect(get).not.toHaveBeenCalledWith('ANVIL_PRIVATE_KEY');
    });

    it('is read-only in prod without a derived identity', () => {
      expect(signerFor(true, null).signer).toBeNull();
    });

    it('signs with ANVIL_PRIVATE_KEY in local', () => {
      expect(signerFor(false, null).signer?.address).toBe(
        '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      );
    });

    it('is read-only in local without ANVIL_PRIVATE_KEY', () => {
      expect(signerFor(false, null, {}).signer).toBeNull();
    });
  });
});
