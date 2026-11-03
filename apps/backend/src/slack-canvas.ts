import type { Env } from "./env.js";
import type { RunRoomIdentity } from "./run-room-events.js";

const SLACK_ID = /^[A-Za-z0-9_-]{1,128}$/;
const APPROVAL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_POLICIES = 64;
const MAX_VIEWERS = 16;
const MAX_POLICY_CHARS = 32_768;
const INTAKE_MAX_BYTES = 100_000;
const INTAKE_ORIGIN = "X-Shiba-Slack-Canvas-Origin";
const INTAKE_TIMESTAMP = "X-Shiba-Slack-Canvas-Timestamp";
const INTAKE_SIGNATURE = "X-Shiba-Slack-Canvas-Signature";

export interface SlackCanvasOwnerPolicy {
  teamId: string;
  channelId: string;
  ownerId: string;
  viewerIds?: string[];
}

export interface SlackCanvasOrigin {
  origin: string;
  teamId: string;
  channelId: string;
  orchestratorName: string;
}

export interface SlackCanvasBinding extends RunRoomIdentity, SlackCanvasOrigin {}

type CanvasEnv = Pick<Env, "SLACK_CANVAS_OWNERS" | "WORKER_HOSTNAME" | "INTERNAL_SIGNING_KEY">;

function accessEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email && email.length <= 320 && ![...email].some((character) => character.charCodeAt(0) < 33 || character.charCodeAt(0) === 127) &&
    /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : null;
}

/** One invalid or ambiguous entry disables the entire policy. */
export function parseSlackCanvasOwners(raw: string | undefined): SlackCanvasOwnerPolicy[] {
  if (!raw || raw.length > MAX_POLICY_CHARS) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length > MAX_POLICIES) return [];
    const policies: SlackCanvasOwnerPolicy[] = [];
    const seen = new Set<string>();
    for (const item of value) {
      if (typeof item !== "object" || item === null || Array.isArray(item) ||
        !["channelId,ownerId,teamId", "channelId,ownerId,teamId,viewerIds"].includes(Object.keys(item).sort().join(","))) return [];
      const { teamId, channelId, ownerId, viewerIds } = item as Record<string, unknown>;
      if (typeof teamId !== "string" || !SLACK_ID.test(teamId) ||
        typeof channelId !== "string" || !SLACK_ID.test(channelId) || typeof ownerId !== "string") return [];
      const normalizedOwner = accessEmail(ownerId);
      if (!normalizedOwner) return [];
      let normalizedViewers: string[] | undefined;
      if (Object.hasOwn(item, "viewerIds")) {
        if (!Array.isArray(viewerIds) || viewerIds.length > MAX_VIEWERS) return [];
        normalizedViewers = [];
        for (const viewer of viewerIds) {
          const email = accessEmail(viewer);
          if (!email || normalizedViewers.includes(email)) return [];
          normalizedViewers.push(email);
        }
      }
      const key = JSON.stringify([teamId, channelId]);
      if (seen.has(key)) return [];
      seen.add(key);
      policies.push({ teamId, channelId, ownerId: normalizedOwner, ...(normalizedViewers ? { viewerIds: normalizedViewers } : {}) });
    }
    return policies;
  } catch {
    return [];
  }
}

export function parseSlackCanvasOrigin(origin: string): SlackCanvasOrigin | null {
  const thread = /^slack:([A-Za-z0-9_-]{1,128}):([A-Za-z0-9_-]{1,128}):(\d{1,20}\.\d{1,20})$/.exec(origin);
  if (thread?.[1] && thread[2]) return { origin, teamId: thread[1], channelId: thread[2], orchestratorName: origin };
  const command = /^slack-command:([A-Za-z0-9_-]{1,128}):([A-Za-z0-9_-]{1,128})$/.exec(origin);
  return command?.[1] && command[2]
    ? { origin, teamId: command[1], channelId: command[2], orchestratorName: "default" }
    : null;
}

export function slackCanvasOwner(env: Pick<Env, "SLACK_CANVAS_OWNERS">, origin: string): SlackCanvasOwnerPolicy | null {
  const scope = parseSlackCanvasOrigin(origin);
  if (!scope) return null;
  return parseSlackCanvasOwners(env.SLACK_CANVAS_OWNERS)
    .find((policy) => policy.teamId === scope.teamId && policy.channelId === scope.channelId) ?? null;
}

