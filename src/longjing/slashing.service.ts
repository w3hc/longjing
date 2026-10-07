import { Injectable, Logger } from '@nestjs/common';
import { ethers } from 'ethers';
import { BlockchainService } from './blockchain.service';
import { BN254_SCALAR_FIELD } from './utils/payload-signal.util';

const SLASHING_ABI = [
  'function slash(uint256 _secretKey) external',
  'event Slashed(bytes32 indexed commitment, address indexed slasher, uint256 bounty)',
];

/**
 * Slashes notes whose secret key two RLN signals revealed. Knowing k is the
 * proof, so the transaction carries only k: the contract pays the bounty to
 * the caller and the rest of the note to the operator.
 */
@Injectable()
export class SlashingService {
  private readonly logger = new Logger(SlashingService.name);

  /**
   * Shares BlockchainService's RPC and signer, so slashing follows the
   * profile: the derived transaction signer in prod, SERVER_TX_PRIVATE_KEY in
   * local.
   */
  constructor(private readonly blockchain: BlockchainService) {}

  private slashingContract(): ethers.Contract | null {
    const signer = this.blockchain.getSigner();
    const address = this.blockchain.getContractAddress();
    return signer && address
      ? new ethers.Contract(address, SLASHING_ABI, signer)
      : null;
  }

  /**
   * Check if slashing is enabled (contract and signer are configured)
   */
  isEnabled(): boolean {
    return this.slashingContract() !== null;
  }

  /**
   * k = (y1 · x2 − y2 · x1) / (x2 − x1) mod p, from two signals that share a
   * nullifier
   */
  static recoverSecretKey(
    signal1: { x: bigint; y: bigint },
    signal2: { x: bigint; y: bigint },
  ): bigint {
    const p = BN254_SCALAR_FIELD;
    const mod = (v: bigint) => ((v % p) + p) % p;
    const denominator = mod(signal2.x - signal1.x);
    if (denominator === 0n) {
      throw new Error('Signals share x, so they reveal nothing');
    }
    let inverse = 1n;
    let base = denominator;
    for (let e = p - 2n; e > 0n; e >>= 1n) {
      if (e & 1n) inverse = (inverse * base) % p;
      base = (base * base) % p;
    }
    return mod((signal1.y * signal2.x - signal2.y * signal1.x) * inverse);
  }

  /**
   * Slash the note behind two signals that share a nullifier. A failure is
   * logged, not thrown: the caller rejects the request or exit either way.
   */
  async slashRevealed(
    signal1: { x: string; y: string },
    signal2: { x: string; y: string },
  ): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.warn(
        'Slashing disabled - no contract or transaction signer (see docs/LOCAL_SETUP.md)',
      );
      return;
    }
    try {
      const secretKey = SlashingService.recoverSecretKey(
        { x: BigInt(signal1.x), y: BigInt(signal1.y) },
        { x: BigInt(signal2.x), y: BigInt(signal2.y) },
      );
      await this.slash(secretKey);
    } catch (error) {
      this.logger.error('Failed to slash the double-spent note', error);
    }
  }

  /**
   * Slash the note whose secret key is k
   * @returns Transaction hash, or null when slashing is not configured
   */
  async slash(secretKey: bigint): Promise<string | null> {
    const contract = this.slashingContract();
    if (!contract) {
      this.logger.warn('Slashing skipped - contract not configured');
      return null;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const tx = await contract.slash(secretKey);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const txHash = tx.hash as string;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await tx.wait();
      this.logger.log(`Slashing transaction confirmed: ${txHash}`);
      return txHash;
    } catch (error) {
      this.logger.error('Failed to submit slashing transaction', error);
      throw new Error('Slashing transaction failed', { cause: error });
    }
  }

  /**
   * Get the contract address being used
   */
  getContractAddress(): string | null {
    return this.blockchain.getContractAddress();
  }

  /**
   * Get the wallet address being used for slashing
   */
  getSlasherAddress(): string | null {
    return this.blockchain.getSigner()?.address ?? null;
  }
}
