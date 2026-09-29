import { sql } from 'drizzle-orm';
import type { Database } from '../../infrastructure/database.js';
import {
  clientIssuanceEvents,
  observationIdempotency,
  observations,
  publicationEvents,
} from '../../infrastructure/database/schema.js';

const OBSERVATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PUBLICATION_EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;

export type DataLifecycleCleanupResult = {
  observations: number;
  idempotencyRecords: number;
  publicationEvents: number;
  clientIssuanceEvents: number;
};

export type DataLifecycleRepository = {
  cleanup(): Promise<DataLifecycleCleanupResult>;
};

function readDeletedCount(rows: Array<{ count: number }>) {
  const count = rows[0]?.count;
  if (typeof count !== 'number') throw new Error('Database did not return a deletion count');
  return count;
}

export function createPostgresDataLifecycleRepository(
  database: Database,
): DataLifecycleRepository {
  return {
    cleanup() {
      return database.transaction(async (transaction) => {
        const databaseTime = await transaction.execute<{ now: string }>(
          sql`select clock_timestamp() as now`,
        );
        const now = new Date(databaseTime.rows[0]?.now ?? Number.NaN);
        if (Number.isNaN(now.getTime())) throw new Error('Database did not return its current time');

        const observationCutoff = new Date(now.getTime() - OBSERVATION_RETENTION_MS);
        const publicationEventCutoff = new Date(
          now.getTime() - PUBLICATION_EVENT_RETENTION_MS,
        );
        const deletedObservations = await transaction.execute<{ count: number }>(sql`
          with deleted as (
            delete from ${observations}
            where ${observations.observedAt} <= ${observationCutoff}
            returning 1
          )
          select count(*)::integer as count from deleted
        `);
        const deletedIdempotency = await transaction.execute<{ count: number }>(sql`
          with deleted as (
            delete from ${observationIdempotency}
            where ${observationIdempotency.expiresAt} <= ${now}
            returning 1
          )
          select count(*)::integer as count from deleted
        `);
        const deletedPublicationEvents = await transaction.execute<{ count: number }>(sql`
          with deleted as (
            delete from ${publicationEvents}
            where ${publicationEvents.publishedAt} <= ${publicationEventCutoff}
            returning 1
          )
          select count(*)::integer as count from deleted
        `);
        const deletedClientIssuanceEvents = await transaction.execute<{ count: number }>(sql`
          with deleted as (
            delete from ${clientIssuanceEvents}
            where ${clientIssuanceEvents.expiresAt} <= ${now}
            returning 1
          )
          select count(*)::integer as count from deleted
        `);

        return {
          observations: readDeletedCount(deletedObservations.rows),
          idempotencyRecords: readDeletedCount(deletedIdempotency.rows),
          publicationEvents: readDeletedCount(deletedPublicationEvents.rows),
          clientIssuanceEvents: readDeletedCount(deletedClientIssuanceEvents.rows),
        };
      });
    },
  };
}
