import type {
  DataLifecycleCleanupResult,
  DataLifecycleRepository,
} from './data-lifecycle-repository.js';

export const DATA_LIFECYCLE_INTERVAL_MS = 24 * 60 * 60 * 1000;

type DataLifecycleSchedulerOptions = {
  intervalMs?: number;
  onSuccess?: (result: DataLifecycleCleanupResult) => void;
  onError: () => void;
};

export function createDataLifecycleScheduler(
  repository: DataLifecycleRepository,
  {
    intervalMs = DATA_LIFECYCLE_INTERVAL_MS,
    onSuccess,
    onError,
  }: DataLifecycleSchedulerOptions,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeRun: Promise<void> | undefined;
  let isStarted = false;
  let isStopped = false;

  const run = async () => {
    const startedAt = Date.now();
    try {
      const result = await repository.cleanup();
      onSuccess?.(result);
    } catch {
      onError();
    } finally {
      if (!isStopped) {
        const nextRunDelayMs = Math.max(0, intervalMs - (Date.now() - startedAt));
        timer = setTimeout(() => {
          activeRun = run();
        }, nextRunDelayMs);
      }
    }
  };

  return {
    async start() {
      if (isStarted) throw new Error('Data lifecycle scheduler is already started');
      isStarted = true;
      activeRun = run();
      await activeRun;
    },

    async stop() {
      isStopped = true;
      if (timer) clearTimeout(timer);
      await activeRun;
    },
  };
}
