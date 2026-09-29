import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { count, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createDatabase } from '../../src/infrastructure/database.js';
import { applyMigrations } from '../../src/infrastructure/database/migrate.js';
import {
  animals,
  clientIssuanceEvents,
  clients,
  observationIdempotency,
  observations,
  publicationEvents,
  votes,
} from '../../src/infrastructure/database/schema.js';
import { createPostgresAnimalRepository } from '../../src/modules/animals/animal-repository.js';
import { createAnimalService } from '../../src/modules/animals/animal-service.js';
import { createPostgresClientRepository } from '../../src/modules/clients/client-repository.js';
import { createClientService } from '../../src/modules/clients/client-service.js';
import { createClientAuthenticationHook } from '../../src/modules/clients/http.js';
import { createPublicConfig } from '../../src/modules/config/public-config.js';
import { createPostgresObservationRepository } from '../../src/modules/observations/observation-repository.js';
import { createObservationService } from '../../src/modules/observations/observation-service.js';

function readTestDatabaseUrl() {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('TEST_DATABASE_URL is required; DATABASE_URL is never used');
  const url = new URL(connectionString);
  // Destructive setup is deliberately restricted to the disposable Compose test service.
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || url.hostname !== '127.0.0.1' || url.port !== '5434'
    || url.pathname !== '/animals_test' || url.username !== 'animals_test'
    || url.search || url.hash) {
    throw new Error('Use the dedicated local animals_test database on port 5434');
  }
  return connectionString;
}

const connectionString = readTestDatabaseUrl();
const database = createDatabase(connectionString);
const animalService = createAnimalService(createPostgresAnimalRepository(database.db));
const clientService = createClientService(createPostgresClientRepository(database.db));
const observationService = createObservationService(createPostgresObservationRepository(database.db));
let upgradeResult: {
  animalId: string;
  iconColumnCount: number;
  isActive: boolean;
  nameEn: string;
  nameRu: string;
  observationAnimalId: string;
};

async function executeMigrationFile(relativePath: string) {
  const migration = await readFile(new URL(relativePath, import.meta.url), 'utf8');
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim()) await database.pool.query(statement);
  }
}

async function seedReferences() {
  const [animal] = await database.db.insert(animals).values({
    slug: `test-${randomUUID()}`,
    nameRu: 'Тестовое животное',
    nameEn: 'Test animal',
  }).returning({ id: animals.id });
  const [author, voter] = await database.db.insert(clients).values([
    { tokenHash: 'a'.repeat(64) },
    { tokenHash: 'b'.repeat(64) },
  ]).returning({ id: clients.id });
  if (!animal || !author || !voter) throw new Error('Failed to create test references');
  return { animalId: animal.id, authorId: author.id, voterId: voter.id };
}

async function seedAuthenticatedClient(token = 'c'.repeat(43)) {
  const [client] = await database.db.insert(clients).values({
    tokenHash: createHash('sha256').update(token).digest('hex'),
  }).returning({ id: clients.id });
  if (!client) throw new Error('Failed to create authenticated test client');
  return { clientId: client.id, token };
}

