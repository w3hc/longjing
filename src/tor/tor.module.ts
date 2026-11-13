import { Module } from '@nestjs/common';
import { KeysModule } from '../keys/keys.module';
import { OnionService } from './onion.service';

@Module({
  imports: [KeysModule],
  providers: [OnionService],
})
export class TorModule {}
