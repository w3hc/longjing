/**
 * Attestation Module
 *
 * Provides cross-platform TEE attestation with report_data binding
 */

import { Module } from '@nestjs/common';
import { KeysModule } from '../keys/keys.module';
import { AttestationController } from './attestation.controller';
import { AttestationService } from './attestation.service';

@Module({
  imports: [KeysModule],
  controllers: [AttestationController],
  providers: [AttestationService],
  exports: [AttestationService],
})
export class AttestationModule {}
