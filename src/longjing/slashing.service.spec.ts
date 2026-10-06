import { ethers } from 'ethers';
import { BlockchainService } from './blockchain.service';
import { SlashingService } from './slashing.service';

describe('SlashingService', () => {
  const contractAddress = '0x1111111111111111111111111111111111111111';
  const signer = ethers.Wallet.createRandom() as unknown as ethers.Wallet;

  const create = (
    wallet: ethers.Wallet | null,
    address: string | null = contractAddress,
  ) =>
    new SlashingService({
      getSigner: () => wallet,
      getContractAddress: () => address,
    } as unknown as BlockchainService);

  describe('isEnabled', () => {
    it('is enabled with a contract and a signer', () => {
      expect(create(signer).isEnabled()).toBe(true);
    });

    it('is disabled without a signer', () => {
      expect(create(null).isEnabled()).toBe(false);
    });

    it('is disabled without a contract', () => {
      expect(create(signer, null).isEnabled()).toBe(false);
    });
  });

  describe('getContractAddress', () => {
    it("returns BlockchainService's contract address", () => {
      expect(create(signer).getContractAddress()).toBe(contractAddress);
    });

    it('returns null when not configured', () => {
      expect(create(null, null).getContractAddress()).toBeNull();
    });
  });

  describe('getSlasherAddress', () => {
    it("returns BlockchainService's signer address", () => {
      expect(create(signer).getSlasherAddress()).toBe(signer.address);
    });

    it('returns null without a signer', () => {
      expect(create(null).getSlasherAddress()).toBeNull();
    });
  });

  describe('slashDoubleSpend', () => {
    it('returns null when slashing is disabled', async () => {
      const result = await create(null).slashDoubleSpend(
        '0x' + '12'.repeat(32),
        '0x' + 'ab'.repeat(32),
        '0x' + 'cd'.repeat(32),
        { x: '1', y: '2' },
        { x: '3', y: '4' },
        '0',
        [],
        [],
      );

      expect(result).toBeNull();
    });
  });

  describe('slashPolicyStake', () => {
    it('returns null when slashing is disabled', async () => {
      const result = await create(null).slashPolicyStake(
        '0x' + 'ab'.repeat(32),
        '0x' + 'cd'.repeat(32),
      );

      expect(result).toBeNull();
    });
  });
});
