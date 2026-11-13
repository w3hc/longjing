// SPDX-License-Identifier: LGPL-3.0
// Copyright (C) 2026 Julien Béranger and the W3HC

import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { KeyDerivationService } from '../keys/key-derivation.service';
import { LISTEN_PORT } from '../config/listen';
import { isProd } from '../config/profile';
import { RunningOnionService, startOnionService } from './tor-process';

/** Clients reach https://<address>.onion on the default HTTPS port. */
export const ONION_VIRTUAL_PORT = 443;

/**
 * Production always runs the onion service; development and test only with
 * ONION_SERVICE=true, which production refuses.
 */
export function onionServiceEnabled(
  env: Record<string, unknown> = process.env,
): boolean {
  return isProd(env) || env.ONION_SERVICE === 'true';
}

/**
 * Runs the v3 onion service inside the enclave, with the key derived from
 * the dstack KMS, in front of the in-enclave TLS listener. report_data binds
 * its public key. See docs/ONION_SERVICE.md.
 */
@Injectable()
export class OnionService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(OnionService.name);
  private running: RunningOnionService | null = null;
  private stopping = false;

  constructor(private readonly keyDerivation: KeyDerivationService) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!onionServiceEnabled()) {
      return;
    }
    const key = this.keyDerivation.getOnionKey();
    if (!key) {
      this.logger.warn('No onion service: its key was not derived');
      return;
    }

    try {
      this.running = await startOnionService({
        key,
        virtualPort: ONION_VIRTUAL_PORT,
        target: `127.0.0.1:${LISTEN_PORT}`,
      });
    } catch (error) {
      if (isProd()) {
        throw new Error(
          'Cannot start in production without the onion service',
          {
            cause: error,
          },
        );
      }
      this.logger.warn(
        `No onion service: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    this.logger.log(`Onion service: ${this.running.serviceId}.onion`);
    void this.running.exited.then((code) => {
      if (this.stopping) {
        return;
      }
      this.logger.error(`tor exited (code ${code}): the onion service is down`);
      // Fail closed: the container restarts with a fresh tor
      if (isProd()) {
        process.exit(1);
      }
    });
  }

  onApplicationShutdown(): void {
    this.stopping = true;
    this.running?.stop();
  }
}
