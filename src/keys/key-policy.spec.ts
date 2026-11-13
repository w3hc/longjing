import { assertNoKeyMaterialInEnv } from './key-policy';

describe('assertNoKeyMaterialInEnv', () => {
  it.each([
    'OPERATOR_PRIVATE_KEY',
    'SERVER_TX_PRIVATE_KEY',
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
        KMS_URL: 'https://kms.example.com/release',
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
        OPERATOR_PRIVATE_KEY: 'x',
      }),
    ).not.toThrow();
  });

  it('refuses to guess without a NODE_ENV', () => {
    expect(() =>
      assertNoKeyMaterialInEnv({ OPERATOR_PRIVATE_KEY: 'x' }),
    ).toThrow('NODE_ENV must be');
  });
});
