import { and, asc, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import type { Database } from '../../infrastructure/database.js';
import {
  animals,
  observationIdempotency,
  observations,
  publicationEvents,
  votes,
} from '../../infrastructure/database/schema.js';

const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
const OBSERVATION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const PUBLICATION_RATE_WINDOW_MS = 60 * 60 * 1000;
const PUBLICATION_EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;

function publicationPauseMs(recentPublicationCount: number) {
  if (recentPublicationCount === 0) return 0;
  if (recentPublicationCount === 1) return 30 * 1000;
  if (recentPublicationCount === 2) return 60 * 1000;
  if (recentPublicationCount <= 4) return 3 * 60 * 1000;
  return 10 * 60 * 1000;
}

export type ObservationDetailsRecord = {
  id: string;
  animalId: string;
  location: { longitude: number; latitude: number };
  observedAt: Date;
  locationLabel: string | null;
  note: string | null;
  confirmVotes: number;
  rejectVotes: number;
  userVote: 'confirm' | 'reject' | null;
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
  | { status: 'created' | 'replayed'; observation: ObservationDetailsRecord }
  | { status: 'animal-not-available' }
  | { status: 'description-disabled' }
  | { status: 'idempotency-conflict' }
  | { status: 'idempotency-result-gone' }
  | { status: 'observed-at-invalid' }
  | { status: 'rate-limited'; retryAfterSeconds: number; availableAt: Date };

export type ObservationPeriod = '1h' | '24h' | '7d' | '30d';

export type MapObservationRecord = {
  id: string;
  animalId: string;
  location: { longitude: number; latitude: number };
  observedAt: Date;
  confirmVotes: number;
  rejectVotes: number;
};

export type ListObservationsInput = {
  animalIds: string[];
  period: ObservationPeriod;
  west: number;
  south: number;
  east: number;
  north: number;
  limit: number;
};

export type ListObservationsResult =
  | { status: 'ok'; observations: MapObservationRecord[]; hasMore: boolean }
  | { status: 'animals-not-found' };

export type ObservationRepository = {
  create(input: CreateObservationInput): Promise<CreateObservationResult>;
  findDetails(id: string, clientId: string): Promise<ObservationDetailsRecord | null>;
  list(input: ListObservationsInput): Promise<ListObservationsResult>;
  vote(
    observationId: string,
    clientId: string,
    value: 'confirm' | 'reject' | null,
  ): Promise<ObservationDetailsRecord | null>;
};

const observationDetailsSelection = (clientId: string) => ({
  id: observations.id,
  animalId: observations.animalId,
  location: observations.location,
  observedAt: observations.observedAt,
  locationLabel: observations.locationLabel,
  note: observations.note,
  confirmVotes: sql<number>`(
    select count(*)::integer from ${votes}
    where ${votes.observationId} = ${observations.id} and ${votes.value} = 'confirm'
  )`,
  rejectVotes: sql<number>`(
    select count(*)::integer from ${votes}
    where ${votes.observationId} = ${observations.id} and ${votes.value} = 'reject'
  )`,
  userVote: sql<'confirm' | 'reject' | null>`(
    select ${votes.value} from ${votes}
    where ${votes.observationId} = ${observations.id} and ${votes.clientId} = ${clientId}
  )`,
});

function createMapLocationFilter(input: ListObservationsInput) {
  if (input.west === input.east || input.south === input.north) {
    if (input.west <= input.east) {
      return sql`
        ST_X(${observations.location}) BETWEEN ${input.west} AND ${input.east}
        AND ST_Y(${observations.location}) BETWEEN ${input.south} AND ${input.north}
      `;
    }
    return sql`
      (ST_X(${observations.location}) >= ${input.west}
        OR ST_X(${observations.location}) <= ${input.east})
      AND ST_Y(${observations.location}) BETWEEN ${input.south} AND ${input.north}
    `;
  }

  if (input.west <= input.east) {
    return sql`ST_Intersects(
      ${observations.location},
      ST_MakeEnvelope(${input.west}, ${input.south}, ${input.east}, ${input.north}, 4326)
    )`;
  }
  return sql`(
    ST_Intersects(
      ${observations.location},
      ST_MakeEnvelope(${input.west}, ${input.south}, 180, ${input.north}, 4326)
    )
    OR ST_Intersects(
      ${observations.location},
      ST_MakeEnvelope(-180, ${input.south}, ${input.east}, ${input.north}, 4326)
    )
  )`;
}

export function createPostgresObservationRepository(database: Database): ObservationRepository {
  return {
    create(input) {
      return database.transaction(async (transaction) => {
        // One lock per client protects both idempotency and the adaptive publication interval.
        await transaction.execute(sql`
          select pg_advisory_xact_lock(hashtextextended(${`observation-publication:${input.clientId}`}, 0))
        `);

        const databaseTime = await transaction.execute<{ now: string }>(
          sql`select clock_timestamp() as now`,
        );
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
          if (!existing.observationId) return { status: 'idempotency-result-gone' };

          const [observation] = await transaction.select(observationDetailsSelection(input.clientId))
            .from(observations)
            .where(and(
              eq(observations.id, existing.observationId),
              gt(
                observations.observedAt,
                new Date(now.getTime() - OBSERVATION_WINDOW_MS),
              ),
            ))
            .limit(1);
          if (!observation) return { status: 'idempotency-result-gone' };
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
          // Allow concurrent publications while preventing a status change racing this check.
          .for('share')
          .limit(1);
        if (!animal) return { status: 'animal-not-available' };

        await transaction.delete(publicationEvents).where(lte(
          publicationEvents.publishedAt,
          new Date(now.getTime() - PUBLICATION_EVENT_RETENTION_MS),
        ));

        const recentPublications = await transaction.select({
          publishedAt: publicationEvents.publishedAt,
        }).from(publicationEvents).where(and(
          eq(publicationEvents.clientId, input.clientId),
          gt(
            publicationEvents.publishedAt,
            new Date(now.getTime() - PUBLICATION_RATE_WINDOW_MS),
          ),
        )).orderBy(desc(publicationEvents.publishedAt)).limit(5);

        const latestPublication = recentPublications[0];
        const pauseMs = publicationPauseMs(recentPublications.length);
        if (latestPublication && pauseMs > 0) {
          const availableAt = new Date(latestPublication.publishedAt.getTime() + pauseMs);
          if (availableAt > now) {
            return {
              status: 'rate-limited',
              retryAfterSeconds: Math.ceil((availableAt.getTime() - now.getTime()) / 1000),
              availableAt,
            };
          }
        }

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
        await transaction.insert(publicationEvents).values({
          clientId: input.clientId,
          publishedAt: now,
        });

        const [observation] = await transaction.select(observationDetailsSelection(input.clientId))
          .from(observations)
          .where(eq(observations.id, created.id))
          .limit(1);
        if (!observation) throw new Error('Created observation could not be loaded');
        return { status: 'created', observation };
      });
    },

    async findDetails(id, clientId) {
      const [observation] = await database.select(observationDetailsSelection(clientId))
        .from(observations)
        .where(and(
          eq(observations.id, id),
          sql`${observations.observedAt} > now() - interval '30 days'`,
        ))
        .limit(1);
      return observation ?? null;
    },

    async list(input) {
      return database.transaction(async (transaction) => {
        const knownAnimals = await transaction.select({ id: animals.id })
          .from(animals)
          .where(inArray(animals.id, input.animalIds));
        if (knownAnimals.length !== input.animalIds.length) {
          return { status: 'animals-not-found' };
        }

        const periodSeconds = {
          '1h': 60 * 60,
          '24h': 24 * 60 * 60,
          '7d': 7 * 24 * 60 * 60,
          '30d': 30 * 24 * 60 * 60,
        }[input.period];
        const locationFilter = createMapLocationFilter(input);

        const rows = await transaction.select({
          id: observations.id,
          animalId: observations.animalId,
          location: observations.location,
          observedAt: observations.observedAt,
          confirmVotes: sql<number>`count(*) filter (where ${votes.value} = 'confirm')::integer`,
          rejectVotes: sql<number>`count(*) filter (where ${votes.value} = 'reject')::integer`,
        })
          .from(observations)
          .leftJoin(votes, eq(votes.observationId, observations.id))
          .where(and(
            inArray(observations.animalId, input.animalIds),
            sql`${observations.observedAt} > now() - make_interval(secs => ${periodSeconds})`,
            locationFilter,
          ))
          .groupBy(observations.id)
          .orderBy(desc(observations.observedAt), asc(observations.id))
          .limit(input.limit + 1);

        return {
          status: 'ok',
          observations: rows.slice(0, input.limit),
          hasMore: rows.length > input.limit,
        };
      });
    },

    vote(observationId, clientId, value) {
      return database.transaction(async (transaction) => {
        const [availableObservation] = await transaction.select({ id: observations.id })
          .from(observations)
          .where(and(
            eq(observations.id, observationId),
            sql`${observations.observedAt} > now() - interval '30 days'`,
          ))
          .for('update')
          .limit(1);
        if (!availableObservation) return null;

        if (value === null) {
          await transaction.delete(votes).where(and(
            eq(votes.observationId, observationId),
            eq(votes.clientId, clientId),
          ));
        } else {
          await transaction.insert(votes).values({
            observationId,
            clientId,
            value,
          }).onConflictDoUpdate({
            target: [votes.observationId, votes.clientId],
            set: { value, updatedAt: sql`now()` },
          });
        }

        const [observation] = await transaction.select(observationDetailsSelection(clientId))
          .from(observations)
          .where(eq(observations.id, observationId))
          .limit(1);
        if (!observation) throw new Error('Voted observation could not be loaded');
        return observation;
      });
    },
  };
}
