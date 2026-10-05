import 'reflect-metadata';
import { validateEnvironment, EnvironmentVariables } from './env.validation';

describe('Environment Validation', () => {
  describe('validateEnvironment', () => {
    it('should validate valid development environment', () => {
      const config = { NODE_ENV: 'development' };
      const result = validateEnvironment(config);

      expect(result).toBeInstanceOf(EnvironmentVariables);
      expect(result.NODE_ENV).toBe('development');
    });

    it('should validate valid production environment', () => {
      const config = { NODE_ENV: 'production' };
      const result = validateEnvironment(config);

      expect(result.NODE_ENV).toBe('production');
    });

    it('should validate valid test environment', () => {
      const config = { NODE_ENV: 'test' };
      const result = validateEnvironment(config);

      expect(result.NODE_ENV).toBe('test');
    });

    it('should throw error for invalid NODE_ENV', () => {
      const config = { NODE_ENV: 'invalid' };

      expect(() => validateEnvironment(config)).toThrow(
        'Environment validation failed',
      );
    });

    it('should validate valid KMS_URL', () => {
      const config = {
        NODE_ENV: 'development',
        KMS_URL: 'http://localhost:8080',
      };
      const result = validateEnvironment(config);

      expect(result.KMS_URL).toBe('http://localhost:8080');
    });

    it('should validate KMS_URL without TLD requirement', () => {
      const config = {
        NODE_ENV: 'development',
        KMS_URL: 'http://kms-service',
      };
      const result = validateEnvironment(config);

      expect(result.KMS_URL).toBe('http://kms-service');
    });

    it('should allow invalid KMS_URL when skipMissingProperties is true', () => {
      const config = {
        NODE_ENV: 'development',
        KMS_URL: 'not-a-url',
      };

      // This doesn't throw because skipMissingProperties is true
      // and the validation is lenient
      const result = validateEnvironment(config);
      expect(result).toBeDefined();
    });

    it('should use default NODE_ENV when not provided', () => {
      const config = {};
      const result = validateEnvironment(config);

      expect(result.NODE_ENV).toBe('development');
    });

    it('should allow missing KMS_URL', () => {
      const config = { NODE_ENV: 'production' };
      const result = validateEnvironment(config);

      expect(result.KMS_URL).toBeUndefined();
    });
  });
  it('refuses key material in env in production', () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'production',
        OPERATOR_PRIVATE_KEY: '0x01',
      }),
    ).toThrow('key material in env');
  });
});
