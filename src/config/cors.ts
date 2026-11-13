import { isProd } from './profile';

/**
 * Parses CORS_ORIGINS, a comma-separated list of exact origins
 * (scheme://host[:port]) whose pages may call the API from a browser.
 * No wildcard and no "null" origin: a page opened from disk needs no API,
 * since withdrawal never needs the server.
 */
export function parseCorsOrigins(value: unknown): string[] {
  if (value === undefined || value === null || value === '') {
    return [];
  }
  if (typeof value !== 'string') {
    throw new Error('CORS_ORIGINS must be a string');
  }
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => {
      let url: URL | undefined;
      try {
        url = new URL(origin);
      } catch {
        url = undefined;
      }
      if (
        !url ||
        !['http:', 'https:'].includes(url.protocol) ||
        url.origin !== origin ||
        origin.includes('*')
      ) {
        throw new Error(
          `CORS_ORIGINS takes exact origins like https://app.example.com, got ${JSON.stringify(origin)}`,
        );
      }
      return origin;
    });
}

/**
 * The origins allowed to call the API from a browser: the configured list,
 * otherwise none in production and any locally.
 */
export function corsOrigin(
  env: Record<string, unknown> = process.env,
): string[] | false | '*' {
  const origins = parseCorsOrigins(env.CORS_ORIGINS);
  if (origins.length > 0) {
    return origins;
  }
  return isProd(env) ? false : '*';
}
