import 'reflect-metadata';
import { validateEnvironment, EnvironmentVariables } from './env.validation';

const PROD = {
  NODE_ENV: 'production',
  PROFILE: 'prod',
  ETHEREUM_RPC_URLS: 'https://eth.drpc.org,https://rpc.flashbots.net',
  ZK_CONTRACT_ADDRESS: '0x1111111111111111111111111111111111111111',
};

describe('Environment Validation', () => {
  describe('validateEnvironment', () => {
    it('should validate valid development environment', () => {
      const config = { NODE_ENV: 'development', PROFILE: 'local' };
      const result = validateEnvironment(config);

      expect(result).toBeInstanceOf(EnvironmentVariables);
      expect(result.NODE_ENV).toBe('development');
    });

    it('should validate valid production environment', () => {
      const result = validateEnvironment(PROD);

      expect(result.NODE_ENV).toBe('production');
      expect(result.PROFILE).toBe('prod');
    });

    it('should validate valid test environment', () => {
      const config = { NODE_ENV: 'test', PROFILE: 'local' };
      const result = validateEnvironment(config);

      expect(result.NODE_ENV).toBe('test');
    });

    it('should throw error for invalid NODE_ENV', () => {
      const config = { NODE_ENV: 'invalid', PROFILE: 'local' };

      expect(() => validateEnvironment(config)).toThrow(
        'Environment validation failed',
      );
    });

    it('should validate valid KMS_URL', () => {
      const config = {
        NODE_ENV: 'development',
        PROFILE: 'local',
        KMS_URL: 'http://localhost:8080',
      };
      const result = validateEnvironment(config);

      expect(result.KMS_URL).toBe('http://localhost:8080');
    });

    it('should validate KMS_URL without TLD requirement', () => {
      const config = {
        NODE_ENV: 'development',
        PROFILE: 'local',
        KMS_URL: 'http://kms-service',
      };
      const result = validateEnvironment(config);

      expect(result.KMS_URL).toBe('http://kms-service');
    });

    it('should allow invalid KMS_URL when skipMissingProperties is true', () => {
      const config = {
        NODE_ENV: 'development',
        PROFILE: 'local',
        KMS_URL: 'not-a-url',
      };

      // This doesn't throw because skipMissingProperties is true
      // and the validation is lenient
      const result = validateEnvironment(config);
      expect(result).toBeDefined();
    });

    it('should use default NODE_ENV when not provided', () => {
      const config = { PROFILE: 'local' };
      const result = validateEnvironment(config);

      expect(result.NODE_ENV).toBe('development');
    });

    it('should allow missing KMS_URL', () => {
      const result = validateEnvironment(PROD);

      expect(result.KMS_URL).toBeUndefined();
    });
  });
  it('refuses key material in env in production', () => {
    expect(() =>
      validateEnvironment({
        ...PROD,
        OPERATOR_PRIVATE_KEY: '0x01',
      }),
    ).toThrow('key material in env');
  });

  describe('PROFILE', () => {
    it('is required', () => {
      expect(() => validateEnvironment({ NODE_ENV: 'development' })).toThrow(
        'PROFILE must be "local" or "prod"',
      );
    });

    it('refuses an unknown value', () => {
      expect(() => validateEnvironment({ PROFILE: 'production' })).toThrow(
        'PROFILE must be "local" or "prod"',
      );
    });

    it('refuses NODE_ENV=production with PROFILE=local', () => {
      expect(() =>
        validateEnvironment({ NODE_ENV: 'production', PROFILE: 'local' }),
      ).toThrow('NODE_ENV=production requires PROFILE=prod');
    });

    it('accepts Anvil placeholders with PROFILE=local', () => {
      const result = validateEnvironment({
        PROFILE: 'local',
        ANVIL_RPC_URL: 'http://127.0.0.1:8545',
        ANVIL_PRIVATE_KEY:
          '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        ZK_CONTRACT_ADDRESS: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      });

      expect(result.PROFILE).toBe('local');
    });

    it.each(['ETHEREUM_RPC_URLS', 'ZK_CONTRACT_ADDRESS'])(
      'prod requires %s',
      (name) => {
        expect(() =>
          validateEnvironment({ ...PROD, [name]: undefined }),
        ).toThrow(`PROFILE=prod requires ${name}`);
      },
    );

    it.each([
      ['ANVIL_RPC_URL', 'http://127.0.0.1:8545'],
      ['ANVIL_PRIVATE_KEY', '0x01'],
      ['DSTACK_SIMULATOR_ENDPOINT', '/tmp/dstack.sock'],
    ])('prod refuses %s', (name, value) => {
      expect(() => validateEnvironment({ ...PROD, [name]: value })).toThrow(
        `PROFILE=prod refuses ${name}`,
      );
    });

    it.each([
      ['ZK_CONTRACT_ADDRESS', '0x5FbDB2315678afecb367f032d93F642f64180aa3'],
      ['ETHEREUM_RPC_URLS', 'https://eth.drpc.org,https://rpc.example.com'],
      ['KMS_URL', 'https://your-kms.example.com/release'],
      ['SERVER_ADDRESS', '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'],
    ])('prod refuses a placeholder in %s', (name, value) => {
      expect(() => validateEnvironment({ ...PROD, [name]: value })).toThrow(
        `PROFILE=prod refuses placeholder values in ${name}`,
      );
    });

    it('reports every prod problem at once', () => {
      expect(() =>
        validateEnvironment({
          PROFILE: 'prod',
          ANVIL_PRIVATE_KEY:
            '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        }),
      ).toThrow(
        /requires ETHEREUM_RPC_URLS, ZK_CONTRACT_ADDRESS\n.*refuses ANVIL_PRIVATE_KEY\n.*placeholder values in ANVIL_PRIVATE_KEY/,
      );
    });
  });
});
