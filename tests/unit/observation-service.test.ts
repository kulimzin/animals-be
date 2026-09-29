import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/shared/http/api-error.js';
import type {
  CreateObservationInput,
  ListObservationsInput,
  MapObservationRecord,
  ObservationDetailsRecord,
  ObservationRepository,
} from '../../src/modules/observations/observation-repository.js';
import { createObservationService } from '../../src/modules/observations/observation-service.js';
import { createPublicConfig } from '../../src/modules/config/public-config.js';

const observation: ObservationDetailsRecord = {
  id: '6ee21c62-18a9-4e82-a487-adcf49ce747d',
  animalId: '423e53fb-01c1-521b-8b29-6cccf5268618',
  location: { longitude: 37.6176, latitude: 55.7558 },
  observedAt: new Date('2026-09-29T07:15:00.000Z'),
  locationLabel: null,
  note: null,
  confirmVotes: 2,
  rejectVotes: 1,
  userVote: 'confirm',
};

const draft = {
  idempotencyKey: 'b2e3bb2e-7c42-4441-8e4a-cb121a479f53',
  animalId: observation.animalId,
  location: observation.location,
  observedAt: new Date('2026-09-29T07:15:00.000Z'),
  locationLabel: null,
  note: null,
};

const mapObservation: MapObservationRecord = {
  id: observation.id,
  animalId: observation.animalId,
  location: observation.location,
  observedAt: observation.observedAt,
  confirmVotes: 2,
  rejectVotes: 1,
};

function createRepository(overrides: Partial<ObservationRepository> = {}): ObservationRepository {
  return {
    create: () => Promise.resolve({ status: 'created', observation }),
    findDetails: () => Promise.resolve(observation),
    list: () => Promise.resolve({ status: 'ok', observations: [], hasMore: false }),
    ...overrides,
  };
}

describe('observation service', () => {
  it('normalizes instants before hashing idempotent requests', async () => {
    const inputs: CreateObservationInput[] = [];
    const service = createObservationService(createRepository({
      create: (input) => {
        inputs.push(input);
        return Promise.resolve({ status: 'created', observation });
      },
    }));

    await service.create('client-id', draft);
    await service.create('client-id', {
      ...draft,
      observedAt: new Date('2026-09-29T10:15:00.000+03:00'),
    });

    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.requestHash).toBe(inputs[1]?.requestHash);
    expect(inputs[0]?.clientId).toBe('client-id');
    expect(inputs[0]?.descriptionsEnabled).toBe(true);
  });

  it.each([
    ['animal-not-available', 422, 'ANIMAL_NOT_AVAILABLE'],
    ['description-disabled', 422, 'DESCRIPTION_DISABLED'],
    ['idempotency-conflict', 409, 'IDEMPOTENCY_KEY_REUSED'],
    ['idempotency-result-gone', 409, 'IDEMPOTENCY_RESULT_GONE'],
    ['observed-at-invalid', 400, 'VALIDATION_ERROR'],
  ] as const)('maps %s to a stable API error', async (status, statusCode, code) => {
    const service = createObservationService(createRepository({
      create: () => Promise.resolve({ status }),
    }));

    await expect(service.create('client-id', draft)).rejects.toMatchObject<ApiError>({
      statusCode,
      code,
    });
  });

  it('returns details personalized for the authenticated client', async () => {
    const calls: Array<{ id: string; clientId: string }> = [];
    const service = createObservationService(createRepository({
      findDetails: (id, clientId) => {
        calls.push({ id, clientId });
        return Promise.resolve(observation);
      },
    }));

    await expect(service.getDetails(observation.id, 'client-id')).resolves.toBe(observation);
    expect(calls).toEqual([{ id: observation.id, clientId: 'client-id' }]);
  });

  it('uses the same not-found error for unavailable observation details', async () => {
    const service = createObservationService(createRepository({
      findDetails: () => Promise.resolve(null),
    }));

    await expect(service.getDetails(observation.id, 'client-id')).rejects.toMatchObject<ApiError>({
      statusCode: 404,
      code: 'OBSERVATION_NOT_FOUND',
    });
  });

  it('passes the disabled descriptions setting to the transactional repository', async () => {
    const inputs: CreateObservationInput[] = [];
    const service = createObservationService(createRepository({
      create: (input) => {
        inputs.push(input);
        return Promise.resolve({ status: 'description-disabled' });
      },
    }), createPublicConfig(false));

    await expect(service.create('client-id', { ...draft, note: 'Описание' }))
      .rejects.toMatchObject<ApiError>({ statusCode: 422, code: 'DESCRIPTION_DISABLED' });
    expect(inputs[0]?.descriptionsEnabled).toBe(false);
  });

  it('returns map observations and truncation metadata', async () => {
    const inputs: ListObservationsInput[] = [];
    const repository = createRepository({
      list: (input) => {
        inputs.push(input);
        return Promise.resolve({
          status: 'ok',
          observations: [mapObservation],
          hasMore: true,
        });
      },
    });
    const service = createObservationService(repository);
    const input: ListObservationsInput = {
      animalIds: [observation.animalId],
      period: '24h',
      west: 30,
      south: 50,
      east: 40,
      north: 60,
      limit: 2000,
    };

    await expect(service.list(input)).resolves.toEqual({
      observations: [mapObservation],
      truncated: true,
      limit: 2000,
    });
    expect(inputs).toEqual([input]);
  });

  it('rejects unknown animal filters as validation errors', async () => {
    const service = createObservationService(createRepository({
      list: () => Promise.resolve({ status: 'animals-not-found' }),
    }));

    await expect(service.list({
      animalIds: [observation.animalId],
      period: '24h',
      west: 30,
      south: 50,
      east: 40,
      north: 60,
      limit: 2000,
    })).rejects.toMatchObject<ApiError>({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      details: [{
        path: '/query/animalIds',
        message: 'One or more animals do not exist',
      }],
    });
  });
});
