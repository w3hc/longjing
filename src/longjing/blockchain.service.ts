import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';
import LongjingCreditsABI from './contracts/LongjingCredits.abi.json';
import { isProd } from '../config/profile';
import { KeyDerivationService } from '../keys/key-derivation.service';
import { assertChainMatchesProfile, fetchChainId, selectRpcUrl } from './chain';

/** An exit's RLN signal at its claimed index */
export interface WithdrawalInitiated {
  nullifier: bigint;
  signalX: bigint;
  signalY: bigint;
}

// A little more than the 3-day challenge window at 12-second blocks
const WITHDRAWAL_LOOKBACK_BLOCKS = 25_000;

const toWithdrawal = (args: ethers.Result): WithdrawalInitiated => ({
  nullifier: args.nullifier as bigint,
  signalX: args.signalX as bigint,
  signalY: args.signalY as bigint,
});

/**
 * Reads LongjingCredits for the request path (recent roots, C_MAX, the refund
 * key) and sends the server's transactions
 */
@Injectable()
export class BlockchainService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BlockchainService.name);
  private provider: ethers.JsonRpcProvider | null = null;
  private contract: ethers.Contract | null = null;
  private wallet: ethers.Wallet | null = null;
  private cMax: bigint | null = null;

  constructor(
    private readonly configService: ConfigService,
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
          'NODE_ENV=production requires ETHEREUM_RPC_URLS and ZK_CONTRACT_ADDRESS',
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

      // C_MAX is immutable, so one read serves the contract's lifetime
      this.cMax = (await this.contract.C_MAX()) as bigint;
      this.logger.log(
        `Connected to LongjingCredits at ${contractAddress}, C_MAX ${this.cMax} wei`,
      );
    } catch (error) {
      if (prod) {
        throw new Error('Cannot start in production: blockchain unavailable', {
          cause: error,
        });
      }
      this.logger.error('Failed to connect to blockchain', error);
    }
  }

  /** Stops event polling, so no handler runs once the app is closing */
  async onModuleDestroy() {
    await this.contract?.removeAllListeners();
    this.provider?.destroy();
  }

  /** The connected transaction signer, or null when read-only. */
  getSigner(): ethers.Wallet | null {
    return this.contract ? this.wallet : null;
  }

  getContractAddress(): string | null {
    return this.contract ? (this.contract.target as string) : null;
  }

  /**
   * prod signs with the enclave-derived transaction signer, local with
   * SERVER_TX_PRIVATE_KEY. Neither falls back to the other.
   */
  private createSigner(
    prod: boolean,
    provider: ethers.Provider,
  ): ethers.Wallet | null {
    if (prod) {
      return this.keyDerivation.getTxSigner(provider);
    }
    const privateKey = this.configService.get<string>('SERVER_TX_PRIVATE_KEY');
    return privateKey ? new ethers.Wallet(privateKey, provider) : null;
  }

  isAvailable(): boolean {
    return this.contract !== null && this.provider !== null;
  }

  private connected(): ethers.Contract {
    if (!this.contract) {
      throw new Error('Blockchain service not initialized');
    }
    return this.contract;
  }

  async getMerkleRoot(): Promise<string> {
    return (await this.connected().merkleRoot()) as string;
  }

  /** Whether a request proof may use this root: one of the contract's recent roots */
  async isKnownRoot(root: string): Promise<boolean> {
    return (await this.connected().isKnownRoot(
      ethers.toBeHex(BigInt(root), 32),
    )) as boolean;
  }

  /** C_max in wei, a constant of the deployment */
  getCMax(): bigint {
    this.connected();
    if (this.cMax === null) {
      throw new Error('C_MAX not read from the contract');
    }
    return this.cMax;
  }

  async getNote(commitment: string): Promise<{
    amount: bigint;
    depositedAt: bigint;
    leafIndex: bigint;
    status: bigint;
  }> {
    return (await this.connected().getNote(commitment)) as {
      amount: bigint;
      depositedAt: bigint;
      leafIndex: bigint;
      status: bigint;
    };
  }

  /**
   * Calls the handler with every exit still within its challenge window, then
   * with each new one, so a claim that understates usage can be challenged
   */
  async watchWithdrawals(
    handler: (exit: WithdrawalInitiated) => Promise<void>,
  ): Promise<void> {
    const contract = this.connected();
    const latest = await this.provider!.getBlockNumber();
    const past = await contract.queryFilter(
      contract.filters.WithdrawalInitiated(),
      Math.max(0, latest - WITHDRAWAL_LOOKBACK_BLOCKS),
    );
    for (const event of past) {
      await handler(toWithdrawal((event as ethers.EventLog).args));
    }
    await contract.on(
      'WithdrawalInitiated',
      (...args: unknown[]) =>
        void handler(
          toWithdrawal((args.at(-1) as ethers.ContractEventPayload).args),
        ),
    );
  }

  async getServerAddress(): Promise<string> {
    return (await this.connected().serverAddress()) as string;
  }

  /** The refund signer key requests are checked against */
  async getServerPublicKey(): Promise<{ x: string; y: string }> {
    return (await this.connected().serverPublicKey()) as {
      x: string;
      y: string;
    };
  }
}
