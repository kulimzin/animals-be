import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { createClientAuthenticationHook } from '../clients/http.js';
import type { ClientService } from '../clients/client-service.js';
import { errorResponseSchema, successResponseSchema } from '../../shared/http/schemas.js';
import type { ObservationRecord } from './observation-repository.js';
import type { ObservationService } from './observation-service.js';

const optionalText = (maximum: number) => z.string().max(maximum)
  .refine((value) => value.trim().length > 0, 'Must not be blank')
  .nullable()
  .optional();

const locationSchema = z.object({
  longitude: z.number().min(-180).max(180),
  latitude: z.number().min(-90).max(90),
}).strict();

const observationSchema = z.object({
  id: z.uuid(),
  animal: z.object({
    id: z.uuid(),
    name: z.object({
      ru: z.string(),
      en: z.string(),
    }),
  }),
  location: locationSchema,
  observedAt: z.iso.datetime(),
  locationLabel: z.string().nullable(),
  note: z.string().nullable(),
});

const createObservationBodySchema = z.object({
  animalId: z.uuid(),
  location: locationSchema,
  observedAt: z.iso.datetime({ offset: true }),
  locationLabel: optionalText(300),
  note: optionalText(200),
}).strict();

const createObservationHeadersSchema = z.object({
  'idempotency-key': z.uuid(),
});

const listObservationsQuerySchema = z.object({
  animalId: z.union([z.uuid(), z.array(z.uuid())]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().min(1).optional(),
}).strict();

const createObservationResponseSchema = successResponseSchema(observationSchema);
const listObservationsResponseSchema = successResponseSchema(z.array(observationSchema)).extend({
  meta: z.object({ nextCursor: z.string().nullable() }),
});

function toObservationDto(observation: ObservationRecord) {
  return {
    id: observation.id,
    animal: {
      id: observation.animalId,
      name: {
        ru: observation.animalNameRu,
        en: observation.animalNameEn,
      },
    },
    location: observation.location,
    observedAt: observation.observedAt.toISOString(),
    locationLabel: observation.locationLabel,
    note: observation.note,
  };
}

export function registerObservationRoutes(
  app: FastifyInstance,
  observationService: ObservationService,
  clientService: ClientService,
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
        201: createObservationResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        409: errorResponseSchema,
        422: errorResponseSchema,
      },
    },
    preHandler: createClientAuthenticationHook(clientService),
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
    return reply.status(201).send({ data: toObservationDto(observation) });
  });

  app.withTypeProvider<ZodTypeProvider>().get('/observations', {
    schema: {
      operationId: 'listObservations',
      summary: 'List observations',
      tags: ['observations'],
      querystring: listObservationsQuerySchema,
      response: {
        200: listObservationsResponseSchema,
        400: errorResponseSchema,
      },
    },
  }, async (request) => {
    const animalIds = request.query.animalId === undefined
      ? []
      : Array.isArray(request.query.animalId) ? request.query.animalId : [request.query.animalId];
    const result = await observationService.list(
      animalIds,
      request.query.limit,
      request.query.cursor,
    );
    return {
      data: result.observations.map(toObservationDto),
      meta: { nextCursor: result.nextCursor },
    };
  });
}
