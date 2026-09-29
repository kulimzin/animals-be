import { and, desc, eq, inArray, lt, lte, or, sql } from 'drizzle-orm';
import type { Database } from '../../infrastructure/database.js';
import {
  animals,
  observationIdempotency,
  observations,
} from '../../infrastructure/database/schema.js';

const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
const OBSERVATION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type ObservationRecord = {
  id: string;
  animalId: string;
  animalNameRu: string;
  animalNameEn: string;
  location: { longitude: number; latitude: number };
  observedAt: Date;
  locationLabel: string | null;
  note: string | null;
};

export type CreateObservationInput = {
  clientId: string;
  descriptionsEnabled: boolean;
  idempotencyKey: string;
  requestHash: string;
  animalId: string;
  location: { longitude: number; latitude: number };
  observedAt: Date;
  locationLabel: string | null;
  note: string | null;
};

export type CreateObservationResult =
  | { status: 'created' | 'replayed'; observation: ObservationRecord }
  | { status: 'animal-not-available' }
  | { status: 'description-disabled' }
  | { status: 'idempotency-conflict' }
  | { status: 'observed-at-invalid' };

export type ObservationCursor = { observedAt: Date; id: string };

export type ListObservationsInput = {
  animalIds: string[];
  limit: number;
  cursor?: ObservationCursor;
};

export type ListObservationsResult = {
  observations: ObservationRecord[];
  hasMore: boolean;
};

export type ObservationRepository = {
  create(input: CreateObservationInput): Promise<CreateObservationResult>;
  list(input: ListObservationsInput): Promise<ListObservationsResult>;
};

const observationSelection = {
  id: observations.id,
  animalId: observations.animalId,
  animalNameRu: animals.nameRu,
  animalNameEn: animals.nameEn,
  location: observations.location,
  observedAt: observations.observedAt,
  locationLabel: observations.locationLabel,
  note: observations.note,
};

export function createPostgresObservationRepository(database: Database): ObservationRepository {
  return {
    create(input) {
      return database.transaction(async (transaction) => {
        // The per-client key lock makes both identical and conflicting concurrent retries deterministic.
        await transaction.execute(sql`
          select pg_advisory_xact_lock(hashtextextended(${`${input.clientId}:${input.idempotencyKey}`}, 0))
        `);

        const databaseTime = await transaction.execute<{ now: string }>(sql`select now() as now`);
        const now = new Date(databaseTime.rows[0]?.now ?? Number.NaN);
        if (Number.isNaN(now.getTime())) throw new Error('Database did not return its current time');

        await transaction.delete(observationIdempotency).where(and(
          eq(observationIdempotency.clientId, input.clientId),
          eq(observationIdempotency.idempotencyKey, input.idempotencyKey),
          lte(observationIdempotency.expiresAt, now),
        ));

        const [existing] = await transaction.select({
          requestHash: observationIdempotency.requestHash,
          observationId: observationIdempotency.observationId,
        }).from(observationIdempotency).where(and(
          eq(observationIdempotency.clientId, input.clientId),
          eq(observationIdempotency.idempotencyKey, input.idempotencyKey),
        )).limit(1);

        if (existing) {
          if (existing.requestHash !== input.requestHash) return { status: 'idempotency-conflict' };
          if (!existing.observationId) throw new Error('Idempotent observation no longer exists');

          const [observation] = await transaction.select(observationSelection)
            .from(observations)
            .innerJoin(animals, eq(animals.id, observations.animalId))
            .where(eq(observations.id, existing.observationId))
            .limit(1);
          if (!observation) throw new Error('Idempotent observation could not be loaded');
          return { status: 'replayed', observation };
        }

        if (!input.descriptionsEnabled && input.note !== null) {
          return { status: 'description-disabled' };
        }

        if (input.observedAt > now
          || input.observedAt <= new Date(now.getTime() - OBSERVATION_WINDOW_MS)) {
          return { status: 'observed-at-invalid' };
        }

        const [animal] = await transaction.select({ id: animals.id })
          .from(animals)
          .where(and(eq(animals.id, input.animalId), eq(animals.isActive, true)))
          .for('update')
          .limit(1);
        if (!animal) return { status: 'animal-not-available' };

        const [created] = await transaction.insert(observations).values({
          animalId: input.animalId,
          clientId: input.clientId,
          location: input.location,
          observedAt: input.observedAt,
          createdAt: now,
          locationLabel: input.locationLabel,
          note: input.note,
        }).returning({ id: observations.id });
        if (!created) throw new Error('Observation insert did not return an identifier');

        await transaction.insert(observationIdempotency).values({
          clientId: input.clientId,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          observationId: created.id,
          createdAt: now,
          expiresAt: new Date(now.getTime() + IDEMPOTENCY_WINDOW_MS),
        });

        const [observation] = await transaction.select(observationSelection)
          .from(observations)
          .innerJoin(animals, eq(animals.id, observations.animalId))
          .where(eq(observations.id, created.id))
          .limit(1);
        if (!observation) throw new Error('Created observation could not be loaded');
        return { status: 'created', observation };
      });
    },

    async list(input) {
      const filters = [];
      if (input.animalIds.length > 0) filters.push(inArray(observations.animalId, input.animalIds));
      if (input.cursor) {
        filters.push(or(
          lt(observations.observedAt, input.cursor.observedAt),
          and(
            eq(observations.observedAt, input.cursor.observedAt),
            lt(observations.id, input.cursor.id),
          ),
        ));
      }

      const rows = await database.select(observationSelection)
        .from(observations)
        .innerJoin(animals, eq(animals.id, observations.animalId))
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(desc(observations.observedAt), desc(observations.id))
        .limit(input.limit + 1);

      return {
        observations: rows.slice(0, input.limit),
        hasMore: rows.length > input.limit,
      };
    },
  };
}
