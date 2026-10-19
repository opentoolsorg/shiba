/**
 * Bounded backoff for GitHub and model HTTP calls. Aborts are never
 * retried. POST retries only when the server says the call did not land
 * (408, 429, 503) or the socket failed before a response.
 */

export interface FetchBackoffOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

const RETRY_POST_STATUSES = new Set([408, 429, 503]);
const RETRY_GET_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const error = new Error("Run cancelled.");
      error.name = "AbortError";
      reject(error);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function backoffDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.random() * Math.min(exponential, maxDelayMs);
}

export function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError") return true;
  return /timed out|timeout/i.test(error.message) && error.name !== "AbortError";
}

function cancelled(): Error {
  const error = new Error("Run cancelled.");
  error.name = "AbortError";
  return error;
}

function retryStatus(method: string, status: number): boolean {
  if (method === "GET" || method === "HEAD") return RETRY_GET_STATUSES.has(status);
  return RETRY_POST_STATUSES.has(status);
}

export async function fetchWithBackoff(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: FetchBackoffOptions = {},
): Promise<Response> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 200;
  const maxDelayMs = options.maxDelayMs ?? 2000;
  const fetchImpl = options.fetchImpl ?? ((resource: RequestInfo | URL, next?: RequestInit) => fetch(resource, next));
  const signal = options.signal ?? init?.signal ?? undefined;
  const method = (init?.method ?? "GET").toUpperCase();
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) throw cancelled();
    try {
      const response = await fetchImpl(input, { ...init, signal });
      if (!retryStatus(method, response.status) || attempt === attempts) return response;
      await sleep(backoffDelayMs(attempt, baseDelayMs, maxDelayMs), signal);
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw cancelled();
      lastError = error;
      if (attempt === attempts) {
        if (isTimeoutError(error)) throw new Error("request timed out (status 408)");
        throw error;
      }
      await sleep(backoffDelayMs(attempt, baseDelayMs, maxDelayMs), signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("request failed");
}
