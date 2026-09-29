import { sql } from 'drizzle-orm';
import { buildApp } from './app.js';
import { readEnvironment } from './config/env.js';
import { createDatabase } from './infrastructure/database.js';

async function main() {
  const environment = readEnvironment(process.env);
  const app = buildApp({
    level: environment.LOG_LEVEL,
    redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
  });
  const { pool, db } = createDatabase(environment.DATABASE_URL);

  pool.on('error', () => {
    app.log.error('Idle database connection failed');
  });
  app.addHook('onClose', async () => {
    await pool.end();
  });

  let isClosing = false;
  const shutdown = async () => {
    if (isClosing) return;
    isClosing = true;
    try {
      await app.close();
    } catch {
      app.log.error('Application shutdown failed');
      process.exitCode = 1;
    }
  };
  const onSignal = () => { void shutdown(); };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  app.addHook('onClose', (_instance, done) => {
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
    done();
  });

  try {
    await db.execute(sql`select postgis_version()`);
    if (!isClosing) {
      await app.listen({ host: environment.HOST, port: environment.PORT });
    }
  } catch {
    app.log.error('Application startup failed; check database availability, PostGIS and listen settings');
    process.exitCode = 1;
    await shutdown();
  }
}

main().catch(() => {
  // Never print raw startup errors: drivers may include the connection string.
  console.error('Application startup failed; check environment configuration');
  process.exitCode = 1;
});
