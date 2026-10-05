import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsUrl,
  IsString,
  IsOptional,
  IsEthereumAddress,
  validateSync,
} from 'class-validator';
import { assertNoKeyMaterialInEnv } from '../keys/key-policy';

/**
 * Environment configuration schema.
 * All required environment variables must be defined here and validated on startup.
 */
export class EnvironmentVariables {
  @IsEnum(['development', 'production', 'test'])
  NODE_ENV: 'development' | 'production' | 'test' = 'development';

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

/**
 * Validates environment variables on application startup.
 * Fails fast if any required variables are missing or invalid.
 */
export function validateEnvironment(config: Record<string, unknown>) {
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
