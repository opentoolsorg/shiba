/** Gmail's isolated read-only credential store. No generic auth accounts or mailbox DOs. */
import { requireScope, sha256Hex, verifyToken, type TokenRecord } from "./agent-tokens.js";
import { decideConnectionDispatch, type CapabilityAction, type ConnectionDispatchContext } from "./connection-policy.js";
import { orgIdForRecord } from "./agent-tokens.js";
import { DASHBOARD_ORG_ID } from "./org-request-auth.js";
import { audit } from "./audit.js";
import type { Env } from "./env.js";
import { wrapUntrusted } from "./mailbox-store.js";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_BASE = "/api/connections/gmail";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const STATE_TTL_MS = 10 * 60_000;
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PRINCIPAL = /^[a-z][a-z0-9_-]{0,63}$/;
const SHARED_PRINCIPALS = new Set(["default", "orchestrator-agent", "orchestrator", "system", "admin", "web", "slack", "telegram", "discord", "automation"]);
const BODY_BYTES = 20 * 1024;

export class GmailError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "GmailError";
  }
}

export interface GmailConnection {
  id: string;
  email: string;
  createdAt: number;
}
interface StoredConnection extends GmailConnection {
  owner: string;
  refreshCipher: string;
  generation: number;
}
export interface GmailGrant {
  principal: string;
  createdAt: number;
}

// Deliberately separate tables, sharing only the existing D1 binding.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS gmail_oauth_states (
    state_hash TEXT PRIMARY KEY, owner TEXT NOT NULL UNIQUE,
    verifier TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS gmail_states_expiry ON gmail_oauth_states(expires_at)`,
  `CREATE TABLE IF NOT EXISTS gmail_resource_candidates (
    owner TEXT NOT NULL, connection_id TEXT NOT NULL, message_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    sender TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '', date TEXT NOT NULL DEFAULT '',
    expires_at INTEGER NOT NULL, PRIMARY KEY(owner, connection_id, message_id)
  )`,
  `CREATE INDEX IF NOT EXISTS gmail_resource_candidates_expiry ON gmail_resource_candidates(expires_at)`,
  `CREATE TABLE IF NOT EXISTS gmail_connections (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL UNIQUE, email TEXT NOT NULL,
    refresh_cipher TEXT NOT NULL, created_at INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1))
  )`,
  `CREATE TABLE IF NOT EXISTS gmail_grants (
    principal TEXT NOT NULL, owner TEXT NOT NULL, connection_id TEXT NOT NULL,
    created_at INTEGER NOT NULL, token_created INTEGER NOT NULL, PRIMARY KEY (principal, token_created),
    FOREIGN KEY(connection_id) REFERENCES gmail_connections(id) ON DELETE CASCADE
  )`,
];
const initialized = new WeakSet<D1Database>();
export async function ensureGmailSchema(env: Env): Promise<void> {
  if (!env.AGENT_AUDIT) throw new GmailError("Gmail storage unavailable.", 503);
  if (initialized.has(env.AGENT_AUDIT)) return;
  await env.AGENT_AUDIT.batch(SCHEMA.map((sql) => env.AGENT_AUDIT.prepare(sql)));
  initialized.add(env.AGENT_AUDIT);
}

/** Fail closed on missing, malformed, or non-canonical operator configuration. */
export function gmailConfig(env: Env) {
  if (!env.GMAIL_CLIENT_ID?.trim() || !env.GMAIL_CLIENT_SECRET?.trim() ||
      !env.GMAIL_REDIRECT_URI || !/^[a-fA-F0-9]{64}$/.test(env.GMAIL_TOKEN_KEY ?? "")) {
    throw new GmailError("Gmail is not configured.", 503);
  }
  let redirect: URL;
  try { redirect = new URL(env.GMAIL_REDIRECT_URI); }
  catch { throw new GmailError("Gmail is not configured.", 503); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname);
  if ((redirect.protocol !== "https:" && !(loopback && redirect.protocol === "http:")) ||
      redirect.pathname !== `${GMAIL_BASE}/callback` || redirect.search || redirect.hash ||
      redirect.username || redirect.password) {
    throw new GmailError("Gmail is not configured.", 503);
  }
  return { clientId: env.GMAIL_CLIENT_ID, clientSecret: env.GMAIL_CLIENT_SECRET,
    redirectUri: env.GMAIL_REDIRECT_URI, tokenKey: env.GMAIL_TOKEN_KEY! };
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}
function random(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
async function tokenKey(hex: string): Promise<CryptoKey> {
  if (!/^[a-fA-F0-9]{64}$/.test(hex)) throw new GmailError("Gmail key unavailable.", 503);
  const key = Uint8Array.from(hex.match(/../g)!, (part) => Number.parseInt(part, 16));
  return crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]);
}
function aad(owner: string, connectionId: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(["gmail-refresh-v1", owner, connectionId]));
}
export async function encryptGmailToken(token: string, key: string, owner: string, connectionId: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(owner, connectionId), tagLength: 128 },
    await tokenKey(key), new TextEncoder().encode(token),
  );
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(cipher))}`;
}
export async function decryptGmailToken(cipher: string, key: string, owner: string, connectionId: string): Promise<string> {
  try {
    const [version, encodedIv, encodedCipher, extra] = cipher.split(".");
    if (version !== "v1" || !encodedIv || !encodedCipher || extra !== undefined) throw new Error();
    const iv = fromBase64url(encodedIv);
    if (iv.length !== 12) throw new Error();
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: aad(owner, connectionId), tagLength: 128 },
      await tokenKey(key), fromBase64url(encodedCipher),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    // Never propagate crypto/provider errors containing credential material.
    throw new GmailError("Gmail credentials unavailable; disconnect and reconnect.", 503);
  }
}

