import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponseSchema } from '../../shared/http/schemas.js';
import type { AnimalService } from './animal-service.js';

const animalSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.object({
    ru: z.string(),
    en: z.string(),
  }),
});

const listAnimalsResponseSchema = z.object({ items: z.array(animalSchema) });

export function registerAnimalRoutes(app: FastifyInstance, animalService: AnimalService) {
  app.withTypeProvider<ZodTypeProvider>().get('/animals', {
    schema: {
      operationId: 'listAnimals',
      summary: 'List animals available for new observations',
      tags: ['animals'],
      security: [{ bearerAuth: [] }],
      response: {
        200: listAnimalsResponseSchema,
        401: errorResponseSchema,
        500: errorResponseSchema,
        503: errorResponseSchema,
      },
    },
  }, async () => {
    const animals = await animalService.listAvailableAnimals();
    return {
      items: animals.map((animal) => ({
        id: animal.id,
        slug: animal.slug,
        name: {
          ru: animal.nameRu,
          en: animal.nameEn,
        },
      })),
    };
  });
}
