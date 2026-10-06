import { ConfigService } from '@nestjs/config';
import { LOCAL_CHAIN_ID, Profile, profile } from '../config/profile';

const CHAIN_ID_TIMEOUT_MS = 10_000;

/**
 * The RPC for the current profile: ANVIL_RPC_URL locally, one of
 * ETHEREUM_RPC_URLS (picked at random) in production. Neither falls back to
 * the other.
 */
export function selectRpcUrl(
  config: ConfigService,
  current: Profile = profile(),
): string | undefined {
  if (current === 'local') {
    return config.get<string>('ANVIL_RPC_URL') || undefined;
  }

  const urls = (config.get<string>('ETHEREUM_RPC_URLS') ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
  return urls[Math.floor(Math.random() * urls.length)];
}

/**
 * Reads eth_chainId with a plain JSON-RPC call, so an unreachable RPC fails
 * once instead of entering ethers' network detection retry loop.
 */
export async function fetchChainId(rpcUrl: string): Promise<bigint> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_chainId',
      params: [],
    }),
    signal: AbortSignal.timeout(CHAIN_ID_TIMEOUT_MS),
  });
  const body = (await response.json()) as {
    result?: string;
    error?: { message?: string };
  };
  if (typeof body.result !== 'string') {
    throw new Error(
      `eth_chainId failed: ${body.error?.message ?? `HTTP ${response.status}`}`,
    );
  }
  return BigInt(body.result);
}

/**
 * local runs on Anvil only, prod never does.
 */
export function assertChainMatchesProfile(
  chainId: bigint,
  current: Profile = profile(),
): void {
  if (current === 'local' && chainId !== LOCAL_CHAIN_ID) {
    throw new Error(
      `NODE_ENV=development or test runs on Anvil only (chain ${LOCAL_CHAIN_ID}), the RPC is on chain ${chainId}`,
    );
  }
  if (current === 'prod' && chainId === LOCAL_CHAIN_ID) {
    throw new Error(
      `NODE_ENV=production refuses chain ${LOCAL_CHAIN_ID}: the RPC is a local Anvil node`,
    );
  }
}
