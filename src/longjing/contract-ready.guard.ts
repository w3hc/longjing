import {
  CanActivate,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { isProd } from '../config/profile';
import { BlockchainService } from './blockchain.service';

/**
 * Refuses every request in production until LongjingCredits answers, so a
 * first boot serves its attestation and nothing else
 */
@Injectable()
export class ContractReadyGuard implements CanActivate {
  constructor(private readonly blockchain: BlockchainService) {}

  canActivate(): boolean {
    if (isProd() && !this.blockchain.isAvailable()) {
      throw new ServiceUnavailableException(
        'LongjingCredits does not answer yet',
      );
    }
    return true;
  }
}