/** Bound JSON before parsing; never propagate provider response bodies or errors. */
async function googleJson(url: string, init: RequestInit, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok || !response.body) throw new Error();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > maxBytes) throw new Error();
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new GmailError("Gmail provider request failed.", 502); }
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 16_384 && !/[\s\p{Cc}]/u.test(value);
}
function validateTokenResponse(value: Record<string, unknown>, needsRefresh: boolean): void {
  if (typeof value.scope !== "string" || value.scope.trim() !== GMAIL_SCOPE ||
      value.token_type !== "Bearer" || !validToken(value.access_token) ||
      (needsRefresh && !validToken(value.refresh_token))) {
    throw new GmailError("Gmail requires exactly the read-only scope and offline access.", 400);
  }
}
async function exchange(env: Env, params: Record<string, string>, needsRefresh: boolean) {
  const config = gmailConfig(env);
  const result = await googleJson(TOKEN_URL, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...params }),
  });
  try { validateTokenResponse(result, needsRefresh); }
  catch (error) {
    // A rejected new grant still exists remotely; revoke it. Never on refresh:
    // revoking there would kill the stored grant the owner still sees as active.
    const credential = typeof result.refresh_token === "string" && result.refresh_token
      ? result.refresh_token : typeof result.access_token === "string" ? result.access_token : undefined;
    if (needsRefresh && credential) await revokeGoogleToken(credential);
    throw error;
  }
  return result;
}

/** Only these fixed Gmail read endpoints exist. Never take a host/path from input. */
async function gmailGet(accessToken: string, resource: "profile" | "messages", id?: string, query?: string, limit?: number) {
  if (id !== undefined && !MESSAGE_ID.test(id)) throw new GmailError("Invalid Gmail message ID.");
  const path = resource === "profile" ? "profile" : id ? `messages/${encodeURIComponent(id)}` : "messages";
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`);
  if (resource === "profile") url.searchParams.set("fields", "emailAddress");
  else if (id) {
    url.searchParams.set("format", "full");
    url.searchParams.set("fields", "id,threadId,snippet,payload(mimeType,headers,body(data),parts)");
  } else {
    url.searchParams.set("q", query ?? "");
    url.searchParams.set("maxResults", String(limit ?? 25));
    url.searchParams.set("fields", "messages(id,threadId)");
  }
  return googleJson(url.href, { method: "GET", headers: { authorization: `Bearer ${accessToken}` } }, 512 * 1024);
}

async function gmailMessageMetadata(accessToken: string, id: string) {
  if (!MESSAGE_ID.test(id)) throw new GmailError("Invalid Gmail message ID.");
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`);
  url.searchParams.set("format", "metadata");
  url.searchParams.append("metadataHeaders", "From");
  url.searchParams.append("metadataHeaders", "Subject");
  url.searchParams.append("metadataHeaders", "Date");
  url.searchParams.set("fields", "id,threadId,payload(headers)");
  return googleJson(url.href, { method: "GET", headers: { authorization: `Bearer ${accessToken}` } }, 64 * 1024);
}

