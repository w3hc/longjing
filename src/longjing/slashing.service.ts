import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';

// Smart contract ABI for slashing functions
const SLASHING_ABI = [
  'function slashDoubleSpend(bytes32 _secretKey, bytes32 _nullifier, bytes32 _idCommitment, uint256[8] _proof, uint256[4] _publicSignals) external',
  'function slashPolicyViolation(bytes32 _nullifier, bytes32 _idCommitment, uint256[8] _proof, uint256[3] _publicSignals) external',
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
  private readonly provider: ethers.Provider | null;
  private readonly wallet: ethers.Wallet | null;
  private readonly contract: ethers.Contract | null;
  private readonly contractAddress: string | null;

  constructor(private readonly configService: ConfigService) {
    // Get configuration
    const rpcUrl = this.configService.get<string>('ANVIL_RPC_URL');
    const privateKey = this.configService.get<string>('ANVIL_PRIVATE_KEY');
    this.contractAddress =
      this.configService.get<string>('ZK_CONTRACT_ADDRESS') || null;

    // Initialize provider and contract if all config is present
    if (rpcUrl && privateKey && this.contractAddress) {
      try {
        this.provider = new ethers.JsonRpcProvider(rpcUrl);
        this.wallet = new ethers.Wallet(privateKey, this.provider);
        this.contract = new ethers.Contract(
          this.contractAddress,
          SLASHING_ABI,
          this.wallet,
        );
        this.logger.log(
          `SlashingService initialized with contract at ${this.contractAddress}`,
        );
      } catch (error) {
        this.logger.warn(
          'Failed to initialize SlashingService - slashing will be disabled',
          error,
        );
        this.provider = null;
        this.wallet = null;
        this.contract = null;
      }
    } else {
      this.logger.warn(
        'SlashingService not configured - missing ANVIL_RPC_URL, ANVIL_PRIVATE_KEY, or ZK_CONTRACT_ADDRESS. Slashing will be disabled.',
      );
      this.provider = null;
      this.wallet = null;
      this.contract = null;
    }
  }

  /**
   * Check if slashing is enabled (contract is configured)
   */
  isEnabled(): boolean {
    return this.contract !== null;
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
    if (!this.contract) {
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
      const tx = await this.contract.slashDoubleSpend(
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
              return this.contract!.interface.parseLog({
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
    return this.contractAddress || null;
  }

  /**
   * Get the wallet address being used for slashing
   */
  getSlasherAddress(): string | null {
    return this.wallet?.address || null;
  }

  /**
   * Submit a slashing transaction for policy violation
   * @param nullifier The nullifier from the violating request
   * @param idCommitment The user's identity commitment
   * @param proof ZK proof components [pA, pB, pC]
   * @param publicSignals Public inputs [nullifierExpected, idCommitmentExpected, evidenceHash]
   * @returns Transaction hash if successful
   */
  async slashPolicyViolation(
    nullifier: string,
    idCommitment: string,
    proof: bigint[],
    publicSignals: bigint[],
  ): Promise<string | null> {
    if (!this.contract) {
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
      const tx = await this.contract.slashPolicyViolation(
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
