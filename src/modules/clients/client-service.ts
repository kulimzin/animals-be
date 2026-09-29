import { createHash, randomBytes } from 'node:crypto';
import ipaddr from 'ipaddr.js';
import type { ClientRepository } from './client-repository.js';

const CLIENT_TOKEN_BYTES = 32;
const CLIENT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type ClientService = ReturnType<typeof createClientService>;

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeClientIp(value: string) {
  const address = ipaddr.process(value);
  if (address.kind() === 'ipv4') return address.toString();

  const bytes = address.toByteArray();
  return ipaddr.fromByteArray([...bytes.slice(0, 8), ...Array<number>(8).fill(0)]).toString();
}

export function parseBearerToken(authorization: string | undefined) {
  if (authorization === undefined) return { status: 'required' } as const;
  const match = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(authorization);
  const token = match?.[1];
  if (!token || !CLIENT_TOKEN_PATTERN.test(token)) return { status: 'invalid' } as const;
  return { status: 'valid', token } as const;
}

export function createClientService(repository: ClientRepository) {
  return {
    async issueClient(ip: string) {
      const token = randomBytes(CLIENT_TOKEN_BYTES).toString('base64url');
      const result = await repository.issueClient(sha256(normalizeClientIp(ip)), sha256(token));
      return result.status === 'issued' ? { status: 'issued' as const, token } : result;
    },

    async authenticateToken(token: string) {
      return repository.findClientIdByTokenHash(sha256(token));
    },
  };
}