export interface GmailResourceCandidate {
  messageId: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
}

async function activeOwnerConnection(env: Env, owner: string): Promise<StoredConnection> {
  await ensureGmailSchema(env);
  const connection = await env.AGENT_AUDIT.prepare(
    "SELECT id, owner, email, refresh_cipher AS refreshCipher, created_at AS createdAt FROM gmail_connections WHERE owner = ? AND active = 1",
  ).bind(owner).first<StoredConnection>();
  if (!connection) throw new GmailError("Connect Gmail before selecting read resources.", 409);
  return connection;
}

async function ownerAccessToken(env: Env, connection: StoredConnection): Promise<string> {
  const config = gmailConfig(env);
  const refreshToken = await decryptGmailToken(connection.refreshCipher, config.tokenKey, connection.owner, connection.id);
  const result = await exchange(env, { grant_type: "refresh_token", refresh_token: refreshToken }, false);
  if (typeof result.access_token !== "string") throw new GmailError("Gmail provider request failed.", 502);
  return result.access_token;
}

/** Owner-only, metadata-only discovery. Returned IDs originate from this user's connected Gmail account. */
export async function searchGmailResourceCandidates(
  env: Env,
  owner: string,
  query: string,
  limit = 25,
  now = Date.now(),
): Promise<GmailResourceCandidate[]> {
  if (typeof query !== "string" || query.trim().length < 1 || query.length > 256 || !Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new GmailError("Gmail resource search requires a query of at most 256 characters and 1–25 results.");
  }
  const connection = await activeOwnerConnection(env, owner);
  const token = await ownerAccessToken(env, connection);
  const result = await gmailGet(token, "messages", undefined, query, limit);
  const listed = Array.isArray(result.messages) ? result.messages.slice(0, limit) : [];
  const candidates: GmailResourceCandidate[] = [];
  for (const item of listed) {
    const listedMessage = item as Record<string, unknown>;
    if (typeof listedMessage.id !== "string" || !MESSAGE_ID.test(listedMessage.id) ||
        typeof listedMessage.threadId !== "string" || !MESSAGE_ID.test(listedMessage.threadId)) {
      throw new GmailError("Invalid Gmail message response.", 502);
    }
    const metadata = await gmailMessageMetadata(token, listedMessage.id);
    if (metadata.id !== listedMessage.id || metadata.threadId !== listedMessage.threadId) {
      throw new GmailError("Gmail resource changed during discovery. Search again.", 409);
    }
    const payload = metadata.payload as Record<string, unknown> | undefined;
    const headers = Array.isArray(payload?.headers) ? payload.headers : [];
    const readHeader = (name: string) => {
      const header = headers.find((candidate) => candidate && typeof candidate.name === "string" && candidate.name.toLowerCase() === name.toLowerCase());
      return typeof header?.value === "string" ? capText(header.value, 512) : "";
    };
    candidates.push({ messageId: listedMessage.id, threadId: listedMessage.threadId,
      from: readHeader("from"), subject: readHeader("subject"), date: readHeader("date") });
  }
  if (!(await isGmailConnectionActive(env, owner, connection.id))) throw new GmailError("Gmail connection changed during discovery.", 409);
  await env.AGENT_AUDIT.prepare("DELETE FROM gmail_resource_candidates WHERE owner = ? AND expires_at <= ?").bind(owner, now).run();
  const expiresAt = now + 10 * 60_000;
  for (const candidate of candidates) {
    await env.AGENT_AUDIT.prepare(`INSERT INTO gmail_resource_candidates
      (owner, connection_id, message_id, thread_id, sender, subject, date, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner, connection_id, message_id) DO UPDATE SET thread_id=excluded.thread_id,
        sender=excluded.sender, subject=excluded.subject, date=excluded.date, expires_at=excluded.expires_at`)
      .bind(owner, connection.id, candidate.messageId, candidate.threadId, candidate.from, candidate.subject, candidate.date, expiresAt).run();
  }
  return candidates;
}

