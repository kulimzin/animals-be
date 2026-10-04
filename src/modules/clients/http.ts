import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ApiError } from '../../shared/http/api-error.js';
import { errorResponseSchema } from '../../shared/http/schemas.js';
import type { ClientService } from './client-service.js';
import { parseBearerToken } from './client-service.js';

const clientTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/).describe('Anonymous client bearer token');
const createClientResponseSchema = z.object({ token: clientTokenSchema });

declare module 'fastify' {
  interface FastifyRequest {
    client: { id: string } | null;
  }
}

export function createClientAuthenticationHook(clientService: ClientService) {
  return async function authenticateClient(request: FastifyRequest, reply: FastifyReply) {
    const parsed = parseBearerToken(request.headers.authorization);
    if (parsed.status === 'required') {
      reply.header('WWW-Authenticate', 'Bearer');
      throw new ApiError(401, 'CLIENT_TOKEN_REQUIRED', 'Client token is required');
    }
    if (parsed.status === 'invalid') {
      reply.header('WWW-Authenticate', 'Bearer');
      throw new ApiError(401, 'CLIENT_TOKEN_INVALID', 'Client token is invalid');
    }

    const clientId = await clientService.authenticateToken(parsed.token);
    if (!clientId) {
      reply.header('WWW-Authenticate', 'Bearer');
      throw new ApiError(401, 'CLIENT_TOKEN_INVALID', 'Client token is invalid');
    }
    request.client = { id: clientId };
  };
}

export function registerClientRoutes(app: FastifyInstance, clientService: ClientService) {
  app.withTypeProvider<ZodTypeProvider>().post('/clients', {
    schema: {
      operationId: 'createClient',
      summary: 'Issue an anonymous client token',
      tags: ['clients'],
      response: {
        201: createClientResponseSchema,
        400: errorResponseSchema,
        413: errorResponseSchema,
        429: errorResponseSchema,
        500: errorResponseSchema,
        503: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const result = await clientService.issueClient(request.ip);
    if (result.status === 'rate-limited') {
      reply.header('Retry-After', result.retryAfterSeconds);
      throw new ApiError(
        429,
        'RATE_LIMITED',
        'Client token issuance rate limit exceeded',
      );
    }

    return reply.status(201).send({ token: result.token });
  });
}
