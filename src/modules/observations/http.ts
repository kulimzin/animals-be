import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponseSchema, successResponseSchema } from '../../shared/http/schemas.js';
import { MAP_RESULT_LIMIT, NOTE_MAX_LENGTH } from '../config/public-config.js';
import type { MapObservationRecord, ObservationDetailsRecord } from './observation-repository.js';
import type { ObservationService } from './observation-service.js';

const optionalText = (maximum: number) => z.string().max(maximum)
  .refine((value) => value.trim().length > 0, 'Must not be blank')
  .nullable()
  .optional();

const locationSchema = z.object({
  longitude: z.number().min(-180).max(180),
  latitude: z.number().min(-90).max(90),
}).strict();

const observationDetailsSchema = z.object({
  id: z.uuid(),
  animalId: z.uuid(),
  location: locationSchema.extend({
    label: z.string().nullable(),
  }),
  observedAt: z.iso.datetime(),
  note: z.string().nullable(),
  votes: z.object({
    confirm: z.number().int().nonnegative(),
    reject: z.number().int().nonnegative(),
  }),
  confirmationPercent: z.number().int().min(0).max(100).nullable(),
  userVote: z.enum(['confirm', 'reject']).nullable(),
});

const createObservationBodySchema = z.object({
  animalId: z.uuid(),
  location: locationSchema,
  observedAt: z.iso.datetime({ offset: true }),
  locationLabel: optionalText(300),
  note: optionalText(NOTE_MAX_LENGTH),
}).strict();

const createObservationHeadersSchema = z.object({
  'idempotency-key': z.uuid(),
});

const voteObservationBodySchema = z.object({
  value: z.enum(['confirm', 'reject']).nullable(),
}).strict();

const animalIdsSchema = z.string().min(1).transform((value, context) => {
  const animalIds = value.split(',').map((animalId) => animalId.trim());
  if (animalIds.length < 1 || animalIds.length > 5) {
    context.addIssue({ code: 'custom', message: 'Must contain between 1 and 5 animal ids' });
    return z.NEVER;
  }
  if (animalIds.some((animalId) => !z.uuid().safeParse(animalId).success)) {
    context.addIssue({ code: 'custom', message: 'Must contain valid UUIDs separated by commas' });
    return z.NEVER;
  }
  if (new Set(animalIds).size !== animalIds.length) {
    context.addIssue({ code: 'custom', message: 'Animal ids must be unique' });
    return z.NEVER;
  }
  return animalIds;
});

const coordinateQuerySchema = (minimum: number, maximum: number) => z.preprocess(
  (value) => typeof value === 'string' && value.trim().length > 0 ? Number(value) : value,
  z.number().finite().min(minimum).max(maximum),
);

const listObservationsQuerySchema = z.object({
  animalIds: animalIdsSchema,
  period: z.enum(['1h', '24h', '7d', '30d']),
  west: coordinateQuerySchema(-180, 180),
  south: coordinateQuerySchema(-90, 90),
  east: coordinateQuerySchema(-180, 180),
  north: coordinateQuerySchema(-90, 90),
}).strict().refine((query) => query.south <= query.north, {
  path: ['south'],
  message: 'South must not be greater than north',
});

const observationDetailsResponseSchema = successResponseSchema(observationDetailsSchema);
const mapObservationSchema = z.object({
  id: z.uuid(),
  animalId: z.uuid(),
  location: locationSchema,
  observedAt: z.iso.datetime(),
  votes: z.object({
    confirm: z.number().int().nonnegative(),
    reject: z.number().int().nonnegative(),
  }),
  confirmationPercent: z.number().int().min(0).max(100).nullable(),
});
const listObservationsResponseSchema = z.object({
  items: z.array(mapObservationSchema),
  truncated: z.boolean(),
  limit: z.literal(MAP_RESULT_LIMIT),
});

function calculateConfirmationPercent(confirmVotes: number, rejectVotes: number) {
  const totalVotes = confirmVotes + rejectVotes;
  return totalVotes === 0 ? null : Math.floor((confirmVotes * 100) / totalVotes + 0.5);
}

