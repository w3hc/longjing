import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { isProd } from '../config/profile';
import { BlockchainService } from '../longjing/blockchain.service';

/**
 * Health check endpoint for monitoring and load balancers.
 * Returns minimal information to avoid leaking internal state.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly blockchain: BlockchainService) {}

  /**
   * Basic health check endpoint.
   * @returns Health status object
   */
  @Get()
  check() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Readiness probe - indicates if the service is ready to accept traffic.
   * In production it fails until LongjingCredits answers.
   * @returns Readiness status
   */
  @Get('ready')
  ready() {
    if (isProd() && !this.blockchain.isAvailable()) {
      throw new ServiceUnavailableException(
        'LongjingCredits does not answer yet',
      );
    }
    return {
      status: 'ready',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Liveness probe - indicates if the service is alive.
   * @returns Liveness status
   */
  @Get('live')
  live() {
    return {
      status: 'alive',
      timestamp: new Date().toISOString(),
    };
  }
}
