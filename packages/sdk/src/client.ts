import { HttpClient, type FetchLike } from "./http.js";
import { streamSse } from "./sse.js";
import type {
  CreateThreadInput,
  CreateThreadResponse,
  PublicStreamEvent,
  SendMessageInput,
  SendMessageResponse,
  Thread,
  ThreadGetResponse,
  ThreadListResponse,
} from "./types.js";

export interface ShibaOptions {
  /** Worker origin, e.g. `https://shiba.example.com` (no trailing `/api/v1`). */
  baseUrl: string;
  /** Org-scoped public API key (`shk_…`). */
  apiKey: string;
  /** Injectable fetch (Workers, Node 18+, Bun, Deno). */
  fetch?: FetchLike;
  maxRetries?: number;
}

function newRequestId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export class Shiba {
  readonly #http: HttpClient;

  constructor(options: ShibaOptions) {
    this.#http = new HttpClient({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      fetch: options.fetch,
      maxRetries: options.maxRetries,
    });
  }

  readonly threads = {
    create: async (input: CreateThreadInput): Promise<CreateThreadResponse> => {
      const requestId = input.requestId?.trim() || newRequestId();
      return this.#http.request<CreateThreadResponse>("/threads", {
        method: "POST",
        body: { ...input, requestId },
        idempotent: true,
      });
    },

    list: async (): Promise<Thread[]> => {
      const body = await this.#http.request<ThreadListResponse>("/threads");
      return body.threads ?? [];
    },

    get: async (threadId: string): Promise<Thread> => {
      const body = await this.#http.request<ThreadGetResponse>(
        `/threads/${encodeURIComponent(threadId)}`,
      );
      if (!body.thread) throw new Error("Thread missing from response.");
      return body.thread;
    },

    send: async (
      threadId: string,
      input: SendMessageInput,
    ): Promise<SendMessageResponse> => {
      const delivery = input.delivery ?? "interrupt";
      const idempotent = Boolean(input.clientKey?.trim());
      return this.#http.request<SendMessageResponse>(
        `/threads/${encodeURIComponent(threadId)}/message`,
        {
          method: "POST",
          body: { ...input, delivery },
          idempotent,
        },
      );
    },

    interrupt: async (threadId: string): Promise<{ thread: Thread }> => {
      return this.#http.request<{ thread: Thread }>(
        `/threads/${encodeURIComponent(threadId)}/interrupt`,
        { method: "POST", idempotent: false },
      );
    },

    stream: (
      threadId: string,
      options?: { signal?: AbortSignal; reconnect?: boolean },
    ): AsyncGenerator<PublicStreamEvent> => {
      const url = this.#http.url(`/threads/${encodeURIComponent(threadId)}/stream`);
      return streamSse<PublicStreamEvent>({
        url,
        fetch: this.#http.fetchImpl,
        headers: this.#http.authHeaders({ accept: "text/event-stream" }),
        signal: options?.signal,
        reconnect: options?.reconnect,
      });
    },
  };

  readonly orgAgents = {
    list: async (): Promise<{ agents: unknown[] }> =>
      this.#http.request("/org-agents"),

    create: async (body: Record<string, unknown>): Promise<unknown> =>
      this.#http.request("/org-agents", { method: "POST", body }),

    get: async (agentId: string): Promise<unknown> =>
      this.#http.request(`/org-agents/${encodeURIComponent(agentId)}`),

    update: async (agentId: string, body: Record<string, unknown>): Promise<unknown> =>
      this.#http.request(`/org-agents/${encodeURIComponent(agentId)}`, { method: "PATCH", body }),

    delete: async (agentId: string): Promise<unknown> =>
      this.#http.request(`/org-agents/${encodeURIComponent(agentId)}`, { method: "DELETE" }),
  };

  readonly pullRequests = {
    status: async (threadId: string): Promise<unknown> =>
      this.#http.request(`/threads/${encodeURIComponent(threadId)}/pr/status`),

    comments: async (threadId: string): Promise<unknown> =>
      this.#http.request(`/threads/${encodeURIComponent(threadId)}/pr/comments`),

    review: async (threadId: string): Promise<unknown> =>
      this.#http.request(`/threads/${encodeURIComponent(threadId)}/pr/review`),

    markReady: async (threadId: string, body: Record<string, unknown> = {}): Promise<unknown> =>
      this.#http.request(`/threads/${encodeURIComponent(threadId)}/pr/ready`, {
        method: "POST",
        body,
        idempotent: false,
      }),
  };
}