export function buildSlackCanvasUrl(env: CanvasEnv, pointer: { threadKey: string; approvalId: string }): string | undefined {
  if (!APPROVAL_ID.test(pointer.approvalId) || !slackCanvasOwner(env, pointer.threadKey) || !env.WORKER_HOSTNAME || (env.INTERNAL_SIGNING_KEY?.length ?? 0) < 32) return undefined;
  try {
    const base = new URL(env.WORKER_HOSTNAME.includes("://") ? env.WORKER_HOSTNAME : `https://${env.WORKER_HOSTNAME}`);
    if (base.protocol !== "https:" || base.username || base.password || base.port || base.hash || (base.pathname !== "/" && base.pathname !== "")) return undefined;
    const url = new URL("/slack-canvas/", base);
    url.searchParams.set("origin", pointer.threadKey);
    url.searchParams.set("approval", pointer.approvalId);
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Derive a private per-run room from the configured owner and canonical origin. */
export async function resolveSlackCanvasBinding(
  env: Pick<Env, "SLACK_CANVAS_OWNERS">,
  origin: string,
  approvalId: string,
): Promise<SlackCanvasBinding | null> {
  const scope = parseSlackCanvasOrigin(origin);
  const policy = slackCanvasOwner(env, origin);
  if (!scope || !policy || !APPROVAL_ID.test(approvalId)) return null;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
    JSON.stringify(["shiba:slack-canvas-room:v1", policy.ownerId, scope.origin, approvalId]),
  ))).slice(0, 16);
  digest[6] = ((digest[6] ?? 0) & 15) | 80;
  digest[8] = ((digest[8] ?? 0) & 63) | 128;
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const sessionId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { ...scope, ownerId: policy.ownerId, sessionId, runId: `agent-tool:${approvalId}` };
}

async function intakeBody(request: Request): Promise<string | null> {
  const reader = request.clone().body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > INTAKE_MAX_BYTES) { void reader.cancel().catch(() => {}); return null; }
      chunks.push(chunk.value);
    }
    const joined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder("utf-8", { fatal: true }).decode(joined);
  } finally {
    reader.releaseLock();
  }
}

async function intakePayload(request: Request, origin: string, timestamp: string, body: string): Promise<Uint8Array<ArrayBuffer>> {
  const url = new URL(request.url);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
  const bodyHash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return new TextEncoder().encode(JSON.stringify([
    "shiba:slack-canvas-request:v1", request.method, `${url.pathname}${url.search}`,
    origin, parseSlackCanvasOrigin(origin)?.orchestratorName, timestamp, bodyHash,
  ]));
}

async function intakeKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

function allowedCanvasRequest(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return (request.method === "POST" && path === "/api/runs") ||
    (request.method === "GET" && path === "/internal/slack-canvas");
}

export async function signSlackCanvasRequest(request: Request, secret: string, origin: string, now = Date.now()): Promise<Request> {
  if (secret.length < 32 || !parseSlackCanvasOrigin(origin) || !allowedCanvasRequest(request)) throw new Error("Invalid Slack canvas request.");
  const body = await intakeBody(request);
  if (body === null) throw new Error("Slack canvas intake exceeds the request limit.");
  const timestamp = String(Math.floor(now / 1000));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await intakeKey(secret, "sign"), await intakePayload(request, origin, timestamp, body)));
  const headers = new Headers(request.headers);
  headers.set(INTAKE_ORIGIN, origin);
  headers.set(INTAKE_TIMESTAMP, timestamp);
  headers.set(INTAKE_SIGNATURE, Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join(""));
  return new Request(request, { headers });
}

/** A valid proof authenticates intake provenance. It never approves execution. */
export async function verifySlackCanvasRequest(request: Request, secret: string | undefined, intendedDO: string, now = Date.now()): Promise<string | null> {
  const origin = request.headers.get(INTAKE_ORIGIN) ?? "";
  const timestamp = request.headers.get(INTAKE_TIMESTAMP) ?? "";
  const signature = request.headers.get(INTAKE_SIGNATURE) ?? "";
  const scope = parseSlackCanvasOrigin(origin);
  if (!secret || secret.length < 32 || !scope || scope.orchestratorName !== intendedDO || !allowedCanvasRequest(request) ||
    !/^\d{1,12}$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(signature) || Math.abs(now / 1000 - Number(timestamp)) > 300) return null;
  try {
    const body = await intakeBody(request);
    if (body === null) return null;
    const bytes = Uint8Array.from(signature.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
    return await crypto.subtle.verify("HMAC", await intakeKey(secret, "verify"), bytes, await intakePayload(request, origin, timestamp, body)) ? origin : null;
  } catch {
    return null;
  }
}

export async function signSlackCanvasIntake(request: Request, secret: string, origin: string, now = Date.now()): Promise<Request> {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/api/runs") throw new Error("Invalid Slack canvas intake.");
  return signSlackCanvasRequest(request, secret, origin, now);
}

export async function verifySlackCanvasIntake(request: Request, secret: string | undefined, intendedDO: string, now = Date.now()): Promise<string | null> {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/api/runs") return null;
  return verifySlackCanvasRequest(request, secret, intendedDO, now);
}
