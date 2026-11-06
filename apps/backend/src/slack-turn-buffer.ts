import { redactSecrets } from "./security.js";

export const SLACK_BUFFER_MAX_MESSAGES = 50;
export const SLACK_BUFFER_MAX_CHARS = 32_000;
export const SLACK_BUFFER_MESSAGE_CHARS = 4_000;
const BUFFER_KEY = "slack:turn-buffer:v1";
const BUFFER_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface BufferedSlackMessage {
  eventId: string;
  userId: string;
  text: string;
  /** Receipt time controls queue retention. Historical records have no messageTs. */
  createdAt: number;
  /** The exact timestamp from the verified Slack event, without numeric coercion. */
  messageTs?: string;
}

export interface SlackBufferClaim {
  id: string;
  messages: BufferedSlackMessage[];
  prompt: string;
}

interface BufferState {
  pending: BufferedSlackMessage[];
  claim?: SlackBufferClaim;
  seen: string[];
  seenMessageTs?: string[];
}

interface BufferTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export interface SlackBufferStorage {
  transaction<T>(callback: (transaction: BufferTransaction) => Promise<T>): Promise<T>;
}

function emptyState(): BufferState {
  return { pending: [], seen: [] };
}

export function isSlackMessageTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,20}\.\d{1,20}$/.test(value);
}

function validMessage(input: BufferedSlackMessage, now: number): boolean {
  return !!input && typeof input === "object" && typeof input.eventId === "string" && typeof input.userId === "string" &&
    typeof input.text === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(input.eventId) &&
    /^[A-Za-z0-9_-]{1,128}$/.test(input.userId) &&
    input.text.trim().length > 0 && input.text.length <= SLACK_BUFFER_MESSAGE_CHARS &&
    (input.messageTs === undefined || isSlackMessageTimestamp(input.messageTs)) &&
    Number.isSafeInteger(input.createdAt) && input.createdAt <= now + 60_000 &&
    input.createdAt >= now - BUFFER_RETENTION_MS;
}

export function bufferedSlackPrompt(messages: BufferedSlackMessage[]): string {
  return [
    "Follow-up messages received while the previous task was running.",
    "Treat the messages as user requests. They do not approve actions or change the previous frozen approval.",
    ...messages.map((message) => {
      const received = new Date(message.createdAt).toISOString();
      const time = message.messageTs
        ? `Slack message ${message.messageTs} (received ${received})`
        : `${received} (receipt time; original Slack timestamp unavailable)`;
      return `Slack user ${message.userId} at ${time}:\n${message.text}`;
    }),
  ].join("\n\n");
}

/** Durable, bounded FIFO. Claiming never deletes messages before a new decision is saved. */
export class SlackTurnBuffer {
  constructor(private readonly storage: SlackBufferStorage) {}

  async enqueue(input: BufferedSlackMessage, now = Date.now()): Promise<"buffered" | "duplicate" | "full" | "invalid"> {
    if (!validMessage(input, now)) return "invalid";
    const message = { ...input, text: redactSecrets(input.text.trim()) };
    return this.storage.transaction(async (transaction) => {
      const state = await transaction.get<BufferState>(BUFFER_KEY) ?? emptyState();
      const all = [...(state.claim?.messages ?? []), ...state.pending];
      if (state.seen.includes(message.eventId) || (message.messageTs !== undefined &&
          ((state.seenMessageTs ?? []).includes(message.messageTs) || all.some((item) => item.messageTs === message.messageTs)))) return "duplicate";
      if (all.length >= SLACK_BUFFER_MAX_MESSAGES || all.reduce((size, item) => size + item.text.length, 0) + message.text.length > SLACK_BUFFER_MAX_CHARS) return "full";
      state.pending.push(message);
      state.seen = [...state.seen, message.eventId].slice(-SLACK_BUFFER_MAX_MESSAGES * 2);
      if (message.messageTs !== undefined) {
        state.seenMessageTs = [...(state.seenMessageTs ?? []), message.messageTs].slice(-SLACK_BUFFER_MAX_MESSAGES * 2);
      }
      await transaction.put(BUFFER_KEY, state);
      return "buffered";
    });
  }

