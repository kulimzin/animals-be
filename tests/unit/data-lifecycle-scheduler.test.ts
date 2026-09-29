import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DataLifecycleCleanupResult,
  DataLifecycleRepository,
} from '../../src/modules/data-lifecycle/data-lifecycle-repository.js';
import {
  createDataLifecycleScheduler,
  DATA_LIFECYCLE_INTERVAL_MS,
} from '../../src/modules/data-lifecycle/data-lifecycle-scheduler.js';

const emptyResult: DataLifecycleCleanupResult = {
  observations: 0,
  idempotencyRecords: 0,
  publicationEvents: 0,
  clientIssuanceEvents: 0,
};

afterEach(() => {
  vi.useRealTimers();
});

describe('data lifecycle scheduler', () => {
  it('runs immediately, repeats daily and stops future runs', async () => {
    vi.useFakeTimers();
    const cleanup = vi.fn(() => Promise.resolve(emptyResult));
    const onSuccess = vi.fn();
    const repository: DataLifecycleRepository = { cleanup };
    const scheduler = createDataLifecycleScheduler(repository, {
      onSuccess,
      onError: vi.fn(),
    });

    await scheduler.start();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith(emptyResult);

    await vi.advanceTimersByTimeAsync(DATA_LIFECYCLE_INTERVAL_MS);
    expect(cleanup).toHaveBeenCalledTimes(2);

    await scheduler.stop();
    await vi.advanceTimersByTimeAsync(DATA_LIFECYCLE_INTERVAL_MS * 2);
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it('continues scheduling after a failed cleanup', async () => {
    vi.useFakeTimers();
    const cleanup = vi.fn()
      .mockRejectedValueOnce(new Error('cleanup failed'))
      .mockResolvedValue(emptyResult);
    const onError = vi.fn();
    const scheduler = createDataLifecycleScheduler({ cleanup }, {
      onError,
    });

    await scheduler.start();
    expect(onError).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(DATA_LIFECYCLE_INTERVAL_MS);
    expect(cleanup).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it('waits for an active cleanup while stopping', async () => {
    vi.useFakeTimers();
    const cleanup = Promise.withResolvers<DataLifecycleCleanupResult>();
    const scheduler = createDataLifecycleScheduler({
      cleanup: () => cleanup.promise,
    }, {
      onError: vi.fn(),
    });

    const startPromise = scheduler.start();
    let hasStopped = false;
    const stopPromise = scheduler.stop().then(() => {
      hasStopped = true;
    });
    await Promise.resolve();
    expect(hasStopped).toBe(false);

    cleanup.resolve(emptyResult);
    await Promise.all([startPromise, stopPromise]);
    expect(hasStopped).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a duplicate start', async () => {
    vi.useFakeTimers();
    const scheduler = createDataLifecycleScheduler({
      cleanup: () => Promise.resolve(emptyResult),
    }, {
      onError: vi.fn(),
    });

    await scheduler.start();
    await expect(scheduler.start()).rejects.toThrow('already started');
    await scheduler.stop();
  });
});
