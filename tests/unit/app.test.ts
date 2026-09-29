import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { ClientService } from '../../src/modules/clients/client-service.js';

const clientService: ClientService = {
  issueClient: () => Promise.resolve({ status: 'issued', token: 'a'.repeat(43) }),
  authenticateToken: () => Promise.resolve(undefined),
};
const app = buildApp({ clientService });
afterAll(async () => { await app.close(); });

describe('application foundation', () => {
  it('starts the HTTP pipeline without opening a port or requiring a database', async () => {
    const response = await app.inject({ method: 'GET', url: '/observations' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });
  });

  it('generates OpenAPI from the Zod route schemas', async () => {
    const response = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(response.statusCode).toBe(200);
    const document = response.json<{
      openapi: string;
      paths: Record<string, { post?: { operationId?: string; responses?: Record<string, unknown> } }>;
    }>();
    expect(document).toMatchObject({
      openapi: '3.1.0',
      paths: {
        '/clients': { post: { operationId: 'createClient' } },
      },
    });
    expect(document.paths['/clients']?.post?.responses?.['429']).toMatchObject({
      headers: {
        'Retry-After': { schema: { type: 'integer', minimum: 1 } },
      },
    });
  });

  it('returns malformed requests in the common error envelope', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/clients',
      headers: { 'content-type': 'application/json' },
      payload: '{',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: 'REQUEST_INVALID', message: 'Request is invalid' },
    });
  });
});
