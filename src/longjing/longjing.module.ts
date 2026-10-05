import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LongjingController } from './longjing.controller';
import { LongjingService } from './longjing.service';
import { NullifierStoreService } from './nullifier-store.service';
import { ProofVerifierService } from './proof-verifier.service';
import { EthRateOracleService } from './eth-rate-oracle.service';
import { RefundSignerService } from './refund-signer.service';
import { BlockchainService } from './blockchain.service';
import { ProofGenService } from './proof-gen.service';
import { MerkleTreeService } from './merkle-tree.service';
import { SnarkjsProofService } from './snarkjs-proof.service';
import { SlashingService } from './slashing.service';
import { SlashingProofService } from './slashing-proof.service';
import { SecretsService } from '../config/secrets.service';
import { ProviderRegistryService } from '../providers';
import { DatabaseService } from '../database/database.service';
import { PricingRepository } from '../pricing/pricing.repository';
import { PricingOracleService } from '../pricing/pricing-oracle.service';
import { CostEstimationService } from './cost-estimation.service';
import { ClaudeProvider } from '../providers/claude';
import { KeysModule } from '../keys/keys.module';
import { AttestationModule } from '../attestation/attestation.module';

@Module({
  imports: [KeysModule, AttestationModule],
  controllers: [LongjingController],
  providers: [
    LongjingService,
    NullifierStoreService,
    ProofVerifierService,
    ProofGenService,
    SnarkjsProofService,
    EthRateOracleService,
    RefundSignerService,
    BlockchainService,
    MerkleTreeService,
    SlashingService,
    SlashingProofService,
    SecretsService,
    ProviderRegistryService,
    DatabaseService,
    PricingRepository,
    PricingOracleService,
    CostEstimationService,
    ClaudeProvider,
  ],
  exports: [
    LongjingService,
    ProofGenService,
    BlockchainService,
    MerkleTreeService,
  ],
})
export class LongjingModule implements OnModuleInit {
  constructor(
    private readonly providerRegistry: ProviderRegistryService,
    private readonly claudeProvider: ClaudeProvider,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Initialize Claude provider
    const apiKey = this.configService.get<string>('ANTHROPIC_API_KEY');
    await this.claudeProvider.initialize({
      apiKey,
      timeout: 120000,
      retries: 2,
    });

    // Register Claude provider
    this.providerRegistry.register(this.claudeProvider);
  }
}
