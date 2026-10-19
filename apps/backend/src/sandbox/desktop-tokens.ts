/**
 * Short-lived HMAC tokens for run desktop / terminal streams.
 * Never embed upstream exposePort URLs in the token — only run id + purpose.
 */
import type { Env } from "../env.js";

export type DesktopStreamPurpose = "view" | "control";

export interface DesktopStreamClaims {
  runId: string;
  userId: string;
  purpose: DesktopStreamPurpose;
  exp: number;
}

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const fromB64url = (value: string): Uint8Array => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

const hmacKey = async (secret: string, usage: "sign" | "verify") =>
  crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );

export function desktopStreamSecret(env: Env): string | null {
  const secret = env.DESKTOP_STREAM_SECRET?.trim() || env.PAIRING_SECRET?.trim() || env.LOCAL_ADAPTER_TOKEN?.trim();
  return secret || null;
}

export async function mintDesktopStreamToken(
  env: Env,
  claims: DesktopStreamClaims,
): Promise<string | null> {
  const secret = desktopStreamSecret(env);
  if (!secret) return null;
  const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), new TextEncoder().encode(payload));
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}

export async function verifyDesktopStreamToken(env: Env, token: string): Promise<DesktopStreamClaims | null> {
  const secret = desktopStreamSecret(env);
  if (!secret) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);
  try {
    const sigBytes = new Uint8Array(fromB64url(sigPart));
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret, "verify"),
      sigBytes,
      new TextEncoder().encode(payload),
    );
    if (!valid) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as DesktopStreamClaims;
    if (typeof claims.runId !== "string" || typeof claims.userId !== "string") return null;
    if (claims.purpose !== "view" && claims.purpose !== "control") return null;
    if (typeof claims.exp !== "number" || claims.exp < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

/** Default viewer token lifetime — long enough for a task, short enough to limit replay. */
export const DESKTOP_STREAM_TTL_MS = 15 * 60 * 1000;
