import { createHash } from 'node:crypto';
import { ApiError } from '../../shared/http/api-error.js';
import { createPublicConfig } from '../config/public-config.js';
import type { PublicConfig } from '../config/public-config.js';
import type {
  CreateObservationInput,
  ObservationCursor,
  ObservationRecord,
  ObservationRepository,
} from './observation-repository.js';

type ObservationDraft = Omit<
  CreateObservationInput,
  'clientId' | 'descriptionsEnabled' | 'requestHash'
>;

export type ObservationService = ReturnType<typeof createObservationService>;

function hashObservation(draft: ObservationDraft) {
  return createHash('sha256').update(JSON.stringify({
    animalId: draft.animalId,
    longitude: draft.location.longitude,
    latitude: draft.location.latitude,
    observedAt: draft.observedAt.toISOString(),
    locationLabel: draft.locationLabel,
    note: draft.note,
  })).digest('hex');
}

function encodeCursor(observation: ObservationRecord) {
  return Buffer.from(JSON.stringify({
    observedAt: observation.observedAt.toISOString(),
    id: observation.id,
  })).toString('base64url');
}

function decodeCursor(value: string): ObservationCursor {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof decoded !== 'object' || decoded === null
      || !('observedAt' in decoded) || typeof decoded.observedAt !== 'string'
      || !('id' in decoded) || typeof decoded.id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(decoded.id)) {
      throw new Error('Invalid cursor payload');
    }
    const observedAt = new Date(decoded.observedAt);
    if (Number.isNaN(observedAt.getTime()) || observedAt.toISOString() !== decoded.observedAt) {
      throw new Error('Invalid cursor timestamp');
    }
    return { observedAt, id: decoded.id };
  } catch {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', [{
      path: '/query/cursor',
      message: 'Invalid cursor',
    }]);
  }
}

export function createObservationService(
  repository: ObservationRepository,
  publicConfig: PublicConfig = createPublicConfig(true),
) {
  return {
    async create(clientId: string, draft: ObservationDraft) {
      const result = await repository.create({
        ...draft,
        clientId,
        descriptionsEnabled: publicConfig.descriptionsEnabled,
        requestHash: hashObservation(draft),
      });
      if (result.status === 'animal-not-available') {
        throw new ApiError(422, 'ANIMAL_NOT_AVAILABLE', 'Animal is not available for new observations');
      }
      if (result.status === 'idempotency-conflict') {
        throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was already used for another request');
      }
      if (result.status === 'description-disabled') {
        throw new ApiError(422, 'DESCRIPTION_DISABLED', 'Observation descriptions are disabled');
      }
      if (result.status === 'observed-at-invalid') {
        throw new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', [{
          path: '/body/observedAt',
          message: 'Observation time must be within the last 30 days and not in the future',
        }]);
      }
      return result.observation;
    },

    async list(animalIds: string[], limit: number, cursorValue?: string) {
      const cursor = cursorValue === undefined ? undefined : decodeCursor(cursorValue);
      const result = await repository.list({
        animalIds: [...new Set(animalIds)],
        limit,
        ...(cursor ? { cursor } : {}),
      });
      const last = result.observations.at(-1);
      return {
        observations: result.observations,
        nextCursor: result.hasMore && last ? encodeCursor(last) : null,
      };
    },
  };
}