/** Resolve selected IDs against fresh server-discovered resources for the current Gmail connection. */
export async function resolveGmailResourceCandidates(
  env: Env,
  owner: string,
  messageIds: readonly string[],
  now = Date.now(),
): Promise<Map<string, string>> {
  if (!Array.isArray(messageIds) || messageIds.length < 1 || messageIds.length > 100 ||
      messageIds.some((id) => typeof id !== "string" || !MESSAGE_ID.test(id))) {
    throw new GmailError("Select 1–100 messages from the connected Gmail resource list.", 400);
  }
  const connection = await activeOwnerConnection(env, owner);
  const selected = new Map<string, string>();
  for (const id of [...new Set(messageIds)]) {
    const row = await env.AGENT_AUDIT.prepare(`SELECT message_id FROM gmail_resource_candidates
      WHERE owner = ? AND connection_id = ? AND message_id = ? AND expires_at > ?`)
      .bind(owner, connection.id, id, now).first<{ message_id: string }>();
    if (!row) throw new GmailError("Gmail resource selection expired or is not in the connected account's discovery results.", 403);
    selected.set(id, connection.id);
  }
  return selected;
}

export async function isGmailConnectionActive(env: Env, owner: string, connectionId: string): Promise<boolean> {
  if (!env.AGENT_AUDIT || !owner || !connectionId) return false;
  const row = await env.AGENT_AUDIT.prepare("SELECT 1 FROM gmail_connections WHERE owner = ? AND id = ? AND active = 1")
    .bind(owner, connectionId).first();
  return row !== null;
}

/** Read only explicitly selected messages for an employee policy grant. */
export async function readGmailForEmployee(
  env: Env,
  owner: string,
  connectionId: string,
  actorId: string,
  messageIds: readonly string[],
  isGrantActive: (messageId: string) => Promise<boolean>,
): Promise<{ messages: Array<{ id: string; content: ReturnType<typeof wrapUntrusted> }> }> {
  if (!owner || !connectionId || !actorId || !Array.isArray(messageIds) || messageIds.length < 1 || messageIds.length > 25 ||
      messageIds.some((id) => typeof id !== "string" || !MESSAGE_ID.test(id)) || new Set(messageIds).size !== messageIds.length) {
    throw new GmailError("Provide 1–25 distinct selected Gmail message IDs.");
  }
  await ensureGmailSchema(env);
  const connection = await env.AGENT_AUDIT.prepare(`SELECT id, owner, email, refresh_cipher AS refreshCipher, created_at AS createdAt
    FROM gmail_connections WHERE owner = ? AND id = ? AND active = 1`).bind(owner, connectionId).first<StoredConnection>();
  if (!connection) throw new GmailError("Gmail connection is disconnected or revoked.", 403);
  const token = await ownerAccessToken(env, connection);
  const messages: Array<{ id: string; content: ReturnType<typeof wrapUntrusted> }> = [];
  for (const id of messageIds) {
    if (!(await isGrantActive(id)) || !(await isGmailConnectionActive(env, owner, connectionId))) {
      throw new GmailError("Selected Gmail resource grant was revoked.", 403);
    }
    const message = await gmailGet(token, "messages", id);
    if (message.id !== id) throw new GmailError("Invalid Gmail message response.", 502);
    if (!(await isGrantActive(id)) || !(await isGmailConnectionActive(env, owner, connectionId))) {
      throw new GmailError("Selected Gmail resource grant was revoked.", 403);
    }
    messages.push({ id, content: messageContent(message) });
  }
  await audit(env, { principal: actorId, tool: "gmail_read", argsHash: await gmailArgumentDigest({ messageIds }), outcome: "succeeded" });
  return { messages };
}

export async function beginGmailConnect(env: Env, owner: string, now = Date.now()) {
  const config = gmailConfig(env);
  await ensureGmailSchema(env);
  if (await env.AGENT_AUDIT.prepare("SELECT id FROM gmail_connections WHERE owner = ?").bind(owner).first()) {
    throw new GmailError("Disconnect the existing Gmail connection before reconnecting.", 409);
  }
  const state = random();
  const verifier = random();
  const expiresAt = now + STATE_TTL_MS;
  const inserted = await env.AGENT_AUDIT.batch([
    env.AGENT_AUDIT.prepare("DELETE FROM gmail_oauth_states WHERE expires_at <= ?").bind(now),
    env.AGENT_AUDIT.prepare("INSERT INTO gmail_oauth_states (state_hash, owner, verifier, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(owner) DO NOTHING")
      .bind(await sha256Hex(state), owner, verifier, expiresAt),
  ]);
  if (inserted[1]?.meta.changes !== 1) throw new GmailError("Gmail authorization already pending; disconnect to cancel or wait ten minutes.", 409);
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri,
    response_type: "code", scope: GMAIL_SCOPE, access_type: "offline", prompt: "consent",
    include_granted_scopes: "false", state, code_challenge: challenge, code_challenge_method: "S256" }).toString();
  return { authorizationUrl: url.href, expiresAt };
}

