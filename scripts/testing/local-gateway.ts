#!/usr/bin/env ts-node
/**
 * A local deployment on Anvil: LongjingCredits deployed with
 * NODE_ENV=development, and the gateway in this process, pointed at it. The
 * demo and the browser e2e test use it.
 *
 * Run directly (ts-node -T), it deploys, starts the gateway, prints
 * { "contract", "url" } on one line and serves until it is stopped.
 */

import { execFile } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import type { INestApplication } from '@nestjs/common';

const run = promisify(execFile);

export const ANVIL_RPC_URL = 'http://127.0.0.1:8545';

export async function deployLocal(rpcUrl = ANVIL_RPC_URL): Promise<string> {
  const { stdout } = await run(
    'forge',
    [
      'script',
      'script/DeployLongjingCredits.s.sol:DeployLongjingCredits',
      '--rpc-url',
      rpcUrl,
      '--broadcast',
    ],
    {
      cwd: join(__dirname, '../../contracts'),
      env: { ...process.env, NODE_ENV: 'development' },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const address = /LongjingCredits deployed at: (0x[a-fA-F0-9]{40})/.exec(
    stdout,
  )?.[1];
  if (!address) throw new Error(`Deployment failed:\n${stdout}`);
  return address;
}

/**
 * Starts the gateway with NODE_ENV=development: mock platform, mock provider
 * responses, plain HTTP on loopback, CORS open to any origin
 */
export async function startLocalGateway(
  contract: string,
  rpcUrl = ANVIL_RPC_URL,
): Promise<INestApplication> {
  Object.assign(process.env, {
    NODE_ENV: 'development',
    ANVIL_RPC_URL: rpcUrl,
    ZK_CONTRACT_ADDRESS: contract,
    DATA_DIR: mkdtempSync(join(tmpdir(), 'longjing-local-')),
    KMS_URL: 'http://localhost:3001',
  });
  for (const name of [
    'ANTHROPIC_API_KEY',
    'SERVER_TX_PRIVATE_KEY',
    'ETHEREUM_RPC_URLS',
    'DSTACK_SIMULATOR_ENDPOINT',
    'CORS_ORIGINS',
  ]) {
    delete process.env[name];
  }

  // Required after the env is set: ConfigModule validates it on import
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { NestFactory } =
    require('@nestjs/core') as typeof import('@nestjs/core');
  const { ValidationPipe } =
    require('@nestjs/common') as typeof import('@nestjs/common');
  const { AppModule } =
    require('../../src/app.module') as typeof import('../../src/app.module');
  const { TeeExceptionFilter } =
    require('../../src/filters/tee-exception.filter') as typeof import('../../src/filters/tee-exception.filter');
  const { corsOrigin } =
    require('../../src/config/cors') as typeof import('../../src/config/cors');
  /* eslint-enable @typescript-eslint/no-require-imports */

  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  app.enableCors({
    origin: corsOrigin(),
    methods: ['GET', 'POST'],
    credentials: false,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new TeeExceptionFilter());
  // Plain HTTP on loopback: dev TLS needs certificates in ./secrets
  await app.listen(0, '127.0.0.1');
  return app;
}

if (require.main === module) {
  (async () => {
    const contract = await deployLocal();
    const app = await startLocalGateway(contract);
    console.log(JSON.stringify({ contract, url: await app.getUrl() }));
    const stop = () => void app.close().then(() => process.exit(0));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  })().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
