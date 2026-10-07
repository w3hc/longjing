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
import { RefundSignerService } from './refund-signer.service';
import { assertChainMatchesProfile, fetchChainId, selectRpcUrl } from './chain';

/** An exit's RLN signal at its claimed index */
export interface WithdrawalInitiated {
  nullifier: bigint;
  signalX: bigint;
  signalY: bigint;
}

// A little more than the 3-day challenge window at 12-second blocks
const WITHDRAWAL_LOOKBACK_BLOCKS = 25_000;

const CONNECT_RETRY_MS = 30_000;

/** A deployment no retry can fix: the wrong chain or the wrong refund key */
class Misconfigured extends Error {}

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
  private retry: NodeJS.Timeout | null = null;
  private destroyed = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly keyDerivation: KeyDerivationService,
    private readonly refundSigner: RefundSignerService,
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

    if (prod) {
      await this.connectProd(rpcUrl, contractAddress, true);
      return;
    }

    let chainId: bigint;
    try {
      chainId = await fetchChainId(rpcUrl);
    } catch {
      this.logger.warn(
        `RPC unreachable at ${rpcUrl}. Contract interaction will be disabled.`,
      );
      return;
    }
    assertChainMatchesProfile(chainId);

    try {
      const contract = this.build(rpcUrl, chainId, contractAddress, false);
      this.cMax = (await contract.C_MAX()) as bigint;
      this.logger.log(
        `Connected to LongjingCredits at ${contractAddress}, C_MAX ${this.cMax} wei`,
      );
    } catch (error) {
      this.logger.error('Failed to connect to blockchain', error);
    }
  }

  /**
   * Connects to LongjingCredits, and retries while the RPC or the contract
   * doesn't answer, so a first boot can publish the keys the contract is
   * deployed with. Until it answers, isAvailable() is false and requests are
   * refused. A wrong chain or refund key refuses to start when found at boot;
   * found later, requests stay refused.
   */
  private async connectProd(
    rpcUrl: string,
    address: string,
    atBoot: boolean,
  ): Promise<void> {
    try {
      const chainId = await fetchChainId(rpcUrl);
      try {
        assertChainMatchesProfile(chainId);
      } catch (error) {
        throw new Misconfigured((error as Error).message);
      }
      const contract = this.build(rpcUrl, chainId, address, true);
      // C_MAX is immutable, so one read serves the contract's lifetime
      this.cMax = (await contract.C_MAX()) as bigint;
      await this.checkServerKeys(contract);
    } catch (error) {
      this.disconnect();
      if (error instanceof Misconfigured) {
        if (atBoot) {
          throw error;
        }
        this.logger.error(`${error.message}, requests stay refused`);
        return;
      }
      if (!this.destroyed) {
        this.logger.warn(
          `LongjingCredits at ${address} does not answer, retrying in ${CONNECT_RETRY_MS / 1000} s: ${(error as Error).message}`,
        );
        this.retry = setTimeout(
          () => void this.connectProd(rpcUrl, address, false),
          CONNECT_RETRY_MS,
        ).unref();
      }
      return;
    }
    this.logger.log(
      `Connected to LongjingCredits at ${address}, C_MAX ${this.cMax} wei`,
    );
  }

  private build(
    rpcUrl: string,
    chainId: bigint,
    address: string,
    prod: boolean,
  ): ethers.Contract {
    this.logger.log(`Connecting to RPC: ${rpcUrl} (chain ${chainId})`);
    this.provider = new ethers.JsonRpcProvider(rpcUrl, chainId, {
      staticNetwork: true,
    });
    this.contract = new ethers.Contract(
      address,
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
    return this.contract;
  }

  private disconnect(): void {
    this.provider?.destroy();
    this.provider = null;
    this.contract = null;
    this.wallet = null;
    this.cMax = null;
  }

  /**
   * Refuses a contract whose serverPublicKey isn't the key refunds are signed
   * with: every request proof would fail against it. A serverAddress that
   * isn't the signer is only logged, since a pending change can explain it.
   */
  private async checkServerKeys(contract: ethers.Contract): Promise<void> {
    const onchain = (await contract.serverPublicKey()) as {
      x: string;
      y: string;
    };
    const signer = await this.refundSigner.getPublicKey();
    if (
      BigInt(onchain.x) !== BigInt(signer.x) ||
      BigInt(onchain.y) !== BigInt(signer.y)
    ) {
      throw new Misconfigured(
        `Cannot start in production: LongjingCredits.serverPublicKey (${onchain.x}, ${onchain.y}) is not the refund signer (${signer.x}, ${signer.y})`,
      );
    }

    const serverAddress = (await contract.serverAddress()) as string;
    if (this.wallet && serverAddress !== this.wallet.address) {
      this.logger.warn(
        `LongjingCredits.serverAddress ${serverAddress} is not the transaction signer ${this.wallet.address}`,
      );
    }
  }

  /** Stops retrying and event polling, so nothing runs once the app is closing */
  async onModuleDestroy() {
    this.destroyed = true;
    if (this.retry) {
      clearTimeout(this.retry);
    }
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
