import { Injectable, Logger } from '@nestjs/common';
import { ethers } from 'ethers';
import { BlockchainService } from './blockchain.service';

// Smart contract ABI for slashing functions
const SLASHING_ABI = [
  'function slashDoubleSpend(bytes32 _secretKey, bytes32 _nullifier, bytes32 _idCommitment, uint256[8] _proof, uint256[4] _publicSignals) external',
  'function slashPolicyViolation(bytes32 _nullifier, bytes32 _idCommitment, uint256[8] _proof, uint256[5] _publicSignals) external',
  'event DoubleSpendSlashed(bytes32 indexed secretKey, bytes32 indexed nullifier, address indexed slasher, uint256 reward)',
  'event PolicyViolationSlashed(bytes32 indexed nullifier, bytes32 indexed idCommitment, uint256 amountBurned, bytes32 evidenceHash)',
];

interface RlnSignal {
  x: string;
  y: string;
}

/**
 * Service for submitting slashing transactions to the LongjingCredits smart contract
 * Handles double-spend detection and onchain slashing
 */
@Injectable()
export class SlashingService {
  private readonly logger = new Logger(SlashingService.name);

  /**
   * Shares BlockchainService's RPC and signer, so slashing follows the
   * profile: the identity key in prod, ANVIL_PRIVATE_KEY in local.
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
   * Submit a slashing transaction for double-spend
   * @param secretKey The extracted secret key (0x-prefixed hex string)
   * @param nullifier The nullifier used in both signals
   * @param idCommitment The user's identity commitment
   * @param signal1 First RLN signal
   * @param signal2 Second RLN signal
   * @param ticketIndex Ticket index from the request
   * @param proof ZK proof of correct secret key extraction
   * @param publicSignals Public signals for the proof
   * @returns Transaction hash if successful
   */
  async slashDoubleSpend(
    secretKey: string,
    nullifier: string,
    idCommitment: string,
    signal1: RlnSignal,
    signal2: RlnSignal,
    ticketIndex: string,
    proof: string[],
    publicSignals: string[],
  ): Promise<string | null> {
    const contract = this.slashingContract();
    if (!contract) {
      this.logger.warn(
        'Slashing transaction skipped - contract not configured',
      );
      return null;
    }

    try {
      this.logger.log(
        `Submitting slashing transaction for secret key: ${secretKey.slice(0, 10)}...`,
      );

      this.logger.debug('Slashing parameters:', {
        secretKey: secretKey.slice(0, 10) + '...',
        nullifier: nullifier.slice(0, 10) + '...',
        idCommitment: idCommitment.slice(0, 10) + '...',
        proofLength: proof.length,
        publicSignalsLength: publicSignals.length,
      });

      // Convert to BigInt arrays for contract call
      const proofBigInts = proof.map((p) => BigInt(p));
      const publicSignalsBigInts = publicSignals.map((s) => BigInt(s));

      // Submit transaction with ZK proof
      // Contract signature: slashDoubleSpend(bytes32 _secretKey, bytes32 _nullifier, bytes32 _idCommitment, uint256[8] _proof, uint256[4] _publicSignals)
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const tx = await contract.slashDoubleSpend(
        secretKey,
        nullifier,
        idCommitment,
        proofBigInts,
        publicSignalsBigInts,
      );

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const txHash = tx.hash as string;
      this.logger.log(`Slashing transaction submitted: ${txHash}`);

      // Wait for confirmation
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      const receipt = await tx.wait();

      this.logger.log(
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        `Slashing transaction confirmed in block ${receipt?.blockNumber || 'unknown'}`,
      );

      // Parse event logs to get reward amount
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (receipt && receipt.logs) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        const event = receipt.logs
          .map((log: { topics: string[]; data: string }) => {
            try {
              return contract.interface.parseLog({
                topics: log.topics,
                data: log.data,
              });
            } catch {
              return null;
            }
          })
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          .find(
            (parsedLog: { name?: string } | null) =>
              parsedLog?.name === 'DoubleSpendSlashed',
          );

        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        if (event && event.args) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
          const reward = event.args.reward;
          this.logger.log(
            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
            `Double-spend slashing successful! Reward: ${ethers.formatEther(reward)} ETH`,
          );
        }
      }

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

  /**
   * Submit a slashing transaction for policy violation
   * @param nullifier The nullifier from the violating request
   * @param idCommitment The user's identity commitment
   * @param proof ZK proof components [pA, pB, pC]
   * @param publicSignals Public signals in snarkjs order [evidenceHash, nullifier, idCommitment, nullifierExpected, idCommitmentExpected]
   * @returns Transaction hash if successful
   */
  async slashPolicyViolation(
    nullifier: string,
    idCommitment: string,
    proof: bigint[],
    publicSignals: bigint[],
  ): Promise<string | null> {
    const contract = this.slashingContract();
    if (!contract) {
      this.logger.warn(
        'Policy slashing transaction skipped - contract not configured',
      );
      return null;
    }

    try {
      this.logger.log(
        `Submitting policy slashing transaction for nullifier: ${nullifier.slice(0, 10)}...`,
      );

      // Submit transaction
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const tx = await contract.slashPolicyViolation(
        nullifier,
        idCommitment,
        proof,
        publicSignals,
      );

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const txHash = tx.hash as string;
      this.logger.log(`Policy slashing transaction submitted: ${txHash}`);

      // Wait for confirmation
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      const receipt = await tx.wait();

      this.logger.log(
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        `Policy slashing transaction confirmed in block ${receipt?.blockNumber || 'unknown'}`,
      );

      return txHash;
    } catch (error) {
      this.logger.error('Failed to submit policy slashing transaction', error);
      throw new Error('Policy slashing transaction failed', { cause: error });
    }
  }
}
