import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsUrl,
  IsString,
  IsOptional,
  IsEthereumAddress,
  IsIn,
  validateSync,
} from 'class-validator';
import { assertNoKeyMaterialInEnv } from '../keys/key-policy';
import { findPlaceholders, profile, PROFILES } from './profile';
import type { Profile } from './profile';

/**
 * Environment configuration schema.
 * All required environment variables must be defined here and validated on startup.
 */
export class EnvironmentVariables {
  @IsEnum(['development', 'production', 'test'])
  NODE_ENV: 'development' | 'production' | 'test' = 'development';

  @IsIn(PROFILES)
  PROFILE!: Profile;

  @IsUrl({ require_tld: false })
  KMS_URL?: string;

  @IsOptional()
  @IsString()
  ANTHROPIC_API_KEY?: string; // Example: Claude API key (replace with your external service credentials)

  @IsOptional()
  @IsEthereumAddress()
  ZK_CONTRACT_ADDRESS?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  ANVIL_RPC_URL?: string;

  @IsOptional()
  @IsString()
  ETHEREUM_RPC_URLS?: string; // Comma-separated list of Ethereum mainnet RPC URLs

  @IsOptional()
  @IsString()
  ANVIL_PRIVATE_KEY?: string;
}

const PROD_REQUIRED = ['ETHEREUM_RPC_URLS', 'ZK_CONTRACT_ADDRESS'] as const;

const PROD_REFUSED = [
  'ANVIL_RPC_URL',
  'ANVIL_PRIVATE_KEY',
  'DSTACK_SIMULATOR_ENDPOINT',
] as const;

/**
 * Production never falls back: a missing value is an error, and local-only
 * settings or placeholder values are refused.
 */
function profileErrors(config: Record<string, unknown>): string[] {
  const errors: string[] = [];

  if (profile(config) === 'local') {
    if (config.NODE_ENV === 'production') {
      errors.push('NODE_ENV=production requires PROFILE=prod');
    }
    return errors;
  }

  const missing = PROD_REQUIRED.filter((name) => !config[name]);
  if (missing.length > 0) {
    errors.push(`PROFILE=prod requires ${missing.join(', ')}`);
  }

  const refused = PROD_REFUSED.filter((name) => config[name]);
  if (refused.length > 0) {
    errors.push(`PROFILE=prod refuses ${refused.join(', ')}`);
  }

  const placeholders = findPlaceholders(config);
  if (placeholders.length > 0) {
    errors.push(
      `PROFILE=prod refuses placeholder values in ${placeholders.join(', ')}`,
    );
  }

  return errors;
}

/**
 * Validates environment variables on application startup.
 * Fails fast if any required variables are missing or invalid.
 */
export function validateEnvironment(config: Record<string, unknown>) {
  const problems = profileErrors(config);
  if (problems.length > 0) {
    throw new Error(`Environment validation failed:\n${problems.join('\n')}`);
  }

  assertNoKeyMaterialInEnv(config);

  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validatedConfig, {
    skipMissingProperties: true,
  });

  if (errors.length > 0) {
    throw new Error(
      `Environment validation failed:\n${errors.map((e) => Object.values(e.constraints || {}).join(', ')).join('\n')}`,
    );
  }

  return validatedConfig;
}
