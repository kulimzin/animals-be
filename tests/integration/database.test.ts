import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createDatabase } from '../../src/infrastructure/database.js';

it('connects through Drizzle to the isolated PostgreSQL/PostGIS database', async () => {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('TEST_DATABASE_URL is required; DATABASE_URL is never used');
  const url = new URL(connectionString);
  // This suite is deliberately restricted to the disposable Compose test service.
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || url.hostname !== '127.0.0.1' || url.port !== '5434'
    || url.pathname !== '/animals_test' || url.username !== 'animals_test'
    || url.search || url.hash) {
    throw new Error('Use the dedicated local animals_test database on port 5434');
  }
  const { pool, db } = createDatabase(connectionString);
  try {
    const result = await db.execute<{ database: string; postgis: string; point: string; srid: number }>(sql`
      select current_database() as database,
             postgis_version() as postgis,
             ST_AsText(ST_SetSRID(ST_MakePoint(37.6, 55.7), 4326)) as point,
             ST_SRID(ST_SetSRID(ST_MakePoint(37.6, 55.7), 4326)) as srid
    `);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.database).toBe('animals_test');
    expect(result.rows[0]?.postgis).toMatch(/^3\./);
    expect(result.rows[0]?.point).toBe('POINT(37.6 55.7)');
    expect(result.rows[0]?.srid).toBe(4326);
  } finally {
    await pool.end();
  }
});
