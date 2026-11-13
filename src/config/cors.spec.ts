import { corsOrigin, parseCorsOrigins } from './cors';

describe('parseCorsOrigins', () => {
  it('takes a comma-separated list of exact origins', () => {
    expect(
      parseCorsOrigins(
        'https://app.example.com, http://abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwx.onion,http://localhost:3001',
      ),
    ).toEqual([
      'https://app.example.com',
      'http://abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwx.onion',
      'http://localhost:3001',
    ]);
    expect(parseCorsOrigins('')).toEqual([]);
    expect(parseCorsOrigins(undefined)).toEqual([]);
  });

  it.each([
    '*',
    'null',
    'https://*.example.com',
    'https://app.example.com/',
    'https://app.example.com/path',
    'app.example.com',
    'file:///tmp/page.html',
  ])('refuses %s', (origin) => {
    expect(() => parseCorsOrigins(origin)).toThrow('CORS_ORIGINS');
  });
});

describe('corsOrigin', () => {
  it('allows only the configured origins in production', () => {
    expect(
      corsOrigin({
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://app.example.com',
      }),
    ).toEqual(['https://app.example.com']);
  });

  it('allows no browser origin in production by default', () => {
    expect(corsOrigin({ NODE_ENV: 'production' })).toBe(false);
    expect(corsOrigin({ NODE_ENV: 'production', CORS_ORIGINS: '' })).toBe(
      false,
    );
  });

  it('allows any origin locally by default', () => {
    expect(corsOrigin({ NODE_ENV: 'development' })).toBe('*');
  });
});
