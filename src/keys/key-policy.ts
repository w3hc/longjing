import { isProd } from '../config/profile';

/**
 * In production, every key is derived inside the enclave from the dstack KMS
 * (see docs/KEY_DERIVATION.md), so key material in env is refused.
 *
 * ALLOW_KEYS_OUTSIDE_ENCLAVE=true is the only opt-out. It belongs in
 * docker-compose.yml as a literal, never a ${...} substitution, so using it
 * changes the attested compose hash.
 */

export const KEY_MATERIAL_ENV = [
  'ADMIN_MLKEM_PRIVATE_KEY',
  'OPERATOR_PRIVATE_KEY',
  'SERVER_TX_PRIVATE_KEY',
  'TLS_KEY_PATH',
  'TLS_CERT_PATH',
] as const;

export function keysOutsideEnclaveAllowed(
  env: Record<string, unknown> = process.env,
): boolean {
  return env.ALLOW_KEYS_OUTSIDE_ENCLAVE === 'true';
}

/**
 * Throws in production when key material is set in env, unless the
 * compose file opts out.
 */
export function assertNoKeyMaterialInEnv(
  env: Record<string, unknown> = process.env,
): void {
  if (!isProd(env) || keysOutsideEnclaveAllowed(env)) {
    return;
  }
  const set = KEY_MATERIAL_ENV.filter((name) => env[name]);
  if (set.length > 0) {
    throw new Error(
      `Refusing to start in production with key material in env (${set.join(', ')}): ` +
        'keys are derived from the dstack KMS. See docs/KEY_DERIVATION.md.',
    );
  }
}
