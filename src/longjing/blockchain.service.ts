import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';
import LongjingCreditsABI from './contracts/LongjingCredits.abi.json';
import { MerkleTreeService } from './merkle-tree.service';
import { isProd } from '../config/profile';
import { KeyDerivationService } from '../keys/key-derivation.service';
import { assertChainMatchesProfile, fetchChainId, selectRpcUrl } from './chain';

/**
 * Service for interacting with the LongjingCredits smart contract
 * and maintaining an off-chain Merkle tree for proof generation
 */
@Injectable()
export class BlockchainService implements OnModuleInit {
  private readonly logger = new Logger(BlockchainService.name);
  private provider: ethers.JsonRpcProvider | null = null;
  private contract: ethers.Contract | null = null;
  private wallet: ethers.Wallet | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly merkleTree: MerkleTreeService,
    private readonly keyDerivation: KeyDerivationService,
  ) {}

  async onModuleInit() {
    const prod = isProd();
    const rpcUrl = selectRpcUrl(this.configService);
    const contractAddress = this.configService.get<string>(
      'ZK_CONTRACT_ADDRESS',
    );

    if (!rpcUrl || !contractAddress) {
      if (prod) {
        throw new Error(
          'PROFILE=prod requires ETHEREUM_RPC_URLS and ZK_CONTRACT_ADDRESS',
        );
      }
      this.logger.warn(
        'Blockchain configuration not found. Contract interaction will be disabled.',
      );
      return;
    }

    let chainId: bigint;
    try {
      chainId = await fetchChainId(rpcUrl);
    } catch (error) {
      if (prod) {
        throw new Error('Cannot start in production: RPC unreachable', {
          cause: error,
        });
      }
      this.logger.warn(
        `RPC unreachable at ${rpcUrl}. Contract interaction will be disabled.`,
      );
      return;
    }
    assertChainMatchesProfile(chainId);

    try {
      this.logger.log(`Connecting to RPC: ${rpcUrl} (chain ${chainId})`);
      this.provider = new ethers.JsonRpcProvider(rpcUrl, chainId, {
        staticNetwork: true,
      });
      this.contract = new ethers.Contract(
        contractAddress,
        LongjingCreditsABI,
        this.provider,
      );

      this.wallet = this.createSigner(prod, this.provider);
      if (this.wallet) {
        this.logger.log(`Transactions signed by ${this.wallet.address}`);
        this.contract = this.contract.connect(this.wallet) as ethers.Contract;
      } else {
        this.logger.warn('No transaction signer: contract access is read-only');
      }

      // Test connection
      const merkleRoot = (await this.contract.merkleRoot()) as string;
      this.logger.log(
        `Connected to LongjingCredits at ${contractAddress}. Merkle root: ${merkleRoot}`,
      );

      // Sync Merkle tree with onchain state
      await this.syncMerkleTree();

      // Start listening for new deposits
      this.startEventMonitoring();
    } catch (error) {
      if (prod) {
        throw new Error('Cannot start in production: blockchain unavailable', {
          cause: error,
        });
      }
      this.logger.error('Failed to connect to blockchain', error);
    }
  }

  /** The connected transaction signer, or null when read-only. */
  getSigner(): ethers.Wallet | null {
    return this.contract ? this.wallet : null;
  }

  getContractAddress(): string | null {
    return this.contract ? (this.contract.target as string) : null;
  }

  /**
   * prod signs with the enclave-derived identity key, local with
   * ANVIL_PRIVATE_KEY. Neither falls back to the other.
   */
  private createSigner(
    prod: boolean,
    provider: ethers.Provider,
  ): ethers.Wallet | null {
    if (prod) {
      return this.keyDerivation.getIdentitySigner(provider);
    }
    const privateKey = this.configService.get<string>('ANVIL_PRIVATE_KEY');
    return privateKey ? new ethers.Wallet(privateKey, provider) : null;
  }

  /**
   * Sync off-chain Merkle tree with onchain identity commitments
   */
  async syncMerkleTree(): Promise<void> {
    if (!this.contract) {
      this.logger.warn('Cannot sync Merkle tree - blockchain not initialized');
      return;
    }

    try {
      const commitments = await this.getAllIdentityCommitments();
      await this.merkleTree.clear();

      if (commitments.length === 0) {
        this.logger.log('No identity commitments found onchain');
        return;
      }

      const bigintCommitments = commitments.map((c) => BigInt(c));
      await this.merkleTree.insertBatch(bigintCommitments);

      const offChainRoot = await this.merkleTree.getRoot();
      const onChainRoot = await this.getMerkleRoot();

      this.logger.log(
        `Merkle tree synced: ${commitments.length} commitments loaded`,
      );
      this.logger.debug(`Off-chain root: 0x${offChainRoot.toString(16)}`);
      this.logger.debug(`Onchain root:  ${onChainRoot}`);

      // Verify roots match
      const offChainRootHex =
        '0x' + offChainRoot.toString(16).padStart(64, '0');
      if (offChainRootHex.toLowerCase() !== onChainRoot.toLowerCase()) {
        this.logger.warn('Merkle root mismatch between off-chain and onchain!');
      }
    } catch (error) {
      this.logger.error('Failed to sync Merkle tree', error);
      throw error;
    }
  }

  /**
   * Get the current Merkle root from the contract
   */
  async getMerkleRoot(): Promise<string> {
    if (!this.contract) {
      throw new Error('Blockchain service not initialized');
    }

    return (await this.contract.merkleRoot()) as string;
  }

  /**
   * Check if an identity commitment has an active deposit
   */
  async hasActiveDeposit(idCommitment: string): Promise<boolean> {
    if (!this.contract) {
      throw new Error('Blockchain service not initialized');
    }

    const deposit = (await this.contract.getDeposit(idCommitment)) as {
      active: boolean;
    };
    return deposit.active;
  }

  /**
   * Get deposit details for an identity commitment
   */
  async getDeposit(idCommitment: string): Promise<{
    idCommitment: string;
    rlnStake: bigint;
    policyStake: bigint;
    timestamp: bigint;
    active: boolean;
  }> {
    if (!this.contract) {
      throw new Error('Blockchain service not initialized');
    }

    return (await this.contract.getDeposit(idCommitment)) as {
      idCommitment: string;
      rlnStake: bigint;
      policyStake: bigint;
      timestamp: bigint;
      active: boolean;
    };
  }

  /**
   * Get all identity commitments (for building Merkle tree)
   */
  async getAllIdentityCommitments(): Promise<string[]> {
    if (!this.contract) {
      throw new Error('Blockchain service not initialized');
    }

    return (await this.contract.getAllIdentityCommitments()) as string[];
  }

  /**
   * Get the size of the anonymity set
   */
  async getAnonymitySetSize(): Promise<number> {
    if (!this.contract) {
      throw new Error('Blockchain service not initialized');
    }

    const size = (await this.contract.getAnonymitySetSize()) as bigint;
    return Number(size);
  }

  /**
   * Check if a nullifier has been slashed
   */
  async isNullifierSlashed(nullifier: string): Promise<boolean> {
    if (!this.contract) {
      throw new Error('Blockchain service not initialized');
    }

    return (await this.contract.slashedNullifiers(nullifier)) as boolean;
  }

  /**
   * Get server address from contract
   */
  async getServerAddress(): Promise<string> {
    if (!this.contract) {
      throw new Error('Blockchain service not initialized');
    }

    return (await this.contract.serverAddress()) as string;
  }

  /**
   * Get minimum stake requirements
   */
  async getMinStakes(): Promise<{
    minRlnStake: bigint;
    minPolicyStake: bigint;
  }> {
    if (!this.contract) {
      throw new Error('Blockchain service not initialized');
    }

    const minRlnStake = (await this.contract.minRlnStake()) as bigint;
    const minPolicyStake = (await this.contract.minPolicyStake()) as bigint;

    return { minRlnStake, minPolicyStake };
  }

  /**
   * Get Merkle proof for an identity commitment
   */
  async getMerkleProof(idCommitment: bigint): Promise<{
    pathElements: string[];
    pathIndices: number[];
    leaf: string;
    root: string;
  }> {
    const leafIndex = await this.merkleTree.findLeafIndex(idCommitment);
    if (leafIndex === -1) {
      throw new Error('Identity commitment not found in Merkle tree');
    }

    const proof = await this.merkleTree.generateProof(leafIndex);

    return {
      pathElements: proof.pathElements.map(
        (e) => '0x' + e.toString(16).padStart(64, '0'),
      ),
      pathIndices: proof.pathIndices,
      leaf: '0x' + proof.leaf.toString(16).padStart(64, '0'),
      root: '0x' + proof.root.toString(16).padStart(64, '0'),
    };
  }

  /**
   * Verify if an identity commitment is a member of the Merkle tree
   */
  async verifyMembership(idCommitment: bigint): Promise<boolean> {
    return await this.merkleTree.isMember(idCommitment);
  }

  /**
   * Get Merkle tree statistics
   */
  async getMerkleTreeStats(): Promise<{
    depth: number;
    leafCount: number;
    capacity: number;
    root: string;
  }> {
    return await this.merkleTree.getStats();
  }

  /**
   * Add identity commitment to off-chain Merkle tree
   * Note: This should be called when monitoring onchain Deposit events
   */
  async addIdentityCommitment(idCommitment: bigint): Promise<number> {
    const index = await this.merkleTree.insert(idCommitment);
    this.logger.log(
      `Added identity commitment to Merkle tree at index ${index}`,
    );
    return index;
  }

  /**
   * Start monitoring onchain deposit events
   * Automatically updates off-chain Merkle tree when new deposits are made
   */
  private startEventMonitoring(): void {
    if (!this.contract) {
      this.logger.warn(
        'Cannot start event monitoring - contract not initialized',
      );
      return;
    }

    try {
      // Listen for new DepositMade events
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      this.contract.on(
        'DepositMade',
        (
          idCommitment: string,
          rlnStake: bigint,
          policyStake: bigint,
          timestamp: bigint,
          event: ethers.EventLog,
        ) => {
          this.logger.log(
            `Deposit event detected: idCommitment=${idCommitment}, block=${event.blockNumber}`,
          );

          // Handle event asynchronously
          void this.handleDepositEvent(idCommitment);
        },
      );

      // Handle chain reorganizations
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      this.provider?.on('block', (blockNumber: number) => {
        // Check periodically if we need to resync (every 100 blocks)
        if (blockNumber % 100 === 0) {
          void this.handleBlockEvent(blockNumber);
        }
      });

      this.logger.log('Event monitoring started for DepositMade events');
    } catch (error) {
      this.logger.error('Failed to start event monitoring', error);
    }
  }

  /**
   * Handle deposit event asynchronously
   */
  private async handleDepositEvent(idCommitment: string): Promise<void> {
    try {
      // Add to off-chain Merkle tree
      const commitmentBigInt = BigInt(idCommitment);
      const index = await this.addIdentityCommitment(commitmentBigInt);

      // Verify sync with onchain root
      const offChainRoot = await this.merkleTree.getRoot();
      const onChainRoot = await this.getMerkleRoot();
      const offChainRootHex =
        '0x' + offChainRoot.toString(16).padStart(64, '0');

      if (offChainRootHex.toLowerCase() === onChainRoot.toLowerCase()) {
        this.logger.log(
          `Merkle tree synced after deposit: index=${index}, root=${onChainRoot}`,
        );
      } else {
        this.logger.error(
          `Merkle root mismatch after deposit! Off-chain: ${offChainRootHex}, Onchain: ${onChainRoot}`,
        );
        // Attempt full resync
        await this.syncMerkleTree();
      }
    } catch (error) {
      this.logger.error('Failed to process deposit event', error);
      // Attempt full resync on error
      try {
        await this.syncMerkleTree();
      } catch (syncError) {
        this.logger.error('Failed to resync Merkle tree', syncError);
      }
    }
  }

  /**
   * Handle block event for periodic root verification
   */
  private async handleBlockEvent(blockNumber: number): Promise<void> {
    try {
      const offChainRoot = await this.merkleTree.getRoot();
      const onChainRoot = await this.getMerkleRoot();
      const offChainRootHex =
        '0x' + offChainRoot.toString(16).padStart(64, '0');

      if (offChainRootHex.toLowerCase() !== onChainRoot.toLowerCase()) {
        this.logger.warn(
          `Merkle root drift detected at block ${blockNumber}. Resyncing...`,
        );
        await this.syncMerkleTree();
      }
    } catch (error) {
      this.logger.error('Failed to handle block event', error);
    }
  }

  /**
   * Check if blockchain service is available
   */
  isAvailable(): boolean {
    return this.contract !== null && this.provider !== null;
  }

  /**
   * Redeem a refund ticket onchain using ZK proof
   * @param params Refund parameters including proof
   * @returns Transaction hash
   */
  async redeemRefund(params: {
    idCommitment: string;
    nullifier: string;
    refundValue: string;
    recipient: string;
    proof: number[];
    publicSignals: bigint[];
  }): Promise<string> {
    if (!this.contract || !this.wallet) {
      throw new Error(
        'Blockchain service not initialized or wallet not available',
      );
    }

    try {
      this.logger.log(
        `Redeeming refund for nullifier ${params.nullifier}, amount: ${params.refundValue} wei`,
      );

      // Contract expects: redeemRefund(bytes32, bytes32, uint256, address, uint256[8], uint256[7])
      const tx = (await this.contract.redeemRefund(
        params.idCommitment,
        params.nullifier,
        params.refundValue,
        params.recipient,
        params.proof,
        params.publicSignals,
      )) as ethers.ContractTransactionResponse;

      this.logger.log(`Refund redemption transaction submitted: ${tx.hash}`);

      const receipt = await tx.wait();
      this.logger.log(
        `Refund redemption confirmed in block ${receipt?.blockNumber}`,
      );

      return tx.hash;
    } catch (error) {
      this.logger.error('Failed to redeem refund', error);
      throw error;
    }
  }

  /**
   * Check if a refund has already been redeemed
   */
  async isRefundRedeemed(nullifier: string): Promise<boolean> {
    if (!this.contract) {
      throw new Error('Blockchain service not initialized');
    }

    return (await this.contract.redeemedRefunds(nullifier)) as boolean;
  }

  /**
   * Get server's EdDSA public key from contract
   */
  async getServerPublicKey(): Promise<{ x: string; y: string }> {
    if (!this.contract) {
      throw new Error('Blockchain service not initialized');
    }

    const pubKey = (await this.contract.serverPublicKey()) as {
      x: string;
      y: string;
    };
    return pubKey;
  }
}
