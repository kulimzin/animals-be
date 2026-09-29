import Fastify, { LogController } from 'fastify';
import type { FastifyServerOptions } from 'fastify';

export function buildApp(logger: FastifyServerOptions['logger'] = false) {
  return Fastify({
    logger,
    bodyLimit: 16 * 1024,
    // Request URLs and other user-controlled values must not enter automatic logs.
    logController: new LogController({ disableRequestLogging: true }),
  });
}
