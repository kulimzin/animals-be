import { describe, expect, it } from 'vitest';
import { readEnvironment } from '../../src/config/env.js';

const DATABASE_URL = 'postgresql://localhost/animals';

describe('environment', () => {
  it('reads defaults and explicit settings', () => {
    expect(readEnvironment({ DATABASE_URL })).toEqual({
      DATABASE_URL,
      DESCRIPTIONS_ENABLED: true,
      HOST: '127.0.0.1',
      PORT: 3000,
      LOG_LEVEL: 'info',
    });
    expect(readEnvironment({ DATABASE_URL, PORT: '8080', LOG_LEVEL: 'warn' }).PORT).toBe(8080);
    expect(readEnvironment({ DATABASE_URL, DESCRIPTIONS_ENABLED: 'false' }).DESCRIPTIONS_ENABLED)
      .toBe(false);
  });

  it('accepts only explicit proxy IP addresses and networks', () => {
    expect(readEnvironment({
      DATABASE_URL,
      TRUST_PROXY: '127.0.0.1, 2001:db8::/32',
    }).TRUST_PROXY).toEqual(['127.0.0.1', '2001:db8::/32']);
    expect(() => readEnvironment({ DATABASE_URL, TRUST_PROXY: 'proxy.example.com' }))
      .toThrow('TRUST_PROXY');
  });

  it.each(['', '0', '-1', '65536', '1.5', 'invalid'])('rejects invalid port %j', (PORT) => {
    expect(() => readEnvironment({ DATABASE_URL, PORT })).toThrow('PORT');
  });

  it.each(['', 'yes', '1', 'TRUE'])('rejects invalid descriptions setting %j', (value) => {
    expect(() => readEnvironment({ DATABASE_URL, DESCRIPTIONS_ENABLED: value }))
      .toThrow('DESCRIPTIONS_ENABLED');
  });

  it.each([undefined, '', 'https://localhost/animals', 'postgresql://localhost'])('requires a PostgreSQL URL with a database', (url) => {
    expect(() => readEnvironment({ DATABASE_URL: url })).toThrow('DATABASE_URL');
  });

  it('does not expose invalid values in configuration errors', () => {
    expect(() => readEnvironment({ DATABASE_URL: 'invalid-sensitive-value' }))
      .toThrow(/^Invalid environment configuration: DATABASE_URL$/);
  });
});
