import { findPlaceholders, isProd, profile } from './profile';

describe('profile', () => {
  it.each(['local', 'prod'])('accepts %s', (value) => {
    expect(profile({ PROFILE: value })).toBe(value);
  });

  it('refuses a missing PROFILE', () => {
    expect(() => profile({})).toThrow('got nothing');
  });

  it.each(['production', 'dev', 'LOCAL', ''])('refuses %j', (value) => {
    expect(() => profile({ PROFILE: value })).toThrow('PROFILE must be');
  });

  it('is prod only for PROFILE=prod', () => {
    expect(isProd({ PROFILE: 'prod' })).toBe(true);
    expect(isProd({ PROFILE: 'local' })).toBe(false);
  });

  it('does not read NODE_ENV', () => {
    expect(isProd({ PROFILE: 'local', NODE_ENV: 'production' })).toBe(false);
  });
});

describe('findPlaceholders', () => {
  it('finds an Anvil private key, with or without 0x', () => {
    expect(
      findPlaceholders({
        A: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        B: '2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6',
      }),
    ).toEqual(['A', 'B']);
  });

  it('finds an Anvil address in any casing', () => {
    expect(
      findPlaceholders({
        SERVER: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
      }),
    ).toEqual(['SERVER']);
  });

  it("finds Anvil's first deployment address", () => {
    expect(
      findPlaceholders({
        ZK_CONTRACT_ADDRESS: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      }),
    ).toEqual(['ZK_CONTRACT_ADDRESS']);
  });

  it.each(['https://your-kms.example.com/release', 'https://example.org'])(
    'finds the URL %s',
    (url) => {
      expect(findPlaceholders({ URL: url })).toEqual(['URL']);
    },
  );

  it('leaves loopback URLs to the chain check', () => {
    expect(findPlaceholders({ HTTP_PROXY: 'http://127.0.0.1:3128' })).toEqual(
      [],
    );
  });

  it('checks comma-separated items', () => {
    expect(
      findPlaceholders({
        ETHEREUM_RPC_URLS: 'https://eth.drpc.org, https://rpc.example.com',
      }),
    ).toEqual(['ETHEREUM_RPC_URLS']);
  });

  it('accepts real values', () => {
    expect(
      findPlaceholders({
        ETHEREUM_RPC_URLS: 'https://eth.drpc.org,https://rpc.flashbots.net',
        ZK_CONTRACT_ADDRESS: '0x1111111111111111111111111111111111111111',
        PROFILE: 'prod',
        NOT_A_STRING: 42,
      }),
    ).toEqual([]);
  });
});
