import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/infrastructure/database.js';
import { applyMigrations } from '../../src/infrastructure/database/migrate.js';
import {
  animals,
  clients,
  observationIdempotency,
  observations,
  votes,
} from '../../src/infrastructure/database/schema.js';

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

async function seedReferences() {
  const [animal] = await database.db.insert(animals).values({
    slug: `test-${randomUUID()}`,
    nameRu: 'Тестовое животное',
    nameEn: 'Test animal',
    icon: 'test-icon',
  }).returning({ id: animals.id });
  const [author, voter] = await database.db.insert(clients).values([
    { tokenHash: 'a'.repeat(64) },
    { tokenHash: 'b'.repeat(64) },
  ]).returning({ id: clients.id });
  if (!animal || !author || !voter) throw new Error('Failed to create test references');
  return { animalId: animal.id, authorId: author.id, voterId: voter.id };
}

describe('database migrations and constraints', () => {
  beforeAll(async () => {
    await database.pool.query('DROP SCHEMA public CASCADE');
    await database.pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await database.pool.query('CREATE SCHEMA public');
    await applyMigrations(connectionString);
    // Applying the command repeatedly must not replay an already recorded migration.
    await applyMigrations(connectionString);
  });

  beforeEach(async () => {
    await database.pool.query(`
      TRUNCATE TABLE
        observation_idempotency,
        publication_events,
        client_issuance_events,
        votes,
        observations,
        clients,
        animals
    `);
  });

  afterAll(async () => {
    await database.pool.end();
  });

  it('applies the initial migration to a clean PostGIS database without seed animals', async () => {
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
      migrationCount: 1,
      animalCount: 0,
    });
    expect(result.rows[0]?.postgis).toMatch(/^3\./);
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
      icon: 'icon',
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