describe('database migrations and constraints', () => {
  beforeAll(async () => {
    await database.pool.query('DROP SCHEMA public CASCADE');
    await database.pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await database.pool.query('CREATE SCHEMA public');
    await executeMigrationFile('../../drizzle/0000_natural_talkback.sql');
    const legacyAnimalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const legacyClientId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await database.pool.query(`
      INSERT INTO animals (id, slug, name_ru, name_en, icon)
      VALUES ($1, 'tiger', 'Старое название', 'Old name', 'old-icon')
    `, [legacyAnimalId]);
    await database.pool.query(`
      INSERT INTO clients (id, token_hash) VALUES ($1, $2)
    `, [legacyClientId, 'a'.repeat(64)]);
    await database.pool.query(`
      INSERT INTO observations (animal_id, client_id, location, observed_at)
      VALUES ($1, $2, ST_SetSRID(ST_MakePoint(37.6, 55.7), 4326), now() - interval '1 minute')
    `, [legacyAnimalId, legacyClientId]);
    await executeMigrationFile('../../drizzle/0001_pink_loners.sql');
    const upgraded = await database.pool.query<{
      animalId: string;
      iconColumnCount: number;
      isActive: boolean;
      nameEn: string;
      nameRu: string;
      observationAnimalId: string;
    }>(`
      SELECT animal.id AS "animalId",
             animal.is_active AS "isActive",
             animal.name_ru AS "nameRu",
             animal.name_en AS "nameEn",
             observation.animal_id AS "observationAnimalId",
             (
               SELECT count(*)::int
               FROM information_schema.columns
               WHERE table_schema = 'public'
                 AND table_name = 'animals'
                 AND column_name = 'icon'
             ) AS "iconColumnCount"
      FROM animals animal
      JOIN observations observation ON observation.animal_id = animal.id
      WHERE animal.slug = 'tiger'
    `);
    const row = upgraded.rows[0];
    if (!row) throw new Error('Migration upgrade check did not return the legacy animal');
    upgradeResult = row;

    await database.pool.query('DROP SCHEMA public CASCADE');
    await database.pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await database.pool.query('CREATE SCHEMA public');
    await applyMigrations(connectionString);
    // Applying the command repeatedly must not replay an already recorded migration.
    await applyMigrations(connectionString);
  });

  it('upgrades existing animals without breaking observation references', () => {
    expect(upgradeResult).toEqual({
      animalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      iconColumnCount: 0,
      isActive: true,
      nameEn: 'Tiger',
      nameRu: 'Тигр',
      observationAnimalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
  });

  it('issues an opaque token while storing only its SHA-256 hash', async () => {
    const app = buildApp({ animalService, clientService, observationService });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/clients',
        remoteAddress: '203.0.113.10',
      });

      expect(response.statusCode).toBe(201);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = response.json<{ data: { token: string } }>();
      expect(body.data.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const storedClients = await database.db.select({ tokenHash: clients.tokenHash }).from(clients);
      expect(storedClients).toEqual([{
        tokenHash: createHash('sha256').update(body.data.token).digest('hex'),
      }]);
      expect(JSON.stringify(storedClients)).not.toContain(body.data.token);
    } finally {
      await app.close();
    }
  });

  it('authenticates a valid bearer token and returns stable credential errors', async () => {
    const app = buildApp({ animalService, clientService, observationService });
    app.get('/test/protected', {
      schema: { hide: true },
      preHandler: createClientAuthenticationHook(clientService),
    }, (request) => ({ data: { clientId: request.client?.id } }));

    try {
      const issuance = await app.inject({
        method: 'POST',
        url: '/api/v1/clients',
        remoteAddress: '203.0.113.11',
      });
      const token = issuance.json<{ data: { token: string } }>().data.token;

      const missing = await app.inject({ method: 'GET', url: '/test/protected' });
      expect(missing.statusCode).toBe(401);
      expect(missing.headers['www-authenticate']).toBe('Bearer');
      expect(missing.json()).toMatchObject({ error: { code: 'CLIENT_TOKEN_REQUIRED' } });

      const invalid = await app.inject({
        method: 'GET',
        url: '/test/protected',
        headers: { authorization: `Bearer ${'a'.repeat(43)}` },
      });
      expect(invalid.statusCode).toBe(401);
      expect(invalid.headers['www-authenticate']).toBe('Bearer');
      expect(invalid.json()).toMatchObject({ error: { code: 'CLIENT_TOKEN_INVALID' } });

      const authenticated = await app.inject({
        method: 'GET',
        url: '/test/protected',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(authenticated.statusCode).toBe(200);
      const authenticatedBody = authenticated.json<{ data: { clientId: string } }>();
      expect(authenticatedBody.data.clientId).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await app.close();
    }
  });

  it('atomically limits issuance to ten requests per address and blocks for one hour', async () => {
    const app = buildApp({ animalService, clientService, observationService });
    try {
      const responses = await Promise.all(Array.from({ length: 12 }, () => app.inject({
        method: 'POST',
        url: '/api/v1/clients',
        remoteAddress: '2001:db8:1234:5678::1234',
      })));
      const statuses = responses.map((response) => response.statusCode).sort();
      expect(statuses).toEqual([...Array<number>(10).fill(201), 429, 429]);

      const limited = responses.find((response) => response.statusCode === 429);
      expect(limited?.headers['retry-after']).toBe('3600');
      expect(limited?.json()).toMatchObject({
        error: { code: 'CLIENT_ISSUANCE_RATE_LIMITED' },
      });

      const storedClients = await database.db.select().from(clients);
      const events = await database.db.select({ wasIssued: clientIssuanceEvents.wasIssued })
        .from(clientIssuanceEvents);
      expect(storedClients).toHaveLength(10);
      expect(events.filter((event) => event.wasIssued)).toHaveLength(10);
      expect(events.filter((event) => !event.wasIssued)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  beforeEach(async () => {
    await database.pool.query(`
      TRUNCATE TABLE
        observation_idempotency,
        publication_events,
        client_issuance_events,
        votes,
        observations,
        clients
    `);
    await database.pool.query(`DELETE FROM animals WHERE slug LIKE 'test-%'`);
    await database.pool.query(`UPDATE animals SET is_active = true`);
  });

  afterAll(async () => {
    await database.pool.end();
  });

  it('applies migrations repeatedly and seeds the animal directory', async () => {
    const result = await database.db.execute<{
      database: string;
      postgis: string;
      migrationCount: number;
      animalCount: number;
    }>(sql`
      select current_database() as database,
             postgis_version() as postgis,
             (select count(*)::int from drizzle.__drizzle_migrations) as "migrationCount",
             (select count(*)::int from animals) as "animalCount"
    `);
    expect(result.rows[0]).toMatchObject({
      database: 'animals_test',
      migrationCount: 2,
      animalCount: 116,
    });
    expect(result.rows[0]?.postgis).toMatch(/^3\./);
  });

  it('returns active animals with both localized names', async () => {
    const { token } = await seedAuthenticatedClient();
    await database.db.update(animals).set({ isActive: false }).where(eq(animals.slug, 'tiger'));
    const app = buildApp({ animalService, clientService, observationService });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/animals',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{
        data: Array<{ id: string; slug: string; name: { ru: string; en: string } }>;
      }>();
      expect(body.data).toHaveLength(115);
      expect(body.data.some((animal) => animal.slug === 'tiger')).toBe(false);
      expect(body.data.find((animal) => animal.slug === 'wolf')).toMatchObject({
        id: '423e53fb-01c1-521b-8b29-6cccf5268618',
        name: { ru: 'Волк', en: 'Wolf' },
      });
    } finally {
      await app.close();
    }
  });

  it('returns public configuration only to authenticated clients', async () => {
    const { token } = await seedAuthenticatedClient();
    const app = buildApp({ animalService, clientService, observationService });
    try {
      const missing = await app.inject({ method: 'GET', url: '/api/v1/config' });
      expect(missing.statusCode).toBe(401);
      expect(missing.json()).toMatchObject({ error: { code: 'CLIENT_TOKEN_REQUIRED' } });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/config',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        descriptionsEnabled: true,
        noteMaxLength: 200,
        mapResultLimit: 2000,
      });
    } finally {
      await app.close();
    }
  });

  it('creates an observation for an active animal and validates business constraints', async () => {
    const { token } = await seedAuthenticatedClient();
    const app = buildApp({ animalService, clientService, observationService });
    const headers = {
      authorization: `Bearer ${token}`,
      'idempotency-key': randomUUID(),
    };
    const observedAt = new Date(Date.now() - 60_000).toISOString();
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/observations',
        headers,
        payload: {
          animalId: '423e53fb-01c1-521b-8b29-6cccf5268618',
          location: { longitude: 37.6176, latitude: 55.7558 },
          observedAt,
          locationLabel: 'Парк Горького',
          note: null,
        },
      });
      expect(created.statusCode).toBe(201);
      expect(created.headers['cache-control']).toBe('private, no-store');
      const createdBody = created.json<{ data: { id: string; observedAt: string } }>();
      expect(createdBody.data.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(createdBody).toEqual({
        data: {
          id: createdBody.data.id,
          animalId: '423e53fb-01c1-521b-8b29-6cccf5268618',
          location: { longitude: 37.6176, latitude: 55.7558, label: 'Парк Горького' },
          observedAt,
          note: null,
          votes: { confirm: 0, reject: 0 },
          confirmationPercent: null,
          userVote: null,
        },
      });

      await database.db.update(animals).set({ isActive: false })
        .where(eq(animals.id, '1fa5309c-29bc-5ac8-8ece-37465a6ff3b4'));
      const inactive = await app.inject({
        method: 'POST',
        url: '/api/v1/observations',
        headers: { ...headers, 'idempotency-key': randomUUID() },
        payload: {
          animalId: '1fa5309c-29bc-5ac8-8ece-37465a6ff3b4',
          location: { longitude: 37.6, latitude: 55.7 },
          observedAt: new Date(Date.now() - 60_000).toISOString(),
        },
      });
      expect(inactive.statusCode).toBe(422);
      expect(inactive.json()).toMatchObject({ error: { code: 'ANIMAL_NOT_AVAILABLE' } });

      const tooOld = await app.inject({
        method: 'POST',
        url: '/api/v1/observations',
        headers: { ...headers, 'idempotency-key': randomUUID() },
        payload: {
          animalId: '423e53fb-01c1-521b-8b29-6cccf5268618',
          location: { longitude: 37.6, latitude: 55.7 },
          observedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
        },
      });
      expect(tooOld.statusCode).toBe(400);
      expect(tooOld.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    } finally {
      await app.close();
    }
  });

  it('creates one observation for identical concurrent retries and rejects key reuse', async () => {
    const { clientId, token } = await seedAuthenticatedClient();
    const app = buildApp({ animalService, clientService, observationService });
    const idempotencyKey = randomUUID();
    const request = {
      method: 'POST' as const,
      url: '/api/v1/observations',
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': idempotencyKey,
      },
      payload: {
        animalId: '423e53fb-01c1-521b-8b29-6cccf5268618',
        location: { longitude: 37.6176, latitude: 55.7558 },
        observedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    };
    try {
      const retries = await Promise.all([app.inject(request), app.inject(request)]);
      expect(retries.map((response) => response.statusCode)).toEqual([201, 201]);
      const ids = retries.map((response) => response.json<{ data: { id: string } }>().data.id);
      expect(new Set(ids).size).toBe(1);
      expect(await database.db.select({ value: count() }).from(observations)).toEqual([{ value: 1 }]);

      const observationId = ids[0];
      if (!observationId) throw new Error('Concurrent creation did not return an observation id');
      const [{ id: otherClientId } = {}] = await database.db.insert(clients).values({
        tokenHash: 'f'.repeat(64),
      }).returning({ id: clients.id });
      if (!otherClientId) throw new Error('Failed to create another voter');
      await database.db.insert(votes).values([
        { observationId, clientId, value: 'confirm' },
        { observationId, clientId: otherClientId, value: 'reject' },
      ]);

      const replayed = await app.inject(request);
      expect(replayed.statusCode).toBe(201);
      expect(replayed.json()).toMatchObject({
        data: {
          id: observationId,
          votes: { confirm: 1, reject: 1 },
          confirmationPercent: 50,
          userVote: 'confirm',
        },
      });

      const conflict = await app.inject({
        ...request,
        payload: {
          ...request.payload,
          location: { longitude: 37.7, latitude: 55.8 },
        },
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REUSED' } });
      expect(await database.db.select({ value: count() }).from(observations)).toEqual([{ value: 1 }]);

      await database.db.delete(observations).where(eq(observations.id, observationId));
      const gone = await app.inject(request);
      expect(gone.statusCode).toBe(409);
      expect(gone.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_RESULT_GONE' } });
    } finally {
      await app.close();
    }
  });

  it('enforces every adaptive publication interval at its time boundary', async () => {
    const { clientId, token } = await seedAuthenticatedClient();
    const app = buildApp({ animalService, clientService, observationService });
    const publish = () => app.inject({
      method: 'POST',
      url: '/api/v1/observations',
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': randomUUID(),
      },
      payload: {
        animalId: '423e53fb-01c1-521b-8b29-6cccf5268618',
        location: { longitude: 37.6176, latitude: 55.7558 },
        observedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    const resetPublications = async () => {
      await database.db.delete(observationIdempotency);
      await database.db.delete(observations);
      await database.db.delete(publicationEvents);
    };
    const seedPublications = async (amount: number, latestAt: Date) => {
      await database.db.insert(publicationEvents).values(Array.from({ length: amount }, (_, index) => ({
        clientId,
        publishedAt: new Date(latestAt.getTime() - index * 1000),
      })));
    };

    try {
      const first = await publish();
      expect(first.statusCode).toBe(201);
      expect(await database.db.select({ value: count() }).from(publicationEvents))
        .toEqual([{ value: 1 }]);

      for (const { recentCount, pauseSeconds } of [
        { recentCount: 1, pauseSeconds: 30 },
        { recentCount: 2, pauseSeconds: 60 },
        { recentCount: 3, pauseSeconds: 180 },
        { recentCount: 4, pauseSeconds: 180 },
        { recentCount: 5, pauseSeconds: 600 },
        { recentCount: 6, pauseSeconds: 600 },
      ]) {
        await resetPublications();
        const blockedLatestAt = new Date(Date.now() - 500);
        await seedPublications(recentCount, blockedLatestAt);

        const blocked = await publish();
        expect(blocked.statusCode).toBe(429);
        expect(blocked.headers['cache-control']).toBe('private, no-store');
        const blockedBody = blocked.json<{
          error: { code: string; retryAfterSeconds: number; availableAt: string };
        }>();
        expect(blockedBody.error).toEqual({
          code: 'RATE_LIMITED',
          message: 'Observation publication rate limit exceeded',
          retryAfterSeconds: blockedBody.error.retryAfterSeconds,
          availableAt: new Date(
            blockedLatestAt.getTime() + pauseSeconds * 1000,
          ).toISOString(),
        });
        expect(blockedBody.error.retryAfterSeconds).toBeGreaterThanOrEqual(pauseSeconds - 2);
        expect(blockedBody.error.retryAfterSeconds).toBeLessThanOrEqual(pauseSeconds);
        expect(blocked.headers['retry-after']).toBe(String(blockedBody.error.retryAfterSeconds));
        expect(await database.db.select({ value: count() }).from(publicationEvents))
          .toEqual([{ value: recentCount }]);
        expect(await database.db.select({ value: count() }).from(observations))
          .toEqual([{ value: 0 }]);

        await resetPublications();
        await seedPublications(
          recentCount,
          new Date(Date.now() - pauseSeconds * 1000 - 1000),
        );
        const allowed = await publish();
        expect(allowed.statusCode).toBe(201);
        expect(await database.db.select({ value: count() }).from(publicationEvents))
          .toEqual([{ value: recentCount + 1 }]);
        expect(await database.db.select({ value: count() }).from(observations))
          .toEqual([{ value: 1 }]);
      }
    } finally {
      await app.close();
    }
  });

  it('does not charge idempotent replays or extend a rejected publication pause', async () => {
    const { token } = await seedAuthenticatedClient();
    const app = buildApp({ animalService, clientService, observationService });
    const request = {
      method: 'POST' as const,
      url: '/api/v1/observations',
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': randomUUID(),
      },
      payload: {
        animalId: '423e53fb-01c1-521b-8b29-6cccf5268618',
        location: { longitude: 37.6176, latitude: 55.7558 },
        observedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    };
    try {
      const created = await app.inject(request);
      const replayed = await app.inject(request);
      expect([created.statusCode, replayed.statusCode]).toEqual([201, 201]);
      expect(replayed.json<{ data: { id: string } }>().data.id)
        .toBe(created.json<{ data: { id: string } }>().data.id);
      expect(await database.db.select({ value: count() }).from(publicationEvents))
        .toEqual([{ value: 1 }]);

      const newRequest = {
        ...request,
        headers: { ...request.headers, 'idempotency-key': randomUUID() },
      };
      const firstRejection = await app.inject(newRequest);
      const secondRejection = await app.inject({
        ...newRequest,
        headers: { ...newRequest.headers, 'idempotency-key': randomUUID() },
      });
      expect([firstRejection.statusCode, secondRejection.statusCode]).toEqual([429, 429]);
      expect(secondRejection.json<{ error: { availableAt: string } }>().error.availableAt)
        .toBe(firstRejection.json<{ error: { availableAt: string } }>().error.availableAt);
      expect(await database.db.select({ value: count() }).from(publicationEvents))
        .toEqual([{ value: 1 }]);
      expect(await database.db.select({ value: count() }).from(observations))
        .toEqual([{ value: 1 }]);
    } finally {
      await app.close();
    }
  });

  it('allows only one of two parallel new publications for the same client', async () => {
    const { token } = await seedAuthenticatedClient();
    const app = buildApp({ animalService, clientService, observationService });
    const request = (idempotencyKey: string) => ({
      method: 'POST' as const,
      url: '/api/v1/observations',
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': idempotencyKey,
      },
      payload: {
        animalId: '423e53fb-01c1-521b-8b29-6cccf5268618',
        location: { longitude: 37.6176, latitude: 55.7558 },
        observedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    try {
      const responses = await Promise.all([
        app.inject(request(randomUUID())),
        app.inject(request(randomUUID())),
      ]);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 429]);
      expect(await database.db.select({ value: count() }).from(publicationEvents))
        .toEqual([{ value: 1 }]);
      expect(await database.db.select({ value: count() }).from(observations))
        .toEqual([{ value: 1 }]);
      expect(await database.db.select({ value: count() }).from(observationIdempotency))
        .toEqual([{ value: 1 }]);
    } finally {
      await app.close();
    }
  });

  it('removes publication events older than 24 hours during a new publication', async () => {
    const { clientId, token } = await seedAuthenticatedClient();
    const { clientId: staleClientId } = await seedAuthenticatedClient('j'.repeat(43));
    await database.db.insert(publicationEvents).values({
      clientId: staleClientId,
      publishedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    const app = buildApp({ animalService, clientService, observationService });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/observations',
        headers: {
          authorization: `Bearer ${token}`,
          'idempotency-key': randomUUID(),
        },
        payload: {
          animalId: '423e53fb-01c1-521b-8b29-6cccf5268618',
          location: { longitude: 37.6176, latitude: 55.7558 },
          observedAt: new Date(Date.now() - 60_000).toISOString(),
        },
      });

      expect(response.statusCode).toBe(201);
      expect(await database.db.select({ clientId: publicationEvents.clientId })
        .from(publicationEvents)).toEqual([{ clientId }]);
    } finally {
      await app.close();
    }
  });

  it('returns personalized details and hides unknown, deleted and expired observations uniformly', async () => {
    const { clientId, token } = await seedAuthenticatedClient();
    const { clientId: otherClientId, token: otherToken } = await seedAuthenticatedClient('g'.repeat(43));
    const now = Date.now();
    const [current, expired, deleted] = await database.db.insert(observations).values([
      {
        animalId: '423e53fb-01c1-521b-8b29-6cccf5268618',
        clientId,
        location: { longitude: 37.6176, latitude: 55.7558 },
        locationLabel: 'Парк Горького',
        observedAt: new Date(now - 60_000),
        note: 'У воды',
      },
      {
        animalId: '423e53fb-01c1-521b-8b29-6cccf5268618',
        clientId,
        location: { longitude: 30, latitude: 50 },
        observedAt: new Date(now - 31 * 24 * 60 * 60 * 1000),
        createdAt: new Date(now - 31 * 24 * 60 * 60 * 1000),
      },
      {
        animalId: '423e53fb-01c1-521b-8b29-6cccf5268618',
        clientId,
        location: { longitude: 31, latitude: 51 },
        observedAt: new Date(now - 60_000),
      },
    ]).returning({ id: observations.id });
    if (!current || !expired || !deleted) throw new Error('Failed to create detail fixtures');
    await database.db.insert(votes).values([
      { observationId: current.id, clientId, value: 'confirm' },
      { observationId: current.id, clientId: otherClientId, value: 'reject' },
    ]);
    await database.db.delete(observations).where(eq(observations.id, deleted.id));

    const app = buildApp({ animalService, clientService, observationService });
    try {
      const ownDetails = await app.inject({
        method: 'GET',
        url: `/api/v1/observations/${current.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(ownDetails.statusCode).toBe(200);
      expect(ownDetails.headers['cache-control']).toBe('private, no-store');
      expect(ownDetails.json()).toEqual({
        data: {
          id: current.id,
          animalId: '423e53fb-01c1-521b-8b29-6cccf5268618',
          location: { longitude: 37.6176, latitude: 55.7558, label: 'Парк Горького' },
          observedAt: new Date(now - 60_000).toISOString(),
          note: 'У воды',
          votes: { confirm: 1, reject: 1 },
          confirmationPercent: 50,
          userVote: 'confirm',
        },
      });

      const otherDetails = await app.inject({
        method: 'GET',
        url: `/api/v1/observations/${current.id}`,
        headers: { authorization: `Bearer ${otherToken}` },
      });
      expect(otherDetails.statusCode).toBe(200);
      expect(otherDetails.json()).toMatchObject({ data: { userVote: 'reject' } });

      for (const id of [randomUUID(), deleted.id, expired.id]) {
        const missing = await app.inject({
          method: 'GET',
          url: `/api/v1/observations/${id}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(missing.statusCode).toBe(404);
        expect(missing.json()).toEqual({
          error: { code: 'OBSERVATION_NOT_FOUND', message: 'Observation not found' },
        });
      }
    } finally {
      await app.close();
    }
  });

  it('creates, changes, repeats and removes a vote with current personalized counters', async () => {
    const { clientId, token } = await seedAuthenticatedClient();
    const { clientId: otherClientId } = await seedAuthenticatedClient('h'.repeat(43));
    const [observation] = await database.db.insert(observations).values({
      animalId: '423e53fb-01c1-521b-8b29-6cccf5268618',
      clientId,
      location: { longitude: 37.6176, latitude: 55.7558 },
      observedAt: new Date(Date.now() - 60_000),
    }).returning({ id: observations.id });
    if (!observation) throw new Error('Failed to create vote fixture');
    await database.db.insert(votes).values({
      observationId: observation.id,
      clientId: otherClientId,
      value: 'reject',
    });

    const app = buildApp({ animalService, clientService, observationService });
    const vote = (value: 'confirm' | 'reject' | null) => app.inject({
      method: 'PUT',
      url: `/api/v1/observations/${observation.id}/vote`,
      headers: { authorization: `Bearer ${token}` },
      payload: { value },
    });
    try {
      for (const expected of [
        { value: 'confirm' as const, confirm: 1, reject: 1 },
        { value: 'confirm' as const, confirm: 1, reject: 1 },
        { value: 'reject' as const, confirm: 0, reject: 2 },
        { value: null, confirm: 0, reject: 1 },
        { value: null, confirm: 0, reject: 1 },
      ]) {
        const response = await vote(expected.value);
        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('private, no-store');
        expect(response.json()).toMatchObject({
          data: {
            id: observation.id,
            votes: { confirm: expected.confirm, reject: expected.reject },
            userVote: expected.value,
          },
        });
      }

      expect(await database.db.select({
        clientId: votes.clientId,
        value: votes.value,
      }).from(votes)).toEqual([{ clientId: otherClientId, value: 'reject' }]);
    } finally {
      await app.close();
    }
  });

  it('serializes parallel voting and keeps one vote per client', async () => {
    const { clientId, token } = await seedAuthenticatedClient();
    const [observation] = await database.db.insert(observations).values({
      animalId: '423e53fb-01c1-521b-8b29-6cccf5268618',
      clientId,
      location: { longitude: 37.6176, latitude: 55.7558 },
      observedAt: new Date(Date.now() - 60_000),
    }).returning({ id: observations.id });
    if (!observation) throw new Error('Failed to create concurrent vote fixture');

    const app = buildApp({ animalService, clientService, observationService });
    try {
      const repeated = await Promise.all(Array.from({ length: 8 }, () => app.inject({
        method: 'PUT',
        url: `/api/v1/observations/${observation.id}/vote`,
        headers: { authorization: `Bearer ${token}` },
        payload: { value: 'confirm' },
      })));
      expect(repeated.every((response) => response.statusCode === 200)).toBe(true);
      expect(repeated.every((response) => {
        const body = response.json<{
          data: { votes: { confirm: number; reject: number }; userVote: string | null };
        }>();
        return body.data.votes.confirm === 1
          && body.data.votes.reject === 0
          && body.data.userVote === 'confirm';
      })).toBe(true);
      expect(await database.db.select({ value: count() }).from(votes)).toEqual([{ value: 1 }]);

      await database.db.delete(votes).where(eq(votes.observationId, observation.id));
      const voters = await Promise.all(Array.from({ length: 12 }, async (_, index) => {
        const voterToken = `${String(index).padStart(2, '0')}${'v'.repeat(41)}`;
        return seedAuthenticatedClient(voterToken);
      }));
      const parallel = await Promise.all(voters.map(({ token: voterToken }) => app.inject({
        method: 'PUT',
        url: `/api/v1/observations/${observation.id}/vote`,
        headers: { authorization: `Bearer ${voterToken}` },
        payload: { value: 'confirm' },
      })));
      expect(parallel.every((response) => response.statusCode === 200)).toBe(true);
      const returnedCounts = parallel.map((response) => response.json<{
        data: { votes: { confirm: number }; userVote: string | null };
      }>().data.votes.confirm).sort((left, right) => left - right);
      expect(returnedCounts).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
      expect(parallel.every((response) => response.json<{
        data: { userVote: string | null };
      }>().data.userVote === 'confirm')).toBe(true);
      expect(await database.db.select({ value: count() }).from(votes)).toEqual([{ value: 12 }]);
    } finally {
      await app.close();
    }
  });

  it('hides unknown, deleted and expired observations uniformly when voting', async () => {
    const { clientId, token } = await seedAuthenticatedClient();
    const now = Date.now();
    const [expired, deleted] = await database.db.insert(observations).values([
      {
        animalId: '423e53fb-01c1-521b-8b29-6cccf5268618',
        clientId,
        location: { longitude: 30, latitude: 50 },
        observedAt: new Date(now - 31 * 24 * 60 * 60 * 1000),
        createdAt: new Date(now - 31 * 24 * 60 * 60 * 1000),
      },
      {
        animalId: '423e53fb-01c1-521b-8b29-6cccf5268618',
        clientId,
        location: { longitude: 31, latitude: 51 },
        observedAt: new Date(now - 60_000),
      },
    ]).returning({ id: observations.id });
    if (!expired || !deleted) throw new Error('Failed to create unavailable vote fixtures');
    await database.db.delete(observations).where(eq(observations.id, deleted.id));

    const app = buildApp({ animalService, clientService, observationService });
    try {
      for (const id of [randomUUID(), deleted.id, expired.id]) {
        const response = await app.inject({
          method: 'PUT',
          url: `/api/v1/observations/${id}/vote`,
          headers: { authorization: `Bearer ${token}` },
          payload: { value: 'confirm' },
        });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({
          error: { code: 'OBSERVATION_NOT_FOUND', message: 'Observation not found' },
        });
      }
      expect(await database.db.select({ value: count() }).from(votes)).toEqual([{ value: 0 }]);
    } finally {
      await app.close();
    }
  });

  it('rejects new descriptions when disabled but allows a successful idempotent replay', async () => {
    const { clientId, token } = await seedAuthenticatedClient();
    const idempotencyKey = randomUUID();
    const request = {
      method: 'POST' as const,
      url: '/api/v1/observations',
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': idempotencyKey,
      },
      payload: {
        animalId: '423e53fb-01c1-521b-8b29-6cccf5268618',
        location: { longitude: 37.6176, latitude: 55.7558 },
        observedAt: new Date(Date.now() - 60_000).toISOString(),
        note: 'Видел у тропы',
      },
    };
    const enabledApp = buildApp({ animalService, clientService, observationService });
    try {
      const created = await enabledApp.inject(request);
      expect(created.statusCode).toBe(201);
    } finally {
      await enabledApp.close();
    }

    const disabledConfig = createPublicConfig(false);
    const disabledObservationService = createObservationService(
      createPostgresObservationRepository(database.db),
      disabledConfig,
    );
    const disabledApp = buildApp({
      animalService,
      clientService,
      observationService: disabledObservationService,
      publicConfig: disabledConfig,
    });
    try {
      const configResponse = await disabledApp.inject({
        method: 'GET',
        url: '/api/v1/config',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(configResponse.statusCode).toBe(200);
      expect(configResponse.json()).toMatchObject({ descriptionsEnabled: false });

      const replayed = await disabledApp.inject(request);
      expect(replayed.statusCode).toBe(201);
      expect(replayed.json<{ data: { note: string | null } }>()).toMatchObject({
        data: { note: 'Видел у тропы' },
      });

      const rejected = await disabledApp.inject({
        ...request,
        headers: { ...request.headers, 'idempotency-key': randomUUID() },
      });
      expect(rejected.statusCode).toBe(422);
      expect(rejected.json()).toMatchObject({ error: { code: 'DESCRIPTION_DISABLED' } });

      await database.db.update(publicationEvents).set({
        publishedAt: new Date(Date.now() - 31_000),
      }).where(eq(publicationEvents.clientId, clientId));
      const withoutDescription = await disabledApp.inject({
        ...request,
        headers: { ...request.headers, 'idempotency-key': randomUUID() },
        payload: { ...request.payload, note: null },
      });
      expect(withoutDescription.statusCode).toBe(201);
    } finally {
      await disabledApp.close();
    }
  });

  it('filters map observations by animals, period and bounds with stable vote aggregates', async () => {
    const { clientId, token } = await seedAuthenticatedClient();
    const wolfId = '423e53fb-01c1-521b-8b29-6cccf5268618';
    const tigerId = '1fa5309c-29bc-5ac8-8ece-37465a6ff3b4';
    const now = Date.now();
    const ids = {
      first: '00000000-0000-4000-8000-000000000001',
      second: '00000000-0000-4000-8000-000000000002',
      eastOfDateLine: '00000000-0000-4000-8000-000000000003',
      westOfDateLine: '00000000-0000-4000-8000-000000000004',
      outsideBounds: '00000000-0000-4000-8000-000000000005',
      outsidePeriod: '00000000-0000-4000-8000-000000000006',
      expired: '00000000-0000-4000-8000-000000000007',
    };
    await database.db.insert(observations).values([
      {
        id: ids.first,
        animalId: wolfId,
        clientId,
        location: { longitude: 30, latitude: 50 },
        observedAt: new Date(now - 60_000),
      },
      {
        id: ids.second,
        animalId: tigerId,
        clientId,
        location: { longitude: 37.62, latitude: 55.76 },
        observedAt: new Date(now - 60_000),
      },
      {
        id: ids.eastOfDateLine,
        animalId: wolfId,
        clientId,
        location: { longitude: 179, latitude: 10 },
        observedAt: new Date(now - 120_000),
      },
      {
        id: ids.westOfDateLine,
        animalId: tigerId,
        clientId,
        location: { longitude: -179, latitude: 10 },
        observedAt: new Date(now - 120_000),
      },
      {
        id: ids.outsideBounds,
        animalId: wolfId,
        clientId,
        location: { longitude: 41, latitude: 55 },
        observedAt: new Date(now - 120_000),
      },
      {
        id: ids.outsidePeriod,
        animalId: wolfId,
        clientId,
        location: { longitude: 35, latitude: 55 },
        observedAt: new Date(now - 25 * 60 * 60 * 1000),
      },
      {
        id: ids.expired,
        animalId: wolfId,
        clientId,
        location: { longitude: 35, latitude: 55 },
        observedAt: new Date(now - 31 * 24 * 60 * 60 * 1000),
        createdAt: new Date(now - 31 * 24 * 60 * 60 * 1000),
      },
    ]);
    const voters = await database.db.insert(clients).values([
      { tokenHash: 'd'.repeat(64) },
      { tokenHash: 'e'.repeat(64) },
    ]).returning({ id: clients.id });
    if (!voters[0] || !voters[1]) throw new Error('Failed to create map voters');
    await database.db.insert(votes).values([
      { observationId: ids.first, clientId, value: 'confirm' },
      { observationId: ids.first, clientId: voters[0].id, value: 'confirm' },
      { observationId: ids.first, clientId: voters[1].id, value: 'reject' },
    ]);
    await database.db.update(animals).set({ isActive: false }).where(eq(animals.id, wolfId));

    const app = buildApp({ animalService, clientService, observationService });
    try {
      const bounded = await app.inject({
        method: 'GET',
        url: `/api/v1/observations?animalIds=${wolfId},${tigerId}&period=24h&west=30&south=50&east=40&north=60`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(bounded.statusCode).toBe(200);
      expect(bounded.json()).toEqual({
        items: [
          {
            id: ids.first,
            animalId: wolfId,
            location: { longitude: 30, latitude: 50 },
            observedAt: new Date(now - 60_000).toISOString(),
            votes: { confirm: 2, reject: 1 },
            confirmationPercent: 67,
          },
          {
            id: ids.second,
            animalId: tigerId,
            location: { longitude: 37.62, latitude: 55.76 },
            observedAt: new Date(now - 60_000).toISOString(),
            votes: { confirm: 0, reject: 0 },
            confirmationPercent: null,
          },
        ],
        truncated: false,
        limit: 2000,
      });

      const boundaryPoint = await app.inject({
        method: 'GET',
        url: `/api/v1/observations?animalIds=${wolfId}&period=24h&west=30&south=50&east=30&north=50`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(boundaryPoint.statusCode).toBe(200);
      expect(boundaryPoint.json<{ items: Array<{ id: string }> }>().items.map((item) => item.id))
        .toEqual([ids.first]);

      const acrossDateLine = await app.inject({
        method: 'GET',
        url: `/api/v1/observations?animalIds=${wolfId},${tigerId}&period=24h&west=170&south=0&east=-170&north=20`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(acrossDateLine.statusCode).toBe(200);
      expect(acrossDateLine.json<{ items: Array<{ id: string }> }>().items.map((item) => item.id))
        .toEqual([ids.eastOfDateLine, ids.westOfDateLine]);

      const unknownAnimal = await app.inject({
        method: 'GET',
        url: `/api/v1/observations?animalIds=${randomUUID()}&period=24h&west=-180&south=-90&east=180&north=90`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(unknownAnimal.statusCode).toBe(400);
      expect(unknownAnimal.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    } finally {
      await app.close();
    }
  });

  it('reports truncation only when more than 2000 map observations match', async () => {
    const { clientId, token } = await seedAuthenticatedClient();
    const wolfId = '423e53fb-01c1-521b-8b29-6cccf5268618';
    const observedAt = new Date(Date.now() - 60_000);
    await database.db.insert(observations).values(Array.from({ length: 2000 }, () => ({
      animalId: wolfId,
      clientId,
      location: { longitude: 37.6, latitude: 55.7 },
      observedAt,
    })));

    const app = buildApp({ animalService, clientService, observationService });
    const request = {
      method: 'GET' as const,
      url: `/api/v1/observations?animalIds=${wolfId}&period=24h&west=-180&south=-90&east=180&north=90`,
      headers: { authorization: `Bearer ${token}` },
    };
    try {
      const exactLimit = await app.inject(request);
      expect(exactLimit.statusCode).toBe(200);
      const exactLimitBody = exactLimit.json<{ items: unknown[]; truncated: boolean; limit: number }>();
      expect(exactLimitBody).toMatchObject({ truncated: false, limit: 2000 });
      expect(exactLimitBody.items).toHaveLength(2000);

      await database.db.insert(observations).values({
        animalId: wolfId,
        clientId,
        location: { longitude: 37.6, latitude: 55.7 },
        observedAt,
      });
      const aboveLimit = await app.inject(request);
      expect(aboveLimit.statusCode).toBe(200);
      const aboveLimitBody = aboveLimit.json<{ items: unknown[]; truncated: boolean; limit: number }>();
      expect(aboveLimitBody).toMatchObject({ truncated: true, limit: 2000 });
      expect(aboveLimitBody.items).toHaveLength(2000);
    } finally {
      await app.close();
    }
  });

  it('applies all map periods and hides observations older than 30 days before cleanup', async () => {
    const { clientId, token } = await seedAuthenticatedClient();
    const wolfId = '423e53fb-01c1-521b-8b29-6cccf5268618';
    const now = Date.now();
    await database.db.insert(observations).values([
      {
        animalId: wolfId,
        clientId,
        location: { longitude: 37.6, latitude: 55.7 },
        observedAt: new Date(now - 30 * 60 * 1000),
      },
      {
        animalId: wolfId,
        clientId,
        location: { longitude: 37.6, latitude: 55.7 },
        observedAt: new Date(now - 2 * 60 * 60 * 1000),
      },
      {
        animalId: wolfId,
        clientId,
        location: { longitude: 37.6, latitude: 55.7 },
        observedAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
      },
      {
        animalId: wolfId,
        clientId,
        location: { longitude: 37.6, latitude: 55.7 },
        observedAt: new Date(now - 8 * 24 * 60 * 60 * 1000),
      },
      {
        animalId: wolfId,
        clientId,
        location: { longitude: 37.6, latitude: 55.7 },
        observedAt: new Date(now - 31 * 24 * 60 * 60 * 1000),
        createdAt: new Date(now - 31 * 24 * 60 * 60 * 1000),
      },
    ]);

    const app = buildApp({ animalService, clientService, observationService });
    try {
      for (const [period, expectedCount] of [
        ['1h', 1],
        ['24h', 2],
        ['7d', 3],
        ['30d', 4],
      ] as const) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/observations?animalIds=${wolfId}&period=${period}&west=-180&south=-90&east=180&north=90`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json<{ items: unknown[] }>().items).toHaveLength(expectedCount);
      }
    } finally {
      await app.close();
    }
  });

  it('stores WGS 84 points in longitude-latitude order and creates a GiST index', async () => {
    const references = await seedReferences();
    const [observation] = await database.db.insert(observations).values({
      animalId: references.animalId,
      clientId: references.authorId,
      location: { longitude: 37.6, latitude: 55.7 },
      observedAt: new Date(Date.now() - 1000),
    }).returning({ location: observations.location });

    expect(observation?.location).toEqual({ longitude: 37.6, latitude: 55.7 });
    const metadata = await database.pool.query<{
      type: string;
      srid: number;
      indexMethod: string;
    }>(`
      select format_type(attribute.atttypid, attribute.atttypmod) as type,
             postgis_typmod_srid(attribute.atttypmod) as srid,
             access_method.amname as "indexMethod"
      from pg_attribute attribute
      join pg_class table_class on table_class.oid = attribute.attrelid
      join pg_index index_entry on index_entry.indrelid = table_class.oid
      join pg_class index_class on index_class.oid = index_entry.indexrelid
      join pg_am access_method on access_method.oid = index_class.relam
      where table_class.relname = 'observations'
        and attribute.attname = 'location'
        and index_class.relname = 'observations_location_gist'
    `);
    expect(metadata.rows[0]).toEqual({ type: 'geometry(Point,4326)', srid: 4326, indexMethod: 'gist' });
  });

  it('enforces unique identifiers, hashes, coordinates, time range and foreign keys', async () => {
    const references = await seedReferences();

    await expect(database.db.insert(clients).values({ tokenHash: 'a'.repeat(64) }))
      .rejects.toMatchObject({ cause: { code: '23505' } });
    await expect(database.db.insert(clients).values({ tokenHash: 'not-a-sha256' }))
      .rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(database.db.insert(animals).values({
      slug: `test-${randomUUID()}`,
      nameRu: ' ',
      nameEn: 'Test',
    })).rejects.toMatchObject({ cause: { code: '23514' } });

    await expect(database.pool.query(`
      insert into observations (animal_id, client_id, location, observed_at)
      values ($1, $2, ST_SetSRID(ST_MakePoint(181, 55.7), 4326), now())
    `, [references.animalId, references.authorId])).rejects.toMatchObject({ code: '23514' });
    await expect(database.db.insert(observations).values({
      animalId: references.animalId,
      clientId: references.authorId,
      location: { longitude: 37.6, latitude: 55.7 },
      observedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
    })).rejects.toMatchObject({ cause: { code: '23514' } });

    const [observation] = await database.db.insert(observations).values({
      animalId: references.animalId,
      clientId: references.authorId,
      location: { longitude: 37.6, latitude: 55.7 },
      observedAt: new Date(Date.now() - 1000),
    }).returning({ id: observations.id });
    if (!observation) throw new Error('Failed to create test observation');
    await expect(database.db.delete(animals).where(eq(animals.id, references.animalId)))
      .rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('allows one vote per client and cascades votes while preserving idempotency history', async () => {
    const references = await seedReferences();
    const [observation] = await database.db.insert(observations).values({
      animalId: references.animalId,
      clientId: references.authorId,
      location: { longitude: 37.6, latitude: 55.7 },
      observedAt: new Date(Date.now() - 1000),
    }).returning({ id: observations.id });
    if (!observation) throw new Error('Failed to create test observation');

    await database.db.insert(votes).values({
      observationId: observation.id,
      clientId: references.voterId,
      value: 'confirm',
    });
    await expect(database.db.insert(votes).values({
      observationId: observation.id,
      clientId: references.voterId,
      value: 'reject',
    })).rejects.toMatchObject({ cause: { code: '23505' } });

    const createdAt = new Date();
    await database.db.insert(observationIdempotency).values({
      clientId: references.authorId,
      idempotencyKey: randomUUID(),
      requestHash: 'c'.repeat(64),
      observationId: observation.id,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 24 * 60 * 60 * 1000),
    });
    await database.db.delete(observations).where(eq(observations.id, observation.id));

    const remainingVotes = await database.db.select().from(votes);
    const remainingIdempotency = await database.db.select({
      observationId: observationIdempotency.observationId,
    }).from(observationIdempotency);
    expect(remainingVotes).toEqual([]);
    expect(remainingIdempotency).toEqual([{ observationId: null }]);
  });
});
