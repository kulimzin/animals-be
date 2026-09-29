import { describe, expect, it } from 'vitest';
import { readEnvironment } from '../../src/config/env.js';

const DATABASE_URL = 'postgresql://localhost/animals';

describe('environment', () => {
  it('reads defaults and explicit settings', () => {
    expect(readEnvironment({ DATABASE_URL })).toEqual({
      DATABASE_URL, HOST: '127.0.0.1', PORT: 3000, LOG_LEVEL: 'info',
    });
    expect(readEnvironment({ DATABASE_URL, PORT: '8080', LOG_LEVEL: 'warn' }).PORT).toBe(8080);
  });

  it.each(['', '0', '-1', '65536', '1.5', 'invalid'])('rejects invalid port %j', (PORT) => {
    expect(() => readEnvironment({ DATABASE_URL, PORT })).toThrow('PORT');
  });

  it.each([undefined, '', 'https://localhost/animals', 'postgresql://localhost'])('requires a PostgreSQL URL with a database', (url) => {
    expect(() => readEnvironment({ DATABASE_URL: url })).toThrow('DATABASE_URL');
  });

  it('does not expose invalid values in configuration errors', () => {
    expect(() => readEnvironment({ DATABASE_URL: 'invalid-sensitive-value' }))
      .toThrow(/^Invalid environment configuration: DATABASE_URL$/);
  });
});
