import fastifySwagger from '@fastify/swagger';
import type { SwaggerTransformObject } from '@fastify/swagger';
import Fastify, { LogController } from 'fastify';
import type { FastifyServerOptions } from 'fastify';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { AnimalService } from './modules/animals/animal-service.js';
import { registerAnimalRoutes } from './modules/animals/http.js';
import type { ClientService } from './modules/clients/client-service.js';
import { registerClientRoutes } from './modules/clients/http.js';
import { registerErrorHandlers } from './shared/http/error-handler.js';

type BuildAppOptions = {
  animalService: AnimalService;
  clientService: ClientService;
  logger?: FastifyServerOptions['logger'];
  trustProxy?: string[] | undefined;
};

const openApiTransform: SwaggerTransformObject = (document) => {
  const openApi = jsonSchemaTransformObject(document);
  if (!('paths' in openApi)) return openApi;

  const responses = openApi.paths?.['/clients']?.post?.responses;
  const created = responses?.['201'];
  if (created && !('$ref' in created)) {
    created.headers = {
      ...created.headers,
      'Cache-Control': {
        description: 'Prevents storage of the issued bearer token',
        schema: { type: 'string', enum: ['no-store'] },
      },
    };
  }

  const rateLimited = responses?.['429'];
  if (rateLimited && !('$ref' in rateLimited)) {
    rateLimited.headers = {
      ...rateLimited.headers,
      'Cache-Control': {
        description: 'Prevents caching responses from the token issuance endpoint',
        schema: { type: 'string', enum: ['no-store'] },
      },
      'Retry-After': {
        description: 'Seconds until another token issuance attempt is allowed',
        schema: { type: 'integer', minimum: 1 },
      },
    };
  }
  return openApi;
};

export function buildApp({ animalService, clientService, logger = false, trustProxy }: BuildAppOptions) {
  const app = Fastify({
    logger,
    trustProxy: trustProxy ?? false,
    bodyLimit: 16 * 1024,
    // Request URLs and other user-controlled values must not enter automatic logs.
    logController: new LogController({ disableRequestLogging: true }),
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('client', null);
  registerErrorHandlers(app);

  void app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Где животное API',
        version: '0.1.0',
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
          },
        },
      },
      tags: [
        { name: 'animals', description: 'Animal directory' },
        { name: 'clients', description: 'Anonymous browser clients' },
      ],
    },
    transform: jsonSchemaTransform,
    transformObject: openApiTransform,
  });

  void app.register((routesApp, _options, done) => {
    registerAnimalRoutes(routesApp, animalService);
    registerClientRoutes(routesApp, clientService);
    routesApp.get('/openapi.json', {
      schema: { hide: true },
    }, async (_request, reply) => reply.send(routesApp.swagger()));
    done();
  });

  return app;
}
