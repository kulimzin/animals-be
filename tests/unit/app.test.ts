import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { AnimalService } from '../../src/modules/animals/animal-service.js';
import type { ClientService } from '../../src/modules/clients/client-service.js';
import type { ObservationService } from '../../src/modules/observations/observation-service.js';

const animalService: AnimalService = {
  listAvailableAnimals: () => Promise.resolve([{
    id: '1fa5309c-29bc-5ac8-8ece-37465a6ff3b4',
    slug: 'tiger',
    nameRu: 'Тигр',
    nameEn: 'Tiger',
  }]),
};
const clientService: ClientService = {
  issueClient: () => Promise.resolve({ status: 'issued', token: 'a'.repeat(43) }),
  authenticateToken: () => Promise.resolve('8ae9bf20-c834-4feb-824f-dd34e2ea83c1'),
};
const observation = {
  id: '6ee21c62-18a9-4e82-a487-adcf49ce747d',
  animalId: '423e53fb-01c1-521b-8b29-6cccf5268618',
  animalNameRu: 'Волк',
  animalNameEn: 'Wolf',
  location: { longitude: 37.6176, latitude: 55.7558 },
  observedAt: new Date('2026-09-29T07:15:00.000Z'),
  locationLabel: 'Парк Горького',
  note: null,
};
const observationService: ObservationService = {
  create: () => Promise.resolve(observation),
  list: () => Promise.resolve({ observations: [observation], nextCursor: null }),
};
const authorization = { authorization: `Bearer ${'a'.repeat(43)}` };
const app = buildApp({ animalService, clientService, observationService });
afterAll(async () => { await app.close(); });

describe('application foundation', () => {
  it('starts the HTTP pipeline without opening a port or requiring a database', async () => {
    const response = await app.inject({ method: 'GET', url: '/missing' });
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
      paths: Record<string, {
        get?: { operationId?: string; security?: Array<Record<string, unknown>> };
        post?: {
          operationId?: string;
          responses?: Record<string, unknown>;
          security?: Array<Record<string, unknown>>;
        };
      }>;
    }>();
    expect(document).toMatchObject({
      openapi: '3.1.0',
      paths: {
        '/api/v1/animals': { get: { operationId: 'listAnimals' } },
        '/api/v1/clients': { post: { operationId: 'createClient' } },
        '/api/v1/config': { get: { operationId: 'getConfig' } },
        '/api/v1/observations': {
          get: { operationId: 'listObservations' },
          post: { operationId: 'createObservation' },
        },
      },
    });
    expect(document.paths['/api/v1/clients']?.post?.responses?.['429']).toMatchObject({
      headers: {
        'Retry-After': { schema: { type: 'integer', minimum: 1 } },
      },
    });
    expect(document.paths['/api/v1/clients']?.post?.security).toBeUndefined();
    expect(document.paths['/api/v1/animals']?.get?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/api/v1/config']?.get?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/api/v1/observations']?.get?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/api/v1/observations']?.post?.security).toEqual([{ bearerAuth: [] }]);
  });

  it('returns public application configuration to an authenticated client', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/config',
      headers: authorization,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      descriptionsEnabled: true,
      noteMaxLength: 200,
      mapResultLimit: 2000,
    });
  });

  it('returns the authenticated observation list in the common envelope', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/observations?limit=100',
      headers: authorization,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: [{
        id: observation.id,
        animal: {
          id: observation.animalId,
          name: { ru: 'Волк', en: 'Wolf' },
        },
        location: observation.location,
        observedAt: '2026-09-29T07:15:00.000Z',
        locationLabel: 'Парк Горького',
        note: null,
      }],
      meta: { nextCursor: null },
    });
  });

  it('validates observation headers, body and list limits', async () => {
    const invalidCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/observations',
      headers: {
        authorization: `Bearer ${'a'.repeat(43)}`,
        'idempotency-key': 'not-a-uuid',
      },
      payload: {
        animalId: observation.animalId,
        location: { longitude: 181, latitude: 55.7558 },
        observedAt: '2026-09-29T10:15:00+03:00',
      },
    });
    expect(invalidCreate.statusCode).toBe(400);
    expect(invalidCreate.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const invalidList = await app.inject({
      method: 'GET',
      url: '/api/v1/observations?limit=201',
      headers: authorization,
    });
    expect(invalidList.statusCode).toBe(400);
    expect(invalidList.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('returns both localized animal names and a stable icon slug', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/animals',
      headers: authorization,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: [{
        id: '1fa5309c-29bc-5ac8-8ece-37465a6ff3b4',
        slug: 'tiger',
        name: { ru: 'Тигр', en: 'Tiger' },
      }],
    });
  });

  it('returns malformed requests in the common error envelope', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/clients',
      headers: { 'content-type': 'application/json' },
      payload: '{',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: 'REQUEST_INVALID', message: 'Request is invalid' },
    });
  });

  it('keeps client issuance public and protects every other API route', async () => {
    const issued = await app.inject({ method: 'POST', url: '/api/v1/clients' });
    expect(issued.statusCode).toBe(201);

    for (const url of ['/api/v1/animals', '/api/v1/config', '/api/v1/observations']) {
      const missing = await app.inject({ method: 'GET', url });
      expect(missing.statusCode).toBe(401);
      expect(missing.headers['www-authenticate']).toBe('Bearer');
      expect(missing.json()).toMatchObject({ error: { code: 'CLIENT_TOKEN_REQUIRED' } });

      const invalid = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: 'Bearer invalid' },
      });
      expect(invalid.statusCode).toBe(401);
      expect(invalid.json()).toMatchObject({ error: { code: 'CLIENT_TOKEN_INVALID' } });
    }
  });

  it('does not expose the previous unversioned API routes', async () => {
    for (const request of [
      { method: 'POST' as const, url: '/clients' },
      { method: 'GET' as const, url: '/animals' },
      { method: 'GET' as const, url: '/config' },
      { method: 'GET' as const, url: '/observations' },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(404);
    }
  });
});
