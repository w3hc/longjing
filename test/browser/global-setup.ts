import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { join } from 'path';

const ROOT = join(__dirname, '../..');

/**
 * Deploys LongjingCredits on Anvil and starts a local gateway pointed at it,
 * for the whole run. The tests read LONGJING_CONTRACT and LONGJING_GATEWAY.
 * @returns The teardown, which stops the gateway
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const gateway = spawn(
    join(ROOT, 'node_modules/.bin/ts-node'),
    ['-T', 'scripts/testing/local-gateway.ts'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const started = await new Promise<{ contract: string; url: string }>(
    (resolve, reject) => {
      gateway.once('exit', (code) =>
        reject(new Error(`The local gateway exited with ${code}`)),
      );
      createInterface({ input: gateway.stdout }).on('line', (line) => {
        if (line.startsWith('{')) {
          resolve(JSON.parse(line) as { contract: string; url: string });
        }
      });
    },
  );
  process.env.LONGJING_CONTRACT = started.contract;
  process.env.LONGJING_GATEWAY = started.url;
  return async () => {
    const exited = new Promise((resolve) => gateway.once('exit', resolve));
    gateway.kill('SIGTERM');
    await exited;
  };
}
