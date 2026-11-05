import { createEmailVerificationToken } from "better-auth/api";
import { verifyJWT } from "better-auth/crypto";

export interface BootstrapVerificationAdapter {
  enabled: boolean;
  unavailableReason?: string;
  sendVerificationEmail(input: { email: string; url: string }): Promise<void>;
}
export interface BootstrapVerificationIdentity {
  accountId: string; email: string; sessionId: string; sessionExpiresAt: number;
}
interface VerificationEnv { AGENT_AUDIT: D1Database; BETTER_AUTH_SECRET: string; BETTER_AUTH_URL?: string }
interface TokenPayload { email: string; shibaPurpose: string; shibaAccountId: string; shibaNonce: string; shibaOrigin: string; exp: number; iat: number; updateTo?: unknown }
interface TokenRow { token_hash: string; account_id: string; email: string; nonce: string; origin: string; expires_at: number; consumed_at: number | null }
const PURPOSE = "shiba.bootstrap-email.v1";
const STATUS_PATH = "/api/auth/bootstrap-verification";
const CONFIRM_PATH = `${STATUS_PATH}/confirm`;
const CLOCK = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
export const BOOTSTRAP_VERIFICATION_DDL = `CREATE TABLE IF NOT EXISTS shiba_auth_bootstrap_verifications (
  token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, email TEXT NOT NULL, nonce TEXT NOT NULL UNIQUE, origin TEXT NOT NULL,
  expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, consumed_at INTEGER)`;
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: {
  "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
} });
const failure = (status = 403) => response({ error: "Bootstrap email verification is unavailable or this link is expired, changed or already used." }, status);
async function hash(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function origin(env: VerificationEnv): string | null {
  try { const value = new URL(env.BETTER_AUTH_URL ?? ""); return value.protocol === "https:" && !value.username && !value.password && !value.search && !value.hash && value.pathname === "/" ? value.origin : null; }
  catch { return null; }
}
function provenance(accountId: string, email: string) {
  return { sql: `EXISTS(SELECT 1 FROM "user" u JOIN shiba_auth_account_policy p ON p.account_id=u.id
    WHERE u.id=? AND lower(trim(u.email))=? AND p.email=? AND p.kind='bootstrap'
    AND p.invitation_id IS NULL AND p.workspace_id IS NULL AND u.emailVerified=0)`, values: [accountId, email, email] };
}
function identityGuard(identity: BootstrapVerificationIdentity) {
  const current = provenance(identity.accountId, identity.email);
  return { sql: `${current.sql} AND EXISTS(SELECT 1 FROM "session" s WHERE s.id=? AND s.userId=? AND
    CASE WHEN typeof(s.expiresAt) IN ('integer','real') THEN s.expiresAt ELSE CAST((julianday(s.expiresAt)-2440587.5)*86400000 AS INTEGER) END > ${CLOCK})`,
    values: [...current.values, identity.sessionId, identity.accountId] };
}
function snapshot(identity: BootstrapVerificationIdentity): Promise<string> {
  return hash(JSON.stringify([PURPOSE, identity.accountId, identity.email, identity.sessionId, identity.sessionExpiresAt]));
}
async function readBody(request: Request, limit = 2048): Promise<unknown> {
  const reader = request.body?.getReader(); if (!reader) return null;
  let length = 0; const parts: Uint8Array[] = [];
  try { for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength; if (length > limit) throw new Error("limit"); parts.push(part.value); }
    const bytes = new Uint8Array(length); let at = 0; for (const part of parts) { bytes.set(part, at); at += part.length; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch { return null; } finally { await reader.cancel().catch(() => {}); }
}
function isBootstrapToken(token: string): boolean {
  try { const encoded = token.split(".")[1]; if (!encoded) return false;
    const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
    return JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))).shibaPurpose === PURPOSE;
  } catch { return false; }
}

