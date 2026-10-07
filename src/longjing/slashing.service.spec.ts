import { ethers } from 'ethers';
import { BlockchainService } from './blockchain.service';
import { SlashingService } from './slashing.service';
import { BN254_SCALAR_FIELD } from './utils/payload-signal.util';

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

  describe('recoverSecretKey', () => {
    const p = BN254_SCALAR_FIELD;
    const k = 123456789n;
    const a = 987654321n;
    const signal = (x: bigint) => ({ x, y: (k + a * x) % p });

    it('recovers k from two signals on the same line', () => {
      expect(
        SlashingService.recoverSecretKey(signal(11n), signal(p - 22n)),
      ).toBe(k);
    });

    it('refuses two signals with the same x', () => {
      expect(() =>
        SlashingService.recoverSecretKey(signal(11n), signal(11n)),
      ).toThrow('Signals share x');
    });
  });

  describe('slash', () => {
    it('sends slash(k) and returns the transaction hash', async () => {
      const service = create(signer);
      const wait = jest.fn().mockResolvedValue({});
      const slash = jest.fn().mockResolvedValue({ hash: '0xabc', wait });
      jest.spyOn(service as any, 'slashingContract').mockReturnValue({ slash });

      await expect(service.slash(42n)).resolves.toBe('0xabc');
      expect(slash).toHaveBeenCalledWith(42n);
      expect(wait).toHaveBeenCalled();
    });

    it('slashes the key two signals reveal', async () => {
      const service = create(signer);
      const slash = jest.spyOn(service, 'slash').mockResolvedValue('0xabc');
      const k = 123456789n;
      const a = 987654321n;
      const p = BN254_SCALAR_FIELD;
      const signal = (x: bigint) => ({
        x: x.toString(),
        y: ((k + a * x) % p).toString(),
      });

      await service.slashRevealed(signal(11n), signal(22n));
      expect(slash.mock.calls).toEqual([[k]]);
    });

    it('does not slash when disabled', async () => {
      const service = create(null);
      const slash = jest.spyOn(service, 'slash');
      await service.slashRevealed({ x: '1', y: '2' }, { x: '3', y: '4' });
      expect(slash).not.toHaveBeenCalled();
    });

    it('skips without a contract', async () => {
      await expect(create(null, null).slash(42n)).resolves.toBeNull();
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
});