export async function finishGmailConnect(env: Env, owner: string, state: string, code: string, now = Date.now()): Promise<GmailConnection> {
  const config = gmailConfig(env);
  if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !code || code.length > 4096) throw new GmailError("Invalid Gmail callback.");
  await ensureGmailSchema(env);
  // Atomic consume, never read-then-delete. The consumed tombstone fences the
  // final commit: disconnect can delete it while Google HTTP is in flight.
  const stateHash = await sha256Hex(state);
  const consumed = await env.AGENT_AUDIT.prepare(
    "UPDATE gmail_oauth_states SET consumed = 1 WHERE state_hash = ? AND owner = ? AND expires_at > ? AND consumed = 0 RETURNING verifier",
  ).bind(stateHash, owner, now).first<{ verifier: string }>();
  if (!consumed) throw new GmailError("Gmail authorization expired or already used.");
  let tokens: Record<string, unknown> | undefined;
  try {
    tokens = await exchange(env, { grant_type: "authorization_code", code,
      redirect_uri: config.redirectUri, code_verifier: consumed.verifier }, true);
    // The callback reads only the account label, never inbox/messages.
    const profile = await gmailGet(tokens.access_token as string, "profile");
    if (typeof profile.emailAddress !== "string" || profile.emailAddress.length > 254 ||
        !/^[^\s@]+@[^\s@]+$/.test(profile.emailAddress)) throw new GmailError("Invalid Gmail profile.", 502);
    const connection = { id: random(16), email: profile.emailAddress, createdAt: now };
    const cipher = await encryptGmailToken(tokens.refresh_token as string, config.tokenKey, owner, connection.id);
    const result = await env.AGENT_AUDIT.batch([
      env.AGENT_AUDIT.prepare(
        `INSERT INTO gmail_connections (id, owner, email, refresh_cipher, created_at)
         SELECT ?, ?, ?, ?, ? WHERE EXISTS (
           SELECT 1 FROM gmail_oauth_states WHERE state_hash = ? AND owner = ? AND consumed = 1
         ) AND NOT EXISTS (SELECT 1 FROM gmail_connections WHERE owner = ?)`,
      ).bind(connection.id, owner, connection.email, cipher, now, stateHash, owner, owner),
      env.AGENT_AUDIT.prepare("DELETE FROM gmail_oauth_states WHERE state_hash = ? AND owner = ?").bind(stateHash, owner),
    ]);
    if (result[0]?.meta.changes !== 1) throw new GmailError("Gmail connection changed; disconnect before reconnecting.", 409);
    await auditOwner(env, owner, "gmail.connect", connection.id);
    return connection;
  } catch (error) {
    if (tokens) await revokeGoogleToken(tokens.refresh_token as string);
    await env.AGENT_AUDIT.prepare("DELETE FROM gmail_oauth_states WHERE state_hash = ? AND owner = ?").bind(stateHash, owner).run();
    throw error;
  }
}

/** Google returned `error=` (user denied): drop that pending flow so reconnect isn't blocked. */
export async function cancelGmailConnect(env: Env, owner: string, state: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) return;
  await ensureGmailSchema(env);
  await env.AGENT_AUDIT.prepare("DELETE FROM gmail_oauth_states WHERE state_hash = ? AND owner = ? AND consumed = 0")
    .bind(await sha256Hex(state), owner).run();
}

export async function gmailStatus(env: Env, owner: string) {
  let configured = true;
  try { gmailConfig(env); } catch { configured = false; }
  await ensureGmailSchema(env);
  const connection = await env.AGENT_AUDIT.prepare(
    "SELECT id, email, created_at AS createdAt FROM gmail_connections WHERE owner = ? AND active = 1",
  ).bind(owner).first<GmailConnection>();
  const grants = await env.AGENT_AUDIT.prepare(
    `SELECT g.principal, g.created_at AS createdAt FROM gmail_grants g
     JOIN gmail_connections c ON c.id = g.connection_id AND c.owner = g.owner AND c.active = 1
     WHERE c.owner = ? ORDER BY g.created_at`,
  ).bind(owner).all<GmailGrant>();
  // Lets the UI follow the real consent window instead of guessing it.
  const pending = await env.AGENT_AUDIT.prepare(
    "SELECT 1 FROM gmail_oauth_states WHERE owner = ? AND consumed = 0 AND expires_at > ?",
  ).bind(owner, Date.now()).first();
  return { configured, pending: pending !== null, connection, grants: grants.results };
}

