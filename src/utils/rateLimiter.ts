import { AIModelConfig } from "../modules/chat/types";

interface RateLimitState {
  tokens: number;
  lastRefill: number;
  requestsInWindow: number[];
  activeRequests: number;
}

/**
 * Rate Limiter for managing API request limits
 * Supports TPM (Tokens Per Minute), RPM (Requests Per Minute), and Concurrency
 */
export class RateLimiter {
  private static instance: RateLimiter;
  private states: Map<string, RateLimitState> = new Map();
  private waitQueue: Map<string, Array<{ resolve: () => void; cost: number }>> =
    new Map();

  private constructor() {}

  public static getInstance(): RateLimiter {
    if (!RateLimiter.instance) {
      RateLimiter.instance = new RateLimiter();
    }
    return RateLimiter.instance;
  }

  private getState(modelId: string): RateLimitState {
    if (!this.states.has(modelId)) {
      this.states.set(modelId, {
        tokens: 0,
        lastRefill: Date.now(),
        requestsInWindow: [],
        activeRequests: 0,
      });
    }
    return this.states.get(modelId)!;
  }

  /**
   * Acquire permission to make a request
   * @param modelConfig The model configuration
   * @param estimatedTokens Estimated tokens for TPM check (default 0)
   */
  public async acquire(
    modelConfig: AIModelConfig,
    estimatedTokens: number = 0,
  ): Promise<void> {
    if (!modelConfig.rateLimit) {
      // Default safe concurrency if no limit set
      await this.waitForConcurrency(modelConfig.id, 5);
      return;
    }

    const { type, value } = modelConfig.rateLimit;

    const state = this.getState(modelConfig.id);

    switch (type) {
      case "concurrency":
        await this.waitForConcurrency(modelConfig.id, value);
        break;
      case "rpm":
        await this.waitForRPM(modelConfig.id, value);
        state.activeRequests++;
        break;
      case "tpm":
        await this.waitForTPM(modelConfig.id, value, estimatedTokens);
        state.activeRequests++;
        break;
    }
  }

  /**
   * Release resources after a request completes
   * @param modelId The model ID
   * @param actualTokens Actual tokens used (for TPM adjustment, not fully implemented yet for strict leaky bucket but good for tracking)
   */
  public release(modelId: string): void {
    const state = this.getState(modelId);
    state.activeRequests = Math.max(0, state.activeRequests - 1);
    this.processQueue(modelId);
  }

  private async waitForConcurrency(
    modelId: string,
    limit: number,
  ): Promise<void> {
    const state = this.getState(modelId);
    if (state.activeRequests < limit) {
      state.activeRequests++;
      return;
    }
    return new Promise<void>((resolve) => {
      const queue = this.waitQueue.get(modelId) || [];
      queue.push({ resolve, cost: 0 }); // Cost 0 for concurrency check
      this.waitQueue.set(modelId, queue);
    }).then(() => {
      state.activeRequests++;
    });
  }

  private async waitForRPM(modelId: string, limit: number): Promise<void> {
    const state = this.getState(modelId);
    const windowSize = 60000; // 1 minute
    const now = Date.now();

    // Remove old requests
    state.requestsInWindow = state.requestsInWindow.filter(
      (t) => t > now - windowSize,
    );

    if (state.requestsInWindow.length < limit) {
      state.requestsInWindow.push(now);
      return;
    }

    // Wait until the oldest request expires
    const oldest = state.requestsInWindow[0];
    const waitTime = oldest + windowSize - now;

    if (waitTime > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      // Recurse to re-check after wait
      return this.waitForRPM(modelId, limit);
    } else {
      state.requestsInWindow.push(Date.now());
    }
  }

  private async waitForTPM(
    modelId: string,
    limit: number,
    cost: number,
  ): Promise<void> {
    // Simplified TPM: just ensure we don't burst over limit in a minute
    // For a more robust implementation, we'd need a token bucket refilling constantly
    // This implementation mimics RPM but with costs
    // NOTE: TPM is hard to predict perfectly before request. We use estimated cost.

    const state = this.getState(modelId);
    const windowSize = 60000;
    const now = Date.now();

    // Refill bucket logic
    // ... simplistic approach: just check if we can active this now.
    // For now, let's treat it similar to RPM but summing value.
    // Actually, for strict TPM, leaky bucket is best.

    // Re-implementing as Leaky Bucket for TPM
    const elapsedTime = now - state.lastRefill;
    const refillAmount = (limit / 60000) * elapsedTime;
    state.tokens = Math.min(limit, state.tokens + refillAmount);
    state.lastRefill = now;

    if (state.tokens >= cost) {
      state.tokens -= cost;
      return;
    }

    // Calculate specific wait time
    const needed = cost - state.tokens;
    const refillRate = limit / 60000; // tokens per ms
    const waitTime = needed / refillRate;

    await new Promise((resolve) => setTimeout(resolve, waitTime));

    // Recalculate after wait
    const now2 = Date.now();
    const elapsed2 = now2 - state.lastRefill;
    state.tokens = Math.min(limit, state.tokens + elapsed2 * refillRate);
    state.lastRefill = now2;
    state.tokens -= cost;
  }

  private processQueue(modelId: string): void {
    const queue = this.waitQueue.get(modelId);
    if (!queue || queue.length === 0) return;

    // Check if we can release one from queue (mainly for concurrency)
    // Rate logic is handled inside the wait methods mostly, but for concurrency we need to explicitly trigger next
    // For RPM/TPM, the timeouts handle the triggering.
    // BUT, if we mix them, it gets complex.
    // Current implementation separates concerns:
    // - Concurrency waits in a queue.
    // - RPM/TPM waits in a timeout.

    // So here we only care about Concurrency queue processing?
    // Actually, if a specific model is Concurrency limited, we pop the queue.
    // If it was RPM limited, the promise resolved via timeout, not via this queue (unless we queued it?)
    // In my `waitForConcurrency`, I pushed to `waitQueue`.
    // In `waitForRPM/TPM`, I awaited a timeout.

    // So `release` only really signals Concurrency updates.

    const state = this.getState(modelId);
    // We can peek the next item. But we need to know the limit?
    // We don't have the limit config here in `release`.
    // Ideally `release` should just trigger the next resolver if resources are free.
    // BUT checkConfig is needed.
    // Let's assume queue is purely FIFO for concurrency for now.

    if (queue.length > 0) {
      const next = queue.shift();
      if (next) next.resolve();
    }
  }
}
