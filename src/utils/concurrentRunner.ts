/**
 * Concurrent Task Runner with retry and progress tracking
 * Used for batch operations like "Generate All" and "Search all PDF" in tables
 *
 * NOTE: No per-task timeout is enforced. AI responses can take minutes depending
 * on model, context size, and provider load. Artificially killing requests wastes
 * tokens the user has already paid for. Tasks run until the provider responds or
 * the network layer itself errors out.
 */

export interface TaskStats {
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  retrying: number;
  inProgress: number;
}

export interface ConcurrentTaskConfig<T, R> {
  tasks: T[];
  executor: (task: T, index: number) => Promise<R>;
  concurrency?: number; // default 5
  maxRetries?: number; // default 3
  retryDelayMs?: number; // base delay for retry backoff, default 2000
  onProgress?: (stats: TaskStats) => void;
  onTaskStart?: (task: T, index: number) => void;
  onTaskComplete?: (task: T, result: R, index: number) => void;
  onTaskError?: (
    task: T,
    error: Error,
    index: number,
    willRetry: boolean,
  ) => void;
  onTaskSkip?: (task: T, reason: string, index: number) => void;
}

export interface TaskResult<T, R> {
  task: T;
  index: number;
  status: "success" | "failed" | "skipped";
  result?: R;
  error?: Error;
  attempts: number;
}

/**
 * Delay helper for retry backoff
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if error is retryable (network issues, rate limits, etc.)
 */
function isRetryableError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes("network") ||
    message.includes("fetch") ||
    message.includes("econnreset") ||
    message.includes("enotfound") ||
    message.includes("socket") ||
    message.includes("abort") ||
    message.includes("429") || // rate limit
    message.includes("503") || // service unavailable
    message.includes("502") // bad gateway
  );
}

/**
 * Run tasks concurrently with retry and progress tracking
 */
export async function runConcurrentTasks<T, R>(
  config: ConcurrentTaskConfig<T, R>,
): Promise<TaskResult<T, R>[]> {
  const {
    tasks,
    executor,
    concurrency = 5,
    maxRetries = 3,
    retryDelayMs = 2000,
    onProgress,
    onTaskStart,
    onTaskComplete,
    onTaskError,
  } = config;

  const results: TaskResult<T, R>[] = [];
  const stats: TaskStats = {
    total: tasks.length,
    completed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    retrying: 0,
    inProgress: 0,
  };

  const updateProgress = () => {
    onProgress?.({ ...stats });
  };

  // Create task queue with indices
  const taskQueue: { task: T; index: number }[] = tasks.map((task, index) => ({
    task,
    index,
  }));

  let queueIndex = 0;

  const processTask = async (
    task: T,
    index: number,
  ): Promise<TaskResult<T, R>> => {
    let attempts = 0;
    let lastError: Error | undefined;

    while (attempts < maxRetries) {
      attempts++;

      try {
        if (attempts === 1) {
          onTaskStart?.(task, index);
        }

        // Execute task — no artificial timeout, let it run to completion
        const result = await executor(task, index);

        // Success
        stats.succeeded++;
        if (attempts > 1) {
          stats.retrying--;
        }
        onTaskComplete?.(task, result, index);

        return {
          task,
          index,
          status: "success",
          result,
          attempts,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        const willRetry = attempts < maxRetries && isRetryableError(lastError);

        if (willRetry) {
          stats.retrying++;
          updateProgress();
          onTaskError?.(task, lastError, index, true);

          // Exponential backoff: base * 2^(attempt-1)
          const backoffDelay = retryDelayMs * Math.pow(2, attempts - 1);
          await delay(Math.min(backoffDelay, 30000)); // cap at 30s

          stats.retrying--;
        } else {
          onTaskError?.(task, lastError, index, false);
        }
      }
    }

    // All retries exhausted
    stats.failed++;
    return {
      task,
      index,
      status: "failed",
      error: lastError,
      attempts,
    };
  };

  // Worker function that pulls from queue
  const worker = async (): Promise<void> => {
    while (queueIndex < taskQueue.length) {
      const currentIndex = queueIndex++;
      if (currentIndex >= taskQueue.length) break;

      const { task, index } = taskQueue[currentIndex];
      stats.inProgress++;
      updateProgress();

      const result = await processTask(task, index);
      results.push(result);

      stats.inProgress--;
      stats.completed++;
      updateProgress();
    }
  };

  // Start workers up to concurrency limit
  const workers: Promise<void>[] = [];
  const workerCount = Math.min(concurrency, tasks.length);

  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }

  // Wait for all workers to complete
  await Promise.all(workers);

  // Sort results by original index
  results.sort((a, b) => a.index - b.index);

  return results;
}

/**
 * Convenience function to format stats for display
 */
export function formatTaskStats(stats: TaskStats): string {
  const parts: string[] = [`${stats.completed}/${stats.total}`];

  if (stats.inProgress > 0) {
    parts.push(`⏳${stats.inProgress}`);
  }
  if (stats.retrying > 0) {
    parts.push(`↻${stats.retrying}`);
  }
  if (stats.skipped > 0) {
    parts.push(`⏭${stats.skipped}`);
  }
  if (stats.failed > 0) {
    parts.push(`✗${stats.failed}`);
  }

  return parts.join(" ");
}

/**
 * Format final summary stats
 */
export function formatTaskSummary(stats: TaskStats): string {
  const parts: string[] = [];

  if (stats.succeeded > 0) {
    parts.push(`${stats.succeeded}✓`);
  }
  if (stats.failed > 0) {
    parts.push(`${stats.failed}✗`);
  }
  if (stats.skipped > 0) {
    parts.push(`${stats.skipped}⏭`);
  }

  return parts.join(" ") || "0 items";
}
