import type { FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { ApiError } from './api-error.js';

export function registerErrorHandlers(app: FastifyInstance) {
  app.setErrorHandler((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: error.validation.map((issue) => ({
            path: issue.instancePath || '/',
            message: issue.message ?? 'Invalid value',
          })),
        },
      });
    }

    if (error instanceof ApiError) {
      if (error.rateLimit) reply.header('Retry-After', error.rateLimit.retryAfterSeconds);
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
          ...(error.rateLimit ? {
            retryAfterSeconds: error.rateLimit.retryAfterSeconds,
            availableAt: error.rateLimit.availableAt.toISOString(),
          } : {}),
        },
      });
    }

    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
      ? error.statusCode
      : undefined;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send({
        error: {
          code: 'REQUEST_INVALID',
          message: 'Request is invalid',
        },
      });
    }

    request.log.error({ err: error }, 'Request failed');
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: isResponseSerializationError(error)
          ? 'Response serialization failed'
          : 'Internal server error',
      },
    });
  });

  app.setNotFoundHandler((_request, reply) => reply.status(404).send({
    error: {
      code: 'NOT_FOUND',
      message: 'Route not found',
    },
  }));
}
