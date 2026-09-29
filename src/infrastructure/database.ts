import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './database/schema.js';

export function createDatabase(connectionString: string) {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
  });
  return { pool, db: drizzle(pool, { schema }) };
}

export type Database = ReturnType<typeof createDatabase>['db'];