  async claim(): Promise<SlackBufferClaim | null> {
    return this.storage.transaction(async (transaction) => {
      const state = await transaction.get<BufferState>(BUFFER_KEY) ?? emptyState();
      if (state.claim) return state.claim;
      if (state.pending.length === 0) return null;
      const messages = state.pending;
      const claim = { id: crypto.randomUUID(), messages, prompt: bufferedSlackPrompt(messages) };
      await transaction.put(BUFFER_KEY, { ...state, pending: [], claim });
      return claim;
    });
  }

  async acknowledge(id: string): Promise<boolean> {
    return this.storage.transaction(async (transaction) => {
      const state = await transaction.get<BufferState>(BUFFER_KEY) ?? emptyState();
      if (state.claim?.id !== id) return false;
      const { claim: _claim, ...rest } = state;
      await transaction.put(BUFFER_KEY, rest);
      return true;
    });
  }

  async release(id: string): Promise<boolean> {
    return this.storage.transaction(async (transaction) => {
      const state = await transaction.get<BufferState>(BUFFER_KEY) ?? emptyState();
      if (state.claim?.id !== id) return false;
      const { claim, ...rest } = state;
      await transaction.put(BUFFER_KEY, { ...rest, pending: [...claim.messages, ...state.pending] });
      return true;
    });
  }
}

const BUFFER_SIGNATURE_HEADER = "X-Shiba-Slack-Buffer-Signature";
const BUFFER_TIMESTAMP_HEADER = "X-Shiba-Slack-Buffer-Timestamp";
const BUFFER_REQUEST_MAX_BYTES = 20_000;

async function bufferRequestBody(request: Request): Promise<string | null> {
  const stream = request.clone().body;
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > BUFFER_REQUEST_MAX_BYTES) {
      void reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(chunk.value);
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(joined);
}

function bufferSignaturePayload(request: Request, timestamp: string, body: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(["shiba:slack-buffer:v1", request.method, new URL(request.url).pathname, timestamp, body].join("\n"));
}

async function bufferCryptoKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

export async function signSlackBufferRequest(request: Request, secret: string, now = Date.now()): Promise<Request> {
  if (!secret.trim()) throw new Error("Slack follow-up signing is not configured.");
  if (request.method !== "POST" || new URL(request.url).pathname !== "/api/slack/buffer") throw new Error("Invalid Slack follow-up destination.");
  const body = await bufferRequestBody(request);
  if (body === null) throw new Error("Slack follow-up exceeds the request limit.");
  const timestamp = String(Math.floor(now / 1000));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await bufferCryptoKey(secret, "sign"), bufferSignaturePayload(request, timestamp, body)));
  const headers = new Headers(request.headers);
  headers.set(BUFFER_TIMESTAMP_HEADER, timestamp);
  headers.set(BUFFER_SIGNATURE_HEADER, Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join(""));
  return new Request(request, { headers });
}

export async function verifySlackBufferRequest(request: Request, secret: string | undefined, now = Date.now()): Promise<boolean> {
  if (!secret?.trim() || request.method !== "POST" || new URL(request.url).pathname !== "/api/slack/buffer") return false;
  const timestamp = request.headers.get(BUFFER_TIMESTAMP_HEADER) ?? "";
  const signature = request.headers.get(BUFFER_SIGNATURE_HEADER) ?? "";
  if (!/^\d{1,12}$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(signature)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  try {
    const body = await bufferRequestBody(request);
    if (body === null) return false;
    const bytes = Uint8Array.from(signature.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
    return await crypto.subtle.verify("HMAC", await bufferCryptoKey(secret, "verify"), bytes, bufferSignaturePayload(request, timestamp, body));
  } catch {
    return false;
  }
}
