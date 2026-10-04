import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SlashingService } from './slashing.service';

describe('SlashingService', () => {
  let service: SlashingService;
  let configService: ConfigService;

  const mockConfigService = {
    get: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SlashingService,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<SlashingService>(SlashingService);
    configService = module.get<ConfigService>(ConfigService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('isEnabled', () => {
    it('should return false when contract is not configured', () => {
      mockConfigService.get.mockReturnValue(undefined);
      const unconfiguredService = new SlashingService(configService);
      expect(unconfiguredService.isEnabled()).toBe(false);
    });

    it('should return true when contract is configured', () => {
      mockConfigService.get
        .mockReturnValueOnce('http://127.0.0.1:8545') // ANVIL_RPC_URL
        .mockReturnValueOnce(
          '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        ) // ANVIL_PRIVATE_KEY
        .mockReturnValueOnce('0x5FbDB2315678afecb367f032d93F642f64180aa3'); // ZK_CONTRACT_ADDRESS

      const configuredService = new SlashingService(configService);
      expect(configuredService.isEnabled()).toBe(true);
    });
  });

  describe('getContractAddress', () => {
    it('should return null when not configured', () => {
      mockConfigService.get.mockReturnValue(undefined);
      const unconfiguredService = new SlashingService(configService);
      expect(unconfiguredService.getContractAddress()).toBeNull();
    });

    it('should return contract address when configured', () => {
      const contractAddress = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
      mockConfigService.get
        .mockReturnValueOnce('http://127.0.0.1:8545') // ANVIL_RPC_URL
        .mockReturnValueOnce(
          '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        ) // ANVIL_PRIVATE_KEY
        .mockReturnValueOnce(contractAddress); // ZK_CONTRACT_ADDRESS

      const configuredService = new SlashingService(configService);
      expect(configuredService.getContractAddress()).toBe(contractAddress);
    });
  });

  describe('getSlasherAddress', () => {
    it('should return null when not configured', () => {
      mockConfigService.get.mockReturnValue(undefined);
      const unconfiguredService = new SlashingService(configService);
      expect(unconfiguredService.getSlasherAddress()).toBeNull();
    });

    it('should return slasher address when configured', () => {
      mockConfigService.get
        .mockReturnValueOnce('http://127.0.0.1:8545') // ANVIL_RPC_URL
        .mockReturnValueOnce(
          '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        ) // ANVIL_PRIVATE_KEY
        .mockReturnValueOnce('0x5FbDB2315678afecb367f032d93F642f64180aa3'); // ZK_CONTRACT_ADDRESS

      const configuredService = new SlashingService(configService);
      const slasherAddress = configuredService.getSlasherAddress();
      expect(slasherAddress).toBeTruthy();
      expect(slasherAddress).toMatch(/^0x[a-fA-F0-9]{40}$/); // Valid Ethereum address
    });
  });

  describe('slashDoubleSpend', () => {
    it('should return null when contract is not configured', async () => {
      mockConfigService.get.mockReturnValue(undefined);
      const unconfiguredService = new SlashingService(configService);

      const result = await unconfiguredService.slashDoubleSpend(
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        { x: '1', y: '2' },
        { x: '3', y: '4' },
      );

      expect(result).toBeNull();
    });

    // Integration tests with actual contract would go here
    // These would require a running Anvil instance and deployed contract
  });
});
