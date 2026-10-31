import type { FetchLike } from "./http.js";
import { ShibaApiError } from "./errors.js";

export interface SseEvent<T = unknown> {
  id?: string;
  event?: string;
  data: T;
  retry?: number;
}

export interface StreamOptions {
  url: string;
  headers: Record<string, string>;
  fetch: FetchLike;
  signal?: AbortSignal;
  reconnect?: boolean;
  maxReconnectAttempts?: number;
}

/** Pending frame bytes before the next event delimiter. */
const MAX_PENDING_FRAME_BYTES = 512_000;

function parseSseBlock(block: string): SseEvent<string> | null {
  const lines = block.split("\n");
  let id: string | undefined;
  let event: string | undefined;
  let retry: number | undefined;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^\s/, "");
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "retry") retry = Number(value);
    else if (field === "data") dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  const payload: SseEvent<string> = { data: dataLines.join("\n") };
  if (id !== undefined) payload.id = id;
  if (event !== undefined) payload.event = event;
  if (retry !== undefined && !Number.isNaN(retry)) payload.retry = retry;
  return payload;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Index of the next SSE event delimiter starting at `from`. */
function nextEventDelimiter(buffer: string, from: number): { index: number; length: number } {
  const lf = buffer.indexOf("\n\n", from);
  const crlf = buffer.indexOf("\r\n\r\n", from);
  const cr = buffer.indexOf("\r\r", from);
  let index = -1;
  let length = 2;
  for (const candidate of [
    { index: lf, length: 2 },
    { index: crlf, length: 4 },
    { index: cr, length: 2 },
  ]) {
    if (candidate.index >= 0 && (index < 0 || candidate.index < index)) {
      index = candidate.index;
      length = candidate.length;
    }
  }
  return { index, length };
}

export async function* streamSse<T = unknown>(options: StreamOptions): AsyncGenerator<T> {
  const reconnect = options.reconnect ?? true;
  const maxAttempts = options.maxReconnectAttempts ?? 8;
  let lastEventId: string | undefined;
  let attempts = 0;
  while (true) {
    if (options.signal?.aborted) return;
    const headers = { ...options.headers };
    if (lastEventId) headers["last-event-id"] = lastEventId;
    const response = await options.fetch(options.url, { headers, signal: options.signal });
    if (!response.ok) {
      const text = await response.text();
      let body: unknown = text;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        /* plain text */
      }
      throw new ShibaApiError(`SSE HTTP ${response.status}`, response.status, body);
    }
    if (!response.body) throw new ShibaApiError("SSE response has no body", 502, null);
    attempts = 0;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let scanFrom = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > MAX_PENDING_FRAME_BYTES) {
          throw new ShibaApiError("SSE frame exceeded size limit", 413, null);
        }
        let split = nextEventDelimiter(buffer, scanFrom);
        while (split.index !== -1) {
          const block = buffer.slice(0, split.index);
          buffer = buffer.slice(split.index + split.length);
          scanFrom = 0;
          const parsed = parseSseBlock(block);
          if (parsed) {
            if (parsed.id) lastEventId = parsed.id;
            let data: T;
            try {
              data = JSON.parse(parsed.data) as T;
            } catch {
              data = parsed.data as T;
            }
            yield data;
          }
          split = nextEventDelimiter(buffer, scanFrom);
        }
        scanFrom = Math.max(0, buffer.length - 3);
      }
    } finally {
      reader.releaseLock();
    }
    if (!reconnect || options.signal?.aborted) return;
    attempts += 1;
    if (attempts > maxAttempts) return;
    await sleep(Math.min(15_000, 500 * 2 ** (attempts - 1)));
  }
}
