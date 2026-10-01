import type { FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { ApiError } from './api-error.js';

function readErrorProperty(error: unknown, property: 'code' | 'statusCode') {
  if (typeof error !== 'object' || error === null) return undefined;
  if (property === 'code' && 'code' in error) return error.code;
  if (property === 'statusCode' && 'statusCode' in error) return error.statusCode;
  return undefined;
}

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
        requestId: request.id,
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
        requestId: request.id,
      });
    }

    const statusCode = readErrorProperty(error, 'statusCode');
    const errorCode = readErrorProperty(error, 'code');
    if (statusCode === 413 || errorCode === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.status(413).send({
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Request body exceeds the 16 KiB limit',
        },
        requestId: request.id,
      });
    }

    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send({
        error: {
          code: 'REQUEST_INVALID',
          message: 'Request is invalid',
        },
        requestId: request.id,
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
      requestId: request.id,
    });
  });

  app.setNotFoundHandler((request, reply) => reply.status(404).send({
    error: {
      code: 'NOT_FOUND',
      message: 'Route not found',
    },
    requestId: request.id,
  }));
}
