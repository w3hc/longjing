import { assertNoKeyMaterialInEnv } from './key-policy';

describe('assertNoKeyMaterialInEnv', () => {
  it.each([
    'ADMIN_MLKEM_PRIVATE_KEY',
    'OPERATOR_PRIVATE_KEY',
    'TLS_KEY_PATH',
    'TLS_CERT_PATH',
  ])('refuses %s in production', (name) => {
    expect(() =>
      assertNoKeyMaterialInEnv({ NODE_ENV: 'production', [name]: 'x' }),
    ).toThrow(name);
  });

  it('allows production without key material', () => {
    expect(() =>
      assertNoKeyMaterialInEnv({
        NODE_ENV: 'production',
        ADMIN_MLKEM_PUBLIC_KEY: 'public',
      }),
    ).not.toThrow();
  });

  it('allows key material under the compose opt-out', () => {
    expect(() =>
      assertNoKeyMaterialInEnv({
        NODE_ENV: 'production',
        ALLOW_KEYS_OUTSIDE_ENCLAVE: 'true',
        OPERATOR_PRIVATE_KEY: 'x',
      }),
    ).not.toThrow();
  });

  it('allows key material outside production', () => {
    expect(() =>
      assertNoKeyMaterialInEnv({
        NODE_ENV: 'development',
        ADMIN_MLKEM_PRIVATE_KEY: 'x',
      }),
    ).not.toThrow();
  });
});