export function validateGmailPrincipal(principal: string): void {
  if (!PRINCIPAL.test(principal) || SHARED_PRINCIPALS.has(principal)) {
    throw new GmailError("A dedicated external agent principal is required.");
  }
}
/**
 * The owner proves possession of the agent's bearer token; principal names are
 * enumerable, so naming one would let any signed-in owner claim another's agent.
 * Only the name + token mint time are kept, so a re-minted same-name token needs a new grant.
 */
export async function grantGmail(env: Env, owner: string, token: string, now = Date.now()): Promise<GmailGrant> {
  gmailConfig(env);
  const record = typeof token === "string" ? await verifyToken(env, token.trim()) : null;
  if (!record || !record.scopes.includes("gmail:read")) throw new GmailError("Provide an active agent token with the gmail:read scope.");
  validateGmailPrincipal(record.principal);
  await ensureGmailSchema(env);
  // A principal has exactly one mailbox, selected by this grant, never by tool args.
  // ponytail: token identity is (principal, created ms); store the token hash if same-ms mints ever matter.
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO gmail_grants (principal, owner, connection_id, created_at, token_created)
     SELECT ?, owner, id, ?, ? FROM gmail_connections WHERE owner = ? AND active = 1
     ON CONFLICT(principal, token_created) DO NOTHING`,
  ).bind(record.principal, now, record.created, owner).run();
  const grant = await env.AGENT_AUDIT.prepare(
    `SELECT g.principal, g.created_at AS createdAt FROM gmail_grants g
     JOIN gmail_connections c ON c.id = g.connection_id AND c.owner = g.owner AND c.active = 1
     WHERE g.principal = ? AND c.owner = ? AND g.token_created = ?`,
  ).bind(record.principal, owner, record.created).first<GmailGrant>();
  if (!grant) throw new GmailError("No connection or principal already granted elsewhere.", 409);
  await auditOwner(env, owner, "gmail.grant", record.principal);
  return grant;
}
export async function revokeGmailGrant(env: Env, owner: string, principal: string): Promise<void> {
  validateGmailPrincipal(principal);
  await ensureGmailSchema(env);
  await env.AGENT_AUDIT.prepare("DELETE FROM gmail_grants WHERE principal = ? AND owner = ?").bind(principal, owner).run();
  await auditOwner(env, owner, "gmail.revoke_grant", principal);
}

// Owner-side lifecycle trail (hashed subject only); agent tool calls are audited by the MCP registry.
async function auditOwner(env: Env, owner: string, tool: string, subject: string, outcome = "ok"): Promise<void> {
  await audit(env, { principal: owner, tool, argsHash: await sha256Hex(subject), outcome });
}

async function revokeGoogleToken(token: string): Promise<"revoked" | "failed"> {
  try {
    const response = await fetch(REVOKE_URL, { method: "POST", redirect: "error",
      signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }) });
    const outcome = response.ok ? "revoked" : "failed";
    await response.body?.cancel().catch(() => {});
    return outcome;
  } catch { return "failed"; }
}

export async function disconnectGmail(env: Env, owner: string) {
  await ensureGmailSchema(env);
  // Deny access and new grants atomically before waiting for Google, while
  // keeping only the encrypted credential available for best-effort revoke.
  const disabled = await env.AGENT_AUDIT.batch<StoredConnection>([
    env.AGENT_AUDIT.prepare("UPDATE gmail_connections SET active = 0 WHERE owner = ? RETURNING id, owner, refresh_cipher AS refreshCipher").bind(owner),
    env.AGENT_AUDIT.prepare("DELETE FROM gmail_grants WHERE owner = ?").bind(owner),
    env.AGENT_AUDIT.prepare("DELETE FROM gmail_oauth_states WHERE owner = ?").bind(owner),
  ]);
  const connection = disabled[0]?.results[0];
  let revoke: "not_connected" | "revoked" | "failed" = connection ? "failed" : "not_connected";
  try {
    if (connection) {
      const token = await decryptGmailToken(connection.refreshCipher, env.GMAIL_TOKEN_KEY ?? "", owner, connection.id);
      revoke = await revokeGoogleToken(token);
    }
  } catch { revoke = "failed"; }
  finally {
    // Cleanup is mandatory even when Google/config/decryption is unavailable.
    // Scope to this disabled connection so a concurrent disconnect cannot erase
    // a subsequent explicit reconnect. Grants/state were already removed above.
    if (connection) await env.AGENT_AUDIT.prepare(
      "DELETE FROM gmail_connections WHERE owner = ? AND id = ? AND active = 0",
    ).bind(owner, connection.id).run();
  }
  await auditOwner(env, owner, "gmail.disconnect", connection?.id ?? "", revoke);
  return { disconnected: true as const, revoke };
}

const GMAIL_READ_CAPABILITY = { kind: "connector" as const, id: "gmail" };
const GMAIL_READ_POLICY = {
  version: "gmail-read-v1",
  allowlist: [GMAIL_READ_CAPABILITY],
  actions: [
    { capability: GMAIL_READ_CAPABILITY, action: "search", risk: "read" as const, requiredProviderScopes: [GMAIL_SCOPE] },
    { capability: GMAIL_READ_CAPABILITY, action: "read", risk: "read" as const, requiredProviderScopes: [GMAIL_SCOPE] },
  ],
};

function canonicalGmailArgs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalGmailArgs);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonicalGmailArgs((value as Record<string, unknown>)[key])]));
  }
  return value;
}

async function gmailArgumentDigest(args: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(canonicalGmailArgs(args)));
}

async function accessForPrincipal(
  env: Env,
  principal: TokenRecord,
  operation: "search" | "read",
  normalizedArgs: Record<string, unknown>,
) {
  requireScope(principal, "gmail:read");
  if (principal.revoked) throw new GmailError("Gmail access denied.", 403);
  if (orgIdForRecord(principal) !== DASHBOARD_ORG_ID) throw new GmailError("Gmail access denied.", 403);
  validateGmailPrincipal(principal.principal);
  const config = gmailConfig(env);
  await ensureGmailSchema(env);
  const connection = await env.AGENT_AUDIT.prepare(
    `SELECT c.id, c.owner, c.email, c.refresh_cipher AS refreshCipher, g.token_created AS generation FROM gmail_connections c
     JOIN gmail_grants g ON g.connection_id = c.id AND g.owner = c.owner
     WHERE g.principal = ? AND g.token_created = ? AND c.active = 1`,
  ).bind(principal.principal, principal.created).first<StoredConnection>();
  if (!connection) throw new GmailError("Explicit Gmail connection grant required.", 403);
  const refreshToken = await decryptGmailToken(connection.refreshCipher, config.tokenKey, connection.owner, connection.id);
  const result = await exchange(env, { grant_type: "refresh_token", refresh_token: refreshToken }, false);
  const now = Date.now();
  const context: ConnectionDispatchContext = {
    now,
    principal: { userId: principal.principal, workspaceId: DASHBOARD_ORG_ID },
    grant: {
      connectionId: connection.id,
      owner: { type: "shared_workspace", workspaceId: DASHBOARD_ORG_ID },
      lifecycle: "active",
      verification: "live_verified",
      verifiedAt: now,
      verificationExpiresAt: now + 60_000,
      capability: GMAIL_READ_CAPABILITY,
      providerScopes: [GMAIL_SCOPE],
      allowedResources: [],
      accountId: connection.email,
      policyVersion: GMAIL_READ_POLICY.version,
      generation: connection.generation,
    },
    policy: GMAIL_READ_POLICY,
    request: {
      capability: GMAIL_READ_CAPABILITY,
      action: operation,
      accountId: connection.email,
      argumentDigest: await gmailArgumentDigest(normalizedArgs),
    } satisfies CapabilityAction,
  };
  const decision = decideConnectionDispatch(context);
  if (!decision.allowed || decision.risk !== "read") throw new GmailError("Gmail access denied.", 403);
  return { token: result.access_token as string, connectionId: connection.id, generation: connection.generation };
}

async function requireActiveGrant(env: Env, principal: TokenRecord, connectionId: string): Promise<void> {
  const allowed = await env.AGENT_AUDIT.prepare(
    `SELECT c.id FROM gmail_connections c JOIN gmail_grants g ON g.connection_id = c.id AND g.owner = c.owner
     WHERE c.id = ? AND g.principal = ? AND g.token_created = ? AND c.active = 1`,
  ).bind(connectionId, principal.principal, principal.created).first();
  if (!allowed) throw new GmailError("Explicit Gmail connection grant required.", 403);
}

export async function searchGmail(env: Env, principal: TokenRecord, query: string, limit: number) {
  if (typeof query !== "string" || query.length > 256 || !Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new GmailError("Gmail search requires at most 256 characters and 1–25 results.");
  }
  const access = await accessForPrincipal(env, principal, "search", { query, limit });
  await requireActiveGrant(env, principal, access.connectionId);
  const result = await gmailGet(access.token, "messages", undefined, query, limit);
  await requireActiveGrant(env, principal, access.connectionId);
  const messages = Array.isArray(result.messages) ? result.messages : [];
  return { messages: messages.slice(0, limit).map((item: unknown) => {
    const message = item as Record<string, unknown>;
    if (!message || typeof message.id !== "string" || !MESSAGE_ID.test(message.id) ||
        typeof message.threadId !== "string" || !MESSAGE_ID.test(message.threadId)) {
      throw new GmailError("Invalid Gmail message response.", 502);
    }
    return { id: message.id, threadId: message.threadId };
  }) };
}

function capText(text: string, maxBytes: number): string {
  // stream:true drops an incomplete trailing UTF-8 sequence instead of expanding it.
  return new TextDecoder().decode(new TextEncoder().encode(text).subarray(0, maxBytes), { stream: true });
}
function messageContent(message: Record<string, unknown>) {
  const payload = message.payload as Record<string, unknown> | undefined;
  const headers = Array.isArray(payload?.headers) ? payload.headers : [];
  const meta: Record<string, string> = {};
  for (const name of ["from", "to", "subject", "date"]) {
    const header = headers.find((h) => h && typeof h.name === "string" && h.name.toLowerCase() === name);
    if (typeof header?.value === "string") meta[name] = capText(header.value, 1024);
  }
  const parts: { part: Record<string, unknown>; depth: number }[] = payload ? [{ part: payload, depth: 0 }] : [];
  let body = "";
  let visited = 0;
  while (parts.length && visited++ < 100 && new TextEncoder().encode(body).length < BODY_BYTES) {
    const { part, depth } = parts.pop()!;
    if (typeof part.filename === "string" && part.filename !== "") continue;
    const data = (part.body as Record<string, unknown> | undefined)?.data;
    if (part.mimeType === "text/plain" && typeof data === "string" && /^[A-Za-z0-9_-]*={0,2}$/.test(data)) {
      try { body = capText(`${body}${new TextDecoder().decode(fromBase64url(data))}`, BODY_BYTES); }
      catch { throw new GmailError("Invalid Gmail message body.", 502); }
    }
    if (depth < 8 && Array.isArray(part.parts)) {
      for (const child of part.parts.slice(0, 100).reverse()) {
        if (child && typeof child === "object") parts.push({ part: child, depth: depth + 1 });
      }
    }
  }
  // All email-derived text is marked untrusted, including headers and snippets.
  return wrapUntrusted(JSON.stringify({ headers: meta,
    snippet: typeof message.snippet === "string" ? capText(message.snippet, 1024) : "", body }));
}
export async function readGmail(env: Env, principal: TokenRecord, messageIds: string[]) {
  if (!Array.isArray(messageIds) || messageIds.length < 1 || messageIds.length > 25 ||
      messageIds.some((id) => typeof id !== "string" || !MESSAGE_ID.test(id))) throw new GmailError("Provide 1–25 valid Gmail message IDs.");
  const normalizedIds = [...new Set(messageIds)];
  const access = await accessForPrincipal(env, principal, "read", { messageIds: normalizedIds });
  const messages = [];
  // Sequential, bounded requests; no unbounded fan-out, attachments, or mailbox selector.
  for (const id of normalizedIds) {
    await requireActiveGrant(env, principal, access.connectionId);
    const message = await gmailGet(access.token, "messages", id);
    if (message.id !== id) throw new GmailError("Invalid Gmail message response.", 502);
    messages.push({ id, content: messageContent(message) });
  }
  await requireActiveGrant(env, principal, access.connectionId);
  return { messages };
}
