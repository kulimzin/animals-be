import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { readEnvironment } from '../../config/env.js';
import { createDatabase } from '../database.js';

export const migrationsFolder = resolve(import.meta.dirname, '../../../drizzle');

export async function applyMigrations(connectionString: string) {
  const { pool, db } = createDatabase(connectionString);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await pool.end();
  }
}

async function main() {
  const environment = readEnvironment(process.env);
  await applyMigrations(environment.DATABASE_URL);
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  main().catch(() => {
    console.error('Database migration failed; check database availability and migration files');
    process.exitCode = 1;
  });
}
