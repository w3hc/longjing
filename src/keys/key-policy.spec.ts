import { assertNoKeyMaterialInEnv } from './key-policy';

describe('assertNoKeyMaterialInEnv', () => {
  it.each([
    'ADMIN_MLKEM_PRIVATE_KEY',
    'OPERATOR_PRIVATE_KEY',
    'TLS_KEY_PATH',
    'TLS_CERT_PATH',
  ])('refuses %s in production', (name) => {
    expect(() =>
      assertNoKeyMaterialInEnv({ PROFILE: 'prod', [name]: 'x' }),
    ).toThrow(name);
  });

  it('allows production without key material', () => {
    expect(() =>
      assertNoKeyMaterialInEnv({
        PROFILE: 'prod',
        ADMIN_MLKEM_PUBLIC_KEY: 'public',
      }),
    ).not.toThrow();
  });

  it('allows key material under the compose opt-out', () => {
    expect(() =>
      assertNoKeyMaterialInEnv({
        PROFILE: 'prod',
        ALLOW_KEYS_OUTSIDE_ENCLAVE: 'true',
        OPERATOR_PRIVATE_KEY: 'x',
      }),
    ).not.toThrow();
  });

  it('allows key material outside production', () => {
    expect(() =>
      assertNoKeyMaterialInEnv({
        PROFILE: 'local',
        ADMIN_MLKEM_PRIVATE_KEY: 'x',
      }),
    ).not.toThrow();
  });

  it('keys on PROFILE, not NODE_ENV', () => {
    expect(() =>
      assertNoKeyMaterialInEnv({
        NODE_ENV: 'production',
        PROFILE: 'local',
        OPERATOR_PRIVATE_KEY: 'x',
      }),
    ).not.toThrow();
  });

  it('refuses to guess without a PROFILE', () => {
    expect(() =>
      assertNoKeyMaterialInEnv({ OPERATOR_PRIVATE_KEY: 'x' }),
    ).toThrow('PROFILE must be');
  });
});
