import type { SwarmLane } from "./swarm-desk.js";

export const SHARE_TTL_MIN_SECONDS = 60;
export const SHARE_TTL_MAX_SECONDS = 604800;

export interface ShareTokenClaims {
  runId: string;
  userId: string;
  sessionId?: string;
}

export interface ShareTokenPayload {
  exp: number;
  runId: string;
  sessionId: string | null;
  userId: string;
}

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const USER_ID_PATTERN = /^[A-Za-z0-9_.:@-]{1,128}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

function canonicalPayload(payload: ShareTokenPayload): string {
  return JSON.stringify({
    exp: payload.exp,
    runId: payload.runId,
    sessionId: payload.sessionId,
    userId: payload.userId,
  });
}

function validFields(value: unknown): value is ShareTokenPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.exp === "number" &&
    Number.isInteger(candidate.exp) &&
    typeof candidate.runId === "string" &&
    RUN_ID_PATTERN.test(candidate.runId) &&
    (candidate.sessionId === null ||
      (typeof candidate.sessionId === "string" && SESSION_ID_PATTERN.test(candidate.sessionId))) &&
    typeof candidate.userId === "string" &&
    USER_ID_PATTERN.test(candidate.userId)
  );
}

async function signCanonical(secret: string, canonical: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical)));
}

export async function signShareToken(
  secret: string,
  claims: ShareTokenClaims,
  ttlSeconds: number,
  nowSeconds: number,
): Promise<string> {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("Secret must be a non-empty string.");
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < SHARE_TTL_MIN_SECONDS || ttlSeconds > SHARE_TTL_MAX_SECONDS) {
    throw new Error("TTL is outside the allowed range.");
  }
  if (typeof claims.runId !== "string" || !RUN_ID_PATTERN.test(claims.runId)) {
    throw new Error("Invalid runId.");
  }
  if (typeof claims.userId !== "string" || !USER_ID_PATTERN.test(claims.userId)) {
    throw new Error("Invalid userId.");
  }
  if (
    claims.sessionId !== undefined &&
    (typeof claims.sessionId !== "string" || !SESSION_ID_PATTERN.test(claims.sessionId))
  ) {
    throw new Error("Invalid sessionId.");
  }

  const payload: ShareTokenPayload = {
    exp: nowSeconds + ttlSeconds,
    runId: claims.runId,
    sessionId: claims.sessionId ?? null,
    userId: claims.userId,
  };
  const canonical = canonicalPayload(payload);
  return `${encodeBase64Url(new TextEncoder().encode(canonical))}.${encodeBase64Url(await signCanonical(secret, canonical))}`;
}

export async function verifyShareToken(
  secret: string,
  token: string,
  nowSeconds: number,
): Promise<ShareTokenPayload | null> {
  if (typeof secret !== "string" || secret.length === 0 || typeof token !== "string") {
    return null;
  }
  const parts = token.split(".");
  const encodedPayload = parts[0];
  const encodedSignature = parts[1];
  if (parts.length !== 2 || encodedPayload === undefined || encodedSignature === undefined) {
    return null;
  }

  const payloadBytes = decodeBase64Url(encodedPayload);
  const signatureBytes = decodeBase64Url(encodedSignature);
  if (payloadBytes === null || signatureBytes === null) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes));
  } catch {
    return null;
  }
  if (!validFields(parsed)) {
    return null;
  }
  const payload: ShareTokenPayload = {
    exp: parsed.exp,
    runId: parsed.runId,
    sessionId: parsed.sessionId,
    userId: parsed.userId,
  };
  if (payload.exp <= nowSeconds || canonicalPayload(payload) !== new TextDecoder().decode(payloadBytes)) {
    return null;
  }

  const expected = await signCanonical(secret, canonicalPayload(payload));
  if (signatureBytes.length !== expected.length) {
    return null;
  }
  let difference = 0;
  for (let i = 0; i < expected.length; i += 1) {
    difference |= (expected[i] ?? 0) ^ (signatureBytes[i] ?? 0);
  }
  return difference === 0 ? payload : null;
}

export function redactShareView(run: Record<string, unknown>, lane: SwarmLane): Record<string, unknown> {
  const view: Record<string, unknown> = {
    runId: run.runId,
    task: run.task,
    status: run.status,
    lane,
    repoUrl: run.repoUrl,
    baseBranch: run.baseBranch,
  };
  if (run.pullUrl !== undefined) {
    view.pullUrl = run.pullUrl;
  }
  view.screenshotUrl = run.screenshotUrl;
  if (run.summary !== undefined) {
    view.summary = typeof run.summary === "string" ? run.summary.slice(0, 500) : run.summary;
  }
  view.updatedAt = run.updatedAt;
  return view;
}