function toObservationDetailsDto(observation: ObservationDetailsRecord) {
  return {
    id: observation.id,
    animalId: observation.animalId,
    location: {
      ...observation.location,
      label: observation.locationLabel,
    },
    observedAt: observation.observedAt.toISOString(),
    note: observation.note,
    votes: {
      confirm: observation.confirmVotes,
      reject: observation.rejectVotes,
    },
    confirmationPercent: calculateConfirmationPercent(
      observation.confirmVotes,
      observation.rejectVotes,
    ),
    userVote: observation.userVote,
  };
}

function toMapObservationDto(observation: MapObservationRecord) {
  return {
    id: observation.id,
    animalId: observation.animalId,
    location: observation.location,
    observedAt: observation.observedAt.toISOString(),
    votes: {
      confirm: observation.confirmVotes,
      reject: observation.rejectVotes,
    },
    confirmationPercent: calculateConfirmationPercent(
      observation.confirmVotes,
      observation.rejectVotes,
    ),
  };
}

export function registerObservationRoutes(
  app: FastifyInstance,
  observationService: ObservationService,
) {
  app.withTypeProvider<ZodTypeProvider>().post('/observations', {
    schema: {
      operationId: 'createObservation',
      summary: 'Create an observation',
      tags: ['observations'],
      security: [{ bearerAuth: [] }],
      headers: createObservationHeadersSchema,
      body: createObservationBodySchema,
      response: {
        201: observationDetailsResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        409: errorResponseSchema,
        422: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    if (!request.client) throw new Error('Authenticated client is missing');
    const observation = await observationService.create(request.client.id, {
      idempotencyKey: request.headers['idempotency-key'],
      animalId: request.body.animalId,
      location: request.body.location,
      observedAt: new Date(request.body.observedAt),
      locationLabel: request.body.locationLabel ?? null,
      note: request.body.note ?? null,
    });
    return reply.header('Cache-Control', 'private, no-store')
      .status(201)
      .send({ data: toObservationDetailsDto(observation) });
  });

  app.withTypeProvider<ZodTypeProvider>().get('/observations/:id', {
    schema: {
      operationId: 'getObservation',
      summary: 'Get observation details',
      tags: ['observations'],
      security: [{ bearerAuth: [] }],
      params: z.object({ id: z.uuid() }),
      response: {
        200: observationDetailsResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        404: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    if (!request.client) throw new Error('Authenticated client is missing');
    const observation = await observationService.getDetails(request.params.id, request.client.id);
    return reply.header('Cache-Control', 'private, no-store')
      .send({ data: toObservationDetailsDto(observation) });
  });

  app.withTypeProvider<ZodTypeProvider>().put('/observations/:id/vote', {
    schema: {
      operationId: 'voteObservation',
      summary: 'Set or remove the current client vote for an observation',
      tags: ['observations'],
      security: [{ bearerAuth: [] }],
      params: z.object({ id: z.uuid() }),
      body: voteObservationBodySchema,
      response: {
        200: observationDetailsResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        404: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    if (!request.client) throw new Error('Authenticated client is missing');
    const observation = await observationService.vote(
      request.params.id,
      request.client.id,
      request.body.value,
    );
    return reply.header('Cache-Control', 'private, no-store')
      .send({ data: toObservationDetailsDto(observation) });
  });

  app.withTypeProvider<ZodTypeProvider>().get('/observations', {
    schema: {
      operationId: 'listObservations',
      summary: 'List observations',
      tags: ['observations'],
      security: [{ bearerAuth: [] }],
      querystring: listObservationsQuerySchema,
      response: {
        200: listObservationsResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
      },
    },
  }, async (request) => {
    const result = await observationService.list({
      ...request.query,
      limit: MAP_RESULT_LIMIT,
    });
    const response: z.infer<typeof listObservationsResponseSchema> = {
      items: result.observations.map(toMapObservationDto),
      truncated: result.truncated,
      limit: MAP_RESULT_LIMIT,
    };
    return response;
  });
}
