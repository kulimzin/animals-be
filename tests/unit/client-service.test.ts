import { describe, expect, it } from 'vitest';
import { normalizeClientIp, parseBearerToken } from '../../src/modules/clients/client-service.js';

describe('client identification helpers', () => {
  it('normalizes IPv4-mapped addresses and IPv6 networks', () => {
    expect(normalizeClientIp('::ffff:192.0.2.128')).toBe('192.0.2.128');
    expect(normalizeClientIp('2001:db8:1234:5678:abcd::1')).toBe('2001:db8:1234:5678::');
    expect(normalizeClientIp('2001:db8:1234:5678:ffff::2')).toBe('2001:db8:1234:5678::');
  });

  it('distinguishes missing, malformed and valid bearer credentials', () => {
    expect(parseBearerToken(undefined)).toEqual({ status: 'required' });
    expect(parseBearerToken('Basic credentials')).toEqual({ status: 'invalid' });
    expect(parseBearerToken(`Bearer ${'a'.repeat(42)}`)).toEqual({ status: 'invalid' });
    expect(parseBearerToken(`bearer ${'a'.repeat(43)}`)).toEqual({
      status: 'valid',
      token: 'a'.repeat(43),
    });
  });
});
