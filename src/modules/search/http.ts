import { scopedFetch, createAbortError } from "./env";

interface RequestPolicy {
  minIntervalMs: number;
  retries?: number;
}

interface RequestState {
  lastStarted: number;
  queue: Promise<void>;
}

const states = new Map<string, RequestState>();

export type ProviderErrorKind =
  | "authentication"
  | "permission"
  | "quota"
  | "query"
  | "transient"
  | "network";

export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly kind: ProviderErrorKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderRequestError";
  }
}

export function redactScholarlyUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of ["apikey", "api_key", "access_token", "token", "key"]) {
      if (url.searchParams.has(key)) url.searchParams.set(key, "REDACTED");
    }
    return url.toString();
  } catch {
    return value.replace(
      /([?&](?:apikey|api_key|access_token|token|key)=)[^&]+/gi,
      "$1REDACTED",
    );
  }
}

function errorKind(status: number): ProviderErrorKind {
  if (status === 401) return "authentication";
  if (status === 403) return "permission";
  if (status === 429) return "quota";
  if (status === 400 || status === 404 || status === 422) return "query";
  return status >= 500 || status === 408 ? "transient" : "network";
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(createAbortError());
      },
      { once: true },
    );
  });
}

async function acquire(
  provider: string,
  policy: RequestPolicy,
  signal?: AbortSignal,
): Promise<void> {
  const state = states.get(provider) || {
    lastStarted: 0,
    queue: Promise.resolve(),
  };
  const previous = state.queue;
  let release!: () => void;
  state.queue = new Promise<void>((resolve) => {
    release = resolve;
  });
  states.set(provider, state);
  await previous;
  try {
    const wait = policy.minIntervalMs - (Date.now() - state.lastStarted);
    await delay(wait, signal);
    state.lastStarted = Date.now();
  } finally {
    release();
  }
}

function retryDelay(response: Response | undefined, attempt: number): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return Math.min(30000, 1000 * 2 ** attempt + Math.random() * 500);
}

export async function scholarlyFetch(
  provider: string,
  input: string,
  init: RequestInit,
  policy: RequestPolicy,
): Promise<Response> {
  const retries = policy.retries ?? 3;
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await acquire(provider, policy, init.signal || undefined);
    let response: Response | undefined;
    try {
      response = await scopedFetch(input, init);
      if (response.ok) return response;
      const retryable =
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500;
      if (!retryable || attempt === retries) {
        const body = (await response.text()).slice(0, 500);
        throw new ProviderRequestError(
          `${provider} request failed (${response.status}): ${body}`,
          errorKind(response.status),
          response.status,
        );
      }
    } catch (error) {
      if (init.signal?.aborted) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
      if (response && response.status < 500 && response.status !== 429) {
        throw lastError;
      }
      if (attempt === retries) throw lastError;
    }
    await delay(retryDelay(response, attempt), init.signal || undefined);
  }
  throw lastError || new Error(`${provider} request failed`);
}

export async function responseJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
