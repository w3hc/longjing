import { ConfigService } from '@nestjs/config';
import { assertChainMatchesProfile, fetchChainId, selectRpcUrl } from './chain';

function config(values: Record<string, string>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('selectRpcUrl', () => {
  const both = config({
    ANVIL_RPC_URL: 'http://127.0.0.1:8545',
    ETHEREUM_RPC_URLS: 'https://eth.drpc.org, https://rpc.flashbots.net',
  });

  it('reads only ANVIL_RPC_URL in local', () => {
    expect(selectRpcUrl(both, 'local')).toBe('http://127.0.0.1:8545');
  });

  it('reads only ETHEREUM_RPC_URLS in prod', () => {
    expect(['https://eth.drpc.org', 'https://rpc.flashbots.net']).toContain(
      selectRpcUrl(both, 'prod'),
    );
  });

  it('does not fall back to ANVIL_RPC_URL in prod', () => {
    expect(
      selectRpcUrl(config({ ANVIL_RPC_URL: 'http://127.0.0.1:8545' }), 'prod'),
    ).toBeUndefined();
  });

  it('does not fall back to ETHEREUM_RPC_URLS in local', () => {
    expect(
      selectRpcUrl(
        config({ ETHEREUM_RPC_URLS: 'https://eth.drpc.org' }),
        'local',
      ),
    ).toBeUndefined();
  });
});

describe('fetchChainId', () => {
  afterEach(() => jest.restoreAllMocks());

  it('parses the hex chain id', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        Response.json({ jsonrpc: '2.0', id: 1, result: '0x7a69' }),
      );

    await expect(fetchChainId('http://127.0.0.1:8545')).resolves.toBe(31337n);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8545',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws on a JSON-RPC error', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        Response.json({ jsonrpc: '2.0', id: 1, error: { message: 'nope' } }),
      );

    await expect(fetchChainId('http://rpc')).rejects.toThrow(
      'eth_chainId failed: nope',
    );
  });

  it('throws when the RPC is unreachable', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new TypeError('fetch failed'));

    await expect(fetchChainId('http://rpc')).rejects.toThrow('fetch failed');
  });
});

describe('assertChainMatchesProfile', () => {
  it('accepts Anvil in local', () => {
    expect(() => assertChainMatchesProfile(31337n, 'local')).not.toThrow();
  });

  it('refuses any other chain in local', () => {
    expect(() => assertChainMatchesProfile(1n, 'local')).toThrow(
      'PROFILE=local runs on Anvil only',
    );
  });

  it('refuses Anvil in prod', () => {
    expect(() => assertChainMatchesProfile(31337n, 'prod')).toThrow(
      'PROFILE=prod refuses chain 31337',
    );
  });

  it('accepts mainnet in prod', () => {
    expect(() => assertChainMatchesProfile(1n, 'prod')).not.toThrow();
  });
});
