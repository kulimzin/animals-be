import { z } from 'zod';
import ipaddr from 'ipaddr.js';

const databaseUrl = z.url().refine((value) => {
  const url = URL.parse(value);
  return url !== null && ['postgres:', 'postgresql:'].includes(url.protocol) && url.pathname.length > 1;
});

const trustedProxies = z.string().min(1).transform((value, context) => {
  const addresses = value.split(',').map((address) => address.trim());
  if (addresses.some((address) => !ipaddr.isValid(address) && !ipaddr.isValidCIDR(address))) {
    context.addIssue({ code: 'custom', message: 'Invalid proxy address or CIDR' });
    return z.NEVER;
  }
  return addresses;
}).optional();

const environmentSchema = z.object({
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: trustedProxies,
  DATABASE_URL: databaseUrl,
});

export function readEnvironment(environment: NodeJS.ProcessEnv) {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    // Values and Zod diagnostics can contain credentials; report only field names.
    throw new Error(`Invalid environment configuration: ${fields.join(', ')}`);
  }
  return result.data;
}