/** Bootstrap-purpose links never enter Better Auth's email-only update path. */
export async function handleBootstrapVerification(
  request: Request, env: VerificationEnv, adapter: BootstrapVerificationAdapter | undefined,
  currentIdentity: () => Promise<(BootstrapVerificationIdentity & { emailVerified: boolean }) | null>,
): Promise<Response | null> {
  const url = new URL(request.url), canonical = origin(env);
  if (url.searchParams.getAll("token").some(token => token.length <= 4096 && isBootstrapToken(token))) {
    // Never let our UUID-bound proof enter the library's email-only updater,
    // including when an old address has been assigned to another account.
    return failure();
  }
  if (url.pathname === CONFIRM_PATH) {
    if (request.method !== "POST") return failure(405);
    if (!canonical || url.origin !== canonical || request.headers.get("origin") !== canonical ||
      request.headers.get("sec-fetch-site") === "cross-site" || request.headers.has("authorization") ||
      !/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? "")) return failure();
    const body = await readBody(request, 8192);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 ||
      !("token" in body) || typeof body.token !== "string" || body.token.length > 4096) return failure(400);
    const token = body.token;
    const payload = await verifyJWT<TokenPayload>(token, env.BETTER_AUTH_SECRET);
    if (!payload || payload.shibaPurpose !== PURPOSE || payload.shibaOrigin !== canonical || payload.updateTo !== undefined ||
      typeof payload.shibaAccountId !== "string" || !payload.shibaAccountId || typeof payload.shibaNonce !== "string" || !payload.shibaNonce ||
      typeof payload.email !== "string" || payload.email !== payload.email.trim().toLowerCase() ||
      !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.iat) || payload.exp - payload.iat !== 3600) return failure();
    const tokenHash = await hash(token), now = Date.now();
    const saved = await env.AGENT_AUDIT.prepare("SELECT * FROM shiba_auth_bootstrap_verifications WHERE token_hash=?").bind(tokenHash).first<TokenRow>();
    if (!saved || saved.account_id !== payload.shibaAccountId || saved.email !== payload.email || saved.nonce !== payload.shibaNonce || saved.origin !== canonical || saved.expires_at !== payload.exp * 1000 || saved.consumed_at !== null) return failure();
    const guard = provenance(saved.account_id, saved.email);
    const outcomes = await env.AGENT_AUDIT.batch([
      env.AGENT_AUDIT.prepare(`UPDATE shiba_auth_bootstrap_verifications SET consumed_at=? WHERE token_hash=? AND account_id=? AND email=? AND nonce=? AND consumed_at IS NULL AND expires_at>${CLOCK} AND ${guard.sql}`)
        .bind(now, tokenHash, saved.account_id, saved.email, saved.nonce, ...guard.values),
      env.AGENT_AUDIT.prepare(`UPDATE "user" SET emailVerified=1,updatedAt=? WHERE id=? AND lower(trim(email))=? AND changes()=1 AND ${guard.sql}
        AND EXISTS(SELECT 1 FROM shiba_auth_bootstrap_verifications WHERE token_hash=? AND consumed_at=? AND account_id=? AND email=?)`)
        .bind(now, saved.account_id, saved.email, ...guard.values, tokenHash, now, saved.account_id, saved.email),
      env.AGENT_AUDIT.prepare("UPDATE shiba_auth_bootstrap_verifications SET consumed_at=? WHERE account_id=? AND consumed_at IS NULL AND changes()=1").bind(now, saved.account_id),
    ]);
    if (outcomes[1]?.meta.changes !== 1) return failure(409);
    return response({ verified: true });
  }
  if (url.pathname !== STATUS_PATH) return null;
  if (!["GET", "POST"].includes(request.method)) return failure(405);
  if (request.headers.has("authorization")) return failure();
  const identity = await currentIdentity();
  if (!identity || identity.sessionExpiresAt <= Date.now()) return failure(401);
  const ready = Boolean(canonical && url.origin === canonical && adapter?.enabled);
  const expectedSnapshot = await snapshot(identity);
  if (request.method === "GET") return response({ kind: "bootstrap", email: identity.email, emailVerified: identity.emailVerified,
    available: ready, statusSnapshot: expectedSnapshot,
    ...(ready ? {} : { reason: adapter?.unavailableReason ?? "Configure a verified email sender, SEND_EMAIL, and the canonical HTTPS BETTER_AUTH_URL." }) });
  if (!ready || !canonical || request.headers.get("origin") !== canonical || request.headers.get("sec-fetch-site") === "cross-site" || !/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? "")) return failure();
  const body = await readBody(request);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !("expectedSnapshot" in body) || body.expectedSnapshot !== expectedSnapshot) return failure(409);
  if (identity.emailVerified) return response({ sent: false, emailVerified: true });
  const nonce = crypto.randomUUID();
  const token = await createEmailVerificationToken(env.BETTER_AUTH_SECRET, identity.email, undefined, 3600,
    { shibaPurpose: PURPOSE, shibaAccountId: identity.accountId, shibaNonce: nonce, shibaOrigin: canonical });
  const signed = await verifyJWT<TokenPayload>(token, env.BETTER_AUTH_SECRET);
  if (!signed || !Number.isSafeInteger(signed.exp)) return failure(503);
  const expiresAt = signed.exp * 1000;
  const tokenHash = await hash(token), now = Date.now(), guard = identityGuard(identity);
  const inserted = await env.AGENT_AUDIT.prepare(`INSERT INTO shiba_auth_bootstrap_verifications(token_hash,account_id,email,nonce,origin,expires_at,created_at,consumed_at)
    SELECT ?,?,?,?,?,?,?,NULL WHERE ${guard.sql}
    AND NOT EXISTS(SELECT 1 FROM shiba_auth_bootstrap_verifications WHERE account_id=? AND created_at>?)
    AND (SELECT COUNT(*) FROM shiba_auth_bootstrap_verifications WHERE account_id=? AND created_at>?)<5`)
    .bind(tokenHash, identity.accountId, identity.email, nonce, canonical, expiresAt, now, ...guard.values, identity.accountId, now - 60_000, identity.accountId, now - 3600_000).run();
  if (inserted.meta.changes !== 1) return response({ error: "Verification is unavailable or was requested recently. Reload the account status and wait one minute before resending." }, 429);
  const current = await currentIdentity();
  if (!current || current.emailVerified || await snapshot(current) !== expectedSnapshot || !await env.AGENT_AUDIT.prepare(`SELECT 1 AS current WHERE ${guard.sql}
    AND EXISTS(SELECT 1 FROM shiba_auth_bootstrap_verifications WHERE token_hash=? AND consumed_at IS NULL AND expires_at>${CLOCK})`).bind(...guard.values, tokenHash).first()) return failure(409);
  const verification = new URL("/app/?verify=bootstrap", canonical); verification.hash = new URLSearchParams({ bootstrapVerification: token }).toString();
  try { await adapter!.sendVerificationEmail({ email: identity.email, url: verification.href }); }
  catch { return response({ error: "Verification delivery could not be confirmed. Check your email before requesting a new link." }, 503); }
  return response({ sent: true });
}
