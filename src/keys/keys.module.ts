import { Module } from '@nestjs/common';
import { DstackV1Client } from './dstack-v1.client';
import { KeyDerivationService } from './key-derivation.service';

@Module({
  providers: [DstackV1Client, KeyDerivationService],
  exports: [DstackV1Client, KeyDerivationService],
})
export class KeysModule {}
