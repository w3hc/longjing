/**
 * Attestation Module
 *
 * Provides cross-platform TEE attestation with report_data binding
 * Manages TEE-generated ML-KEM keys for quantum-resistant encryption
 */

import { Module } from '@nestjs/common';
import { KeysModule } from '../keys/keys.module';
import { AttestationController } from './attestation.controller';
import { AttestationService } from './attestation.service';
import { TeeKeyManagerService } from './tee-key-manager.service';

@Module({
  imports: [KeysModule],
  controllers: [AttestationController],
  providers: [AttestationService, TeeKeyManagerService],
  exports: [AttestationService, TeeKeyManagerService],
})
export class AttestationModule {}
