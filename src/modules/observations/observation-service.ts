import { createHash } from 'node:crypto';
import { ApiError } from '../../shared/http/api-error.js';
import type { ApiErrorDetail } from '../../shared/http/api-error.js';
import { createPublicConfig } from '../config/public-config.js';
import type { PublicConfig } from '../config/public-config.js';
import type {
  CreateObservationInput,
  ListObservationsInput,
  ObservationRepository,
} from './observation-repository.js';
import {
  countUnicodeCodePoints,
  LOCATION_LABEL_MAX_LENGTH,
  normalizeOptionalText,
} from './observation-text.js';

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

export function createObservationService(
  repository: ObservationRepository,
  publicConfig: PublicConfig = createPublicConfig(true),
) {
  return {
    async create(clientId: string, draft: ObservationDraft) {
      const normalizedDraft = {
        ...draft,
        locationLabel: normalizeOptionalText(draft.locationLabel),
        note: normalizeOptionalText(draft.note),
      };
      const textErrors: ApiErrorDetail[] = [];
      if (normalizedDraft.locationLabel
        && countUnicodeCodePoints(normalizedDraft.locationLabel) > LOCATION_LABEL_MAX_LENGTH) {
        textErrors.push({
          path: '/body/locationLabel',
          message: `Must contain at most ${LOCATION_LABEL_MAX_LENGTH} Unicode code points`,
        });
      }
      if (normalizedDraft.note
        && countUnicodeCodePoints(normalizedDraft.note) > publicConfig.noteMaxLength) {
        textErrors.push({
          path: '/body/note',
          message: `Must contain at most ${publicConfig.noteMaxLength} Unicode code points`,
        });
      }
      if (textErrors.length > 0) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', textErrors);
      }

      const result = await repository.create({
        ...normalizedDraft,
        clientId,
        descriptionsEnabled: publicConfig.descriptionsEnabled,
        requestHash: hashObservation(normalizedDraft),
      });
      if (result.status === 'animal-not-available') {
        throw new ApiError(422, 'ANIMAL_NOT_AVAILABLE', 'Animal is not available for new observations');
      }
      if (result.status === 'idempotency-conflict') {
        throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was already used for another request');
      }
      if (result.status === 'idempotency-result-gone') {
        throw new ApiError(409, 'IDEMPOTENCY_RESULT_GONE', 'The idempotent observation is no longer available');
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
      if (result.status === 'rate-limited') {
        throw new ApiError(
          429,
          'RATE_LIMITED',
          'Observation publication rate limit exceeded',
          undefined,
          {
            retryAfterSeconds: result.retryAfterSeconds,
            availableAt: result.availableAt,
          },
        );
      }
      return result.observation;
    },

    async getDetails(id: string, clientId: string) {
      const observation = await repository.findDetails(id, clientId);
      if (!observation) {
        throw new ApiError(404, 'OBSERVATION_NOT_FOUND', 'Observation not found');
      }
      return observation;
    },

    async vote(
      id: string,
      clientId: string,
      value: 'confirm' | 'reject' | null,
    ) {
      const observation = await repository.vote(id, clientId, value);
      if (!observation) {
        throw new ApiError(404, 'OBSERVATION_NOT_FOUND', 'Observation not found');
      }
      return observation;
    },

    async list(input: ListObservationsInput) {
      const result = await repository.list(input);
      if (result.status === 'animals-not-found') {
        throw new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', [{
          path: '/query/animalIds',
          message: 'One or more animals do not exist',
        }]);
      }
      return {
        observations: result.observations,
        truncated: result.hasMore,
        limit: input.limit,
      };
    },
  };
}
