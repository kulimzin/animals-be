import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponseSchema } from '../../shared/http/schemas.js';
import type { PublicConfig } from './public-config.js';

const publicConfigSchema = z.object({
  descriptionsEnabled: z.boolean(),
  noteMaxLength: z.number().int().positive(),
  mapResultLimit: z.number().int().positive(),
});

export function registerConfigRoutes(app: FastifyInstance, publicConfig: PublicConfig) {
  app.withTypeProvider<ZodTypeProvider>().get('/config', {
    schema: {
      operationId: 'getConfig',
      summary: 'Get public application configuration',
      tags: ['config'],
      security: [{ bearerAuth: [] }],
      response: {
        200: publicConfigSchema,
        401: errorResponseSchema,
        500: errorResponseSchema,
        503: errorResponseSchema,
      },
    },
  }, () => publicConfig);
}
