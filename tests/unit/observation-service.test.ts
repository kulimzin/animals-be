import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/shared/http/api-error.js';
import type {
  CreateObservationInput,
  ListObservationsInput,
  ObservationRecord,
  ObservationRepository,
} from '../../src/modules/observations/observation-repository.js';
import { createObservationService } from '../../src/modules/observations/observation-service.js';

const observation: ObservationRecord = {
  id: '6ee21c62-18a9-4e82-a487-adcf49ce747d',
  animalId: '423e53fb-01c1-521b-8b29-6cccf5268618',
  animalNameRu: 'Волк',
  animalNameEn: 'Wolf',
  location: { longitude: 37.6176, latitude: 55.7558 },
  observedAt: new Date('2026-09-29T07:15:00.000Z'),
  locationLabel: null,
  note: null,
};

const draft = {
  idempotencyKey: 'b2e3bb2e-7c42-4441-8e4a-cb121a479f53',
  animalId: observation.animalId,
  location: observation.location,
  observedAt: new Date('2026-09-29T07:15:00.000Z'),
  locationLabel: null,
  note: null,
};

function createRepository(overrides: Partial<ObservationRepository> = {}): ObservationRepository {
  return {
    create: () => Promise.resolve({ status: 'created', observation }),
    list: () => Promise.resolve({ observations: [], hasMore: false }),
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
  });

  it.each([
    ['animal-not-available', 422, 'ANIMAL_NOT_AVAILABLE'],
    ['idempotency-conflict', 409, 'IDEMPOTENCY_KEY_REUSED'],
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

  it('deduplicates filters and round-trips an opaque cursor', async () => {
    const inputs: ListObservationsInput[] = [];
    const repository = createRepository({
      list: (input) => {
        inputs.push(input);
        return Promise.resolve(inputs.length === 1
          ? { observations: [observation], hasMore: true }
          : { observations: [], hasMore: false });
      },
    });
    const service = createObservationService(repository);

    const first = await service.list([observation.animalId, observation.animalId], 100);
    expect(first.nextCursor).toEqual(expect.any(String));
    await service.list([], 100, first.nextCursor ?? undefined);

    expect(inputs[0]?.animalIds).toEqual([observation.animalId]);
    expect(inputs[1]?.cursor).toEqual({ observedAt: observation.observedAt, id: observation.id });
  });

  it('rejects malformed cursors as validation errors', async () => {
    const service = createObservationService(createRepository());

    await expect(service.list([], 100, 'not-a-cursor')).rejects.toMatchObject<ApiError>({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      details: [{ path: '/query/cursor', message: 'Invalid cursor' }],
    });
  });
});
