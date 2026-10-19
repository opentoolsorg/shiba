import { ShibaApiError } from "./errors.js";

export type FetchLike = typeof fetch;

export interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  idempotent?: boolean;
  signal?: AbortSignal;
}

export interface HttpClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: FetchLike;
  maxRetries?: number;
}

const DEFAULT_RETRIES = 3;
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function joinUrl(base: string, path: string): string {
  const normalized = base.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  if (suffix.startsWith("/api/v1")) return `${normalized}${suffix}`;
  return `${normalized}/api/v1${suffix}`;
}

export class HttpClient {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #fetch: FetchLike;
  readonly #maxRetries: number;

  constructor(options: HttpClientOptions) {
    this.#baseUrl = options.baseUrl;
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#maxRetries = options.maxRetries ?? DEFAULT_RETRIES;
  }

  get fetchImpl(): FetchLike {
    return this.#fetch;
  }

  authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.#apiKey}`, accept: "application/json", ...extra };
  }

  url(path: string): string {
    return joinUrl(this.#baseUrl, path);
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? "GET";
    const idempotent = options.idempotent ?? (method === "GET" || method === "HEAD");
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#apiKey}`,
      accept: "application/json",
      ...options.headers,
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    const url = this.url(path);
    let attempt = 0;
    while (true) {
      attempt += 1;
      const response = await this.#fetch(url, {
        method,
        headers,
        body,
        signal: options.signal,
      });
      const text = await response.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          parsed = text;
        }
      }
      if (response.ok) return parsed as T;
      if (idempotent && attempt <= this.#maxRetries && RETRYABLE.has(response.status)) {
        const backoff = Math.min(8_000, 250 * 2 ** (attempt - 1));
        await sleep(backoff);
        continue;
      }
      const message =
        parsed && typeof parsed === "object" && "error" in parsed && typeof (parsed as { error: unknown }).error === "string"
          ? (parsed as { error: string }).error
          : `HTTP ${response.status}`;
      throw new ShibaApiError(message, response.status, parsed);
    }
  }
}
