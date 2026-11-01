/**
 * OAuth 2.1 pairing for owner-configured upstream MCP servers (RFC 9728 + 8414).
 * Bearer-header fallback stays on external-mcp credentialRef / encrypted bearer store.
 */
import { audit } from "./audit.js";
import type { Env } from "./env.js";
import { sha256Hex } from "./agent-tokens.js";
import { generatePkce } from "./provider-oauth/pkce.js";
import {
  decryptAuthJson,
  encryptAuthJson,
  ensureSubscriptionCredentialSchema,
  modelCredentialKeyConfigured,
} from "./subscription-credentials.js";
import { randomHex } from "./mailbox-store.js";

export interface OAuthProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
  bearer_methods_supported?: string[];
}

export interface OAuthAuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  code_challenge_methods_supported?: string[];
  scopes_supported?: string[];
}

export interface ExternalMcpOAuthDiscovery {
  resource: OAuthProtectedResourceMetadata;
  authorizationServer: OAuthAuthorizationServerMetadata;
}

export interface ExternalMcpOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
  tokenType: string;
  tokenEndpoint?: string;
  clientId?: string;
  revocationEndpoint?: string;
}

export interface ExternalMcpOAuthPending {
  serverId: string;
  orgId: string;
  ownerId: string;
  catalogId: string;
  redirectUri: string;
  codeVerifierCipher: string;
  revocationEndpoint?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  scopes: string;
  expiresAt: number;
}

const TOKEN_KIND = (serverId: string) => `external-mcp-oauth:${serverId}`;

function oauthReady(env: Env): boolean {
  return modelCredentialKeyConfigured(env);
}

function resourceOrigin(vendor: { endpoint: string; resourceOrigin?: string }): URL {
  return new URL(vendor.resourceOrigin ?? vendor.endpoint);
}

export async function discoverExternalMcpOAuth(
  vendor: { endpoint: string; resourceOrigin?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ExternalMcpOAuthDiscovery> {
  const origin = resourceOrigin(vendor);
  const prUrl = new URL("/.well-known/oauth-protected-resource", origin);
  const prResponse = await fetchImpl(prUrl, { redirect: "error", signal: AbortSignal.timeout(8_000) });
  if (!prResponse.ok) throw new Error("oauth_discovery_failed");
  const resource = (await prResponse.json()) as OAuthProtectedResourceMetadata;
  if (!resource.authorization_servers?.length) throw new Error("oauth_discovery_failed");
  const authServerOrigin = resource.authorization_servers[0]!.replace(/\/$/, "");
  const asUrl = new URL("/.well-known/oauth-authorization-server", `${authServerOrigin}/`);
  const asResponse = await fetchImpl(asUrl, { redirect: "error", signal: AbortSignal.timeout(8_000) });
  if (!asResponse.ok) throw new Error("oauth_discovery_failed");
  const authorizationServer = (await asResponse.json()) as OAuthAuthorizationServerMetadata;
  if (!authorizationServer.authorization_endpoint || !authorizationServer.token_endpoint) {
    throw new Error("oauth_discovery_failed");
  }
  return { resource, authorizationServer };
}

async function loadPendingByState(env: Env, state: string): Promise<(ExternalMcpOAuthPending & { codeVerifier: string }) | null> {
  const row = await env.AGENT_AUDIT.prepare(
    `SELECT * FROM external_mcp_oauth_pending WHERE state_hash = ? AND expires_at > ?`,
  )
    .bind(await sha256Hex(state), Date.now())
    .first<Record<string, unknown>>();
  if (!row || typeof row.server_id !== "string" || typeof row.code_verifier_cipher !== "string") return null;
  if (!oauthReady(env)) return null;
  const pendingSecret = await decryptAuthJson(
    row.code_verifier_cipher as string,
    env.MODEL_CREDENTIAL_KEY!,
    String(row.org_id),
    String(row.owner_id),
    `external-mcp-pending:${row.server_id}`,
  );
  // Older pending rows encrypted only the verifier; new rows also retain vendor metadata.
  const secret = pendingSecret.startsWith("{")
    ? JSON.parse(pendingSecret) as { verifier: string; revocationEndpoint?: string }
    : { verifier: pendingSecret };
  return {
    revocationEndpoint: secret.revocationEndpoint,
    serverId: row.server_id as string,
    orgId: row.org_id as string,
    ownerId: row.owner_id as string,
    catalogId: row.catalog_id as string,
    redirectUri: row.redirect_uri as string,
    codeVerifierCipher: row.code_verifier_cipher as string,
    authorizationEndpoint: row.authorization_endpoint as string,
    tokenEndpoint: row.token_endpoint as string,
    clientId: row.client_id as string,
    scopes: row.scopes as string,
    expiresAt: row.expires_at as number,
    codeVerifier: secret.verifier,
  };
}

export async function ensureExternalMcpOAuthSchema(env: Env): Promise<void> {
  await env.AGENT_AUDIT.prepare(
    `CREATE TABLE IF NOT EXISTS external_mcp_oauth_pending (
      state_hash TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      catalog_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      code_verifier_cipher TEXT NOT NULL,
      authorization_endpoint TEXT NOT NULL,
      token_endpoint TEXT NOT NULL,
      client_id TEXT NOT NULL,
      scopes TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  ).run();
  await env.AGENT_AUDIT.prepare(
    `CREATE TABLE IF NOT EXISTS external_mcp_oauth_refresh_locks (
      server_id TEXT PRIMARY KEY,
      lease_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`,
  ).run();
  await ensureSubscriptionCredentialSchema(env);
}

export async function beginExternalMcpOAuthConnect(
  env: Env,
  input: {
    serverId: string;
    orgId: string;
    ownerId: string;
    catalogId: string;
    redirectUri: string;
    clientId: string;
    scopes: string;
    discovery: ExternalMcpOAuthDiscovery;
  },
): Promise<{ authorizationUrl: string; state: string }> {
  if (!oauthReady(env)) throw new Error("oauth_storage_unavailable");
  await ensureExternalMcpOAuthSchema(env);
  const { verifier, challenge } = await generatePkce();
  const state = randomHex(24);
  const cipher = await encryptAuthJson(
    JSON.stringify({ verifier, revocationEndpoint: input.discovery.authorizationServer.revocation_endpoint }),
    env.MODEL_CREDENTIAL_KEY!,
    input.orgId,
    input.ownerId,
    `external-mcp-pending:${input.serverId}`,
  );
  await env.AGENT_AUDIT.prepare("DELETE FROM external_mcp_oauth_pending WHERE server_id = ?").bind(input.serverId).run();
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO external_mcp_oauth_pending
      (state_hash, server_id, org_id, owner_id, catalog_id, redirect_uri, code_verifier_cipher,
       authorization_endpoint, token_endpoint, client_id, scopes, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      await sha256Hex(state),
      input.serverId,
      input.orgId,
      input.ownerId,
      input.catalogId,
      input.redirectUri,
      cipher,
      input.discovery.authorizationServer.authorization_endpoint,
      input.discovery.authorizationServer.token_endpoint,
      input.clientId,
      input.scopes,
      Date.now() + 15 * 60_000,
      Date.now(),
    )
    .run();
  const url = new URL(input.discovery.authorizationServer.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", input.scopes);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", input.discovery.resource.resource);
  return { authorizationUrl: url.toString(), state };
}

export async function exchangeExternalMcpOAuthCode(
  env: Env,
  input: { state: string; code: string; principal: { orgId: string; principal: string } },
  fetchImpl: typeof fetch = fetch,
): Promise<{ serverId: string; orgId: string; ownerId: string }> {
  if (!oauthReady(env)) throw new Error("oauth_storage_unavailable");
  const pending = await loadPendingByState(env, input.state);
  if (!pending || pending.orgId !== input.principal.orgId || pending.ownerId !== input.principal.principal) {
    throw new Error("oauth_state_invalid");
  }
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: pending.redirectUri,
    client_id: pending.clientId,
    code_verifier: pending.codeVerifier,
  });
  const tokenResponse = await fetchImpl(pending.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  if (!tokenResponse.ok) throw new Error("oauth_token_exchange_failed");
  const tokenJson = (await tokenResponse.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
  };
  if (!tokenJson.access_token) throw new Error("oauth_token_exchange_failed");
  const expiresAt = Date.now() + (tokenJson.expires_in ?? 3600) * 1000;
  const tokens: ExternalMcpOAuthTokens = {
    tokenEndpoint: pending.tokenEndpoint,
    clientId: pending.clientId,
    revocationEndpoint: pending.revocationEndpoint,
    accessToken: tokenJson.access_token,
    refreshToken: tokenJson.refresh_token,
    expiresAt,
    scope: tokenJson.scope,
    tokenType: tokenJson.token_type ?? "Bearer",
  };
  await saveExternalMcpOAuthTokens(env, pending.orgId, pending.ownerId, pending.serverId, tokens);
  await env.AGENT_AUDIT.prepare("DELETE FROM external_mcp_oauth_pending WHERE server_id = ?").bind(pending.serverId).run();
  await audit(env, {
    principal: pending.ownerId,
    tool: "external_mcp.connect",
    argsHash: await sha256Hex(`${pending.catalogId}:${pending.serverId}`),
    outcome: "ok",
  });
  return { serverId: pending.serverId, orgId: pending.orgId, ownerId: pending.ownerId };
}

export async function saveExternalMcpOAuthTokens(
  env: Env,
  orgId: string,
  ownerId: string,
  serverId: string,
  tokens: ExternalMcpOAuthTokens,
): Promise<void> {
  if (!oauthReady(env)) throw new Error("oauth_storage_unavailable");
  await ensureSubscriptionCredentialSchema(env);
  const cipher = await encryptAuthJson(
    JSON.stringify(tokens),
    env.MODEL_CREDENTIAL_KEY!,
    orgId,
    ownerId,
    TOKEN_KIND(serverId),
  );
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO user_subscription_credentials
      (workspace_id, user_id, kind, auth_cipher, account_email_hash, expires_at, saved_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT(workspace_id, user_id, kind) DO UPDATE SET
      auth_cipher = excluded.auth_cipher,
      expires_at = excluded.expires_at,
      saved_at = excluded.saved_at`,
  )
    .bind(orgId, ownerId, TOKEN_KIND(serverId), cipher, tokens.expiresAt, Date.now())
    .run();
}

export async function loadExternalMcpOAuthTokens(
  env: Env,
  orgId: string,
  ownerId: string,
  serverId: string,
): Promise<ExternalMcpOAuthTokens | null> {
  if (!oauthReady(env)) return null;
  await ensureSubscriptionCredentialSchema(env);
  const row = await env.AGENT_AUDIT.prepare(
    `SELECT auth_cipher FROM user_subscription_credentials WHERE workspace_id = ? AND user_id = ? AND kind = ?`,
  )
    .bind(orgId, ownerId, TOKEN_KIND(serverId))
    .first<{ auth_cipher: string }>();
  if (!row) return null;
  const plain = await decryptAuthJson(row.auth_cipher, env.MODEL_CREDENTIAL_KEY!, orgId, ownerId, TOKEN_KIND(serverId));
  return JSON.parse(plain) as ExternalMcpOAuthTokens;
}

export async function deleteExternalMcpOAuthTokens(
  env: Env,
  orgId: string,
  ownerId: string,
  serverId: string,
): Promise<void> {
  await ensureExternalMcpOAuthSchema(env);
  await ensureSubscriptionCredentialSchema(env);
  await env.AGENT_AUDIT.prepare(
    `DELETE FROM user_subscription_credentials WHERE workspace_id = ? AND user_id = ? AND kind = ?`,
  )
    .bind(orgId, ownerId, TOKEN_KIND(serverId))
    .run();
  await env.AGENT_AUDIT.prepare("DELETE FROM external_mcp_oauth_pending WHERE server_id = ?").bind(serverId).run();
}

export async function revokeExternalMcpOAuth(
  env: Env,
  input: { orgId: string; ownerId: string; serverId: string; revocationEndpoint?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let vendorRevocationFailed = false;
  try {
    const tokens = await loadExternalMcpOAuthTokens(env, input.orgId, input.ownerId, input.serverId);
    const endpoint = input.revocationEndpoint ?? tokens?.revocationEndpoint;
    if (tokens && endpoint) {
      const body = new URLSearchParams({
        token: tokens.refreshToken ?? tokens.accessToken,
        token_type_hint: tokens.refreshToken ? "refresh_token" : "access_token",
        ...(tokens.clientId ? { client_id: tokens.clientId } : {}),
      });
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      });
      vendorRevocationFailed = !response.ok;
    }
  } catch {
    vendorRevocationFailed = true;
  } finally {
    await deleteExternalMcpOAuthTokens(env, input.orgId, input.ownerId, input.serverId);
  }
  await audit(env, {
    principal: input.ownerId,
    tool: "external_mcp.revoke",
    argsHash: await sha256Hex(input.serverId),
    outcome: vendorRevocationFailed ? "error" : "ok",
    ...(vendorRevocationFailed ? { detail: "vendor_revocation_failed_local_credentials_deleted" } : {}),
  });
}

/** Encrypted bearer pasted by the owner when OAuth is unavailable. */
export async function saveExternalMcpBearerToken(
  env: Env,
  orgId: string,
  ownerId: string,
  serverId: string,
  bearer: string,
): Promise<void> {
  if (!bearer.trim() || bearer.length > 8_192) throw new Error("invalid_bearer");
  await saveExternalMcpOAuthTokens(env, orgId, ownerId, serverId, {
    accessToken: bearer.trim(),
    expiresAt: Date.now() + 365 * 24 * 60 * 60_000,
    tokenType: "Bearer",
  });
}

// Single flight within a Worker isolate, scoped to the credential database and owner.
const refreshes = new WeakMap<Env["AGENT_AUDIT"], Map<string, Promise<string | undefined>>>();

export async function resolveExternalMcpBearer(
  env: Env,
  orgId: string,
  ownerId: string,
  serverId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  let inFlight = refreshes.get(env.AGENT_AUDIT);
  if (!inFlight) { inFlight = new Map(); refreshes.set(env.AGENT_AUDIT, inFlight); }
  const key = JSON.stringify([orgId, ownerId, serverId]);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const resolve = async () => {
    const oauth = await loadExternalMcpOAuthTokens(env, orgId, ownerId, serverId);
    if (!oauth) return undefined;
    if (oauth.expiresAt > Date.now()) return oauth.accessToken;
    if (!oauth.refreshToken || !oauth.tokenEndpoint || !oauth.clientId) return undefined;
    await ensureExternalMcpOAuthSchema(env);
    const leaseId = crypto.randomUUID();
    const deadline = Date.now() + 10_000;
    for (;;) {
      const now = Date.now();
      const lease = await env.AGENT_AUDIT.prepare(
        `INSERT INTO external_mcp_oauth_refresh_locks (server_id, lease_id, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(server_id) DO UPDATE SET lease_id = excluded.lease_id, expires_at = excluded.expires_at
         WHERE external_mcp_oauth_refresh_locks.expires_at <= ?`,
      ).bind(serverId, leaseId, now + 30_000, now).run();
      if (lease.meta.changes > 0) break;
      const refreshed = await loadExternalMcpOAuthTokens(env, orgId, ownerId, serverId);
      if (!refreshed) return undefined;
      if (refreshed.expiresAt > Date.now()) return refreshed.accessToken;
      if (Date.now() >= deadline) throw new Error("oauth_refresh_in_progress");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    try {
      // Another isolate may have rotated the credentials while this caller waited.
      const current = await loadExternalMcpOAuthTokens(env, orgId, ownerId, serverId);
      if (!current) return undefined;
      if (current.expiresAt > Date.now()) return current.accessToken;
      if (!current.refreshToken || !current.tokenEndpoint || !current.clientId) return undefined;
      const response = await fetchImpl(current.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refreshToken, client_id: current.clientId }),
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw new Error("oauth_token_exchange_failed");
      const token = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; token_type?: string };
      if (!token.access_token) throw new Error("oauth_token_exchange_failed");
      const updated: ExternalMcpOAuthTokens = {
        ...current,
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? current.refreshToken,
        expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
        scope: token.scope ?? current.scope,
        tokenType: token.token_type ?? current.tokenType,
      };
      await saveExternalMcpOAuthTokens(env, orgId, ownerId, serverId, updated);
      return updated.accessToken;
    } finally {
      await env.AGENT_AUDIT.prepare("DELETE FROM external_mcp_oauth_refresh_locks WHERE server_id = ? AND lease_id = ?")
        .bind(serverId, leaseId).run();
    }
  };
  const promise = resolve();
  inFlight.set(key, promise);
  try { return await promise; } finally { inFlight.delete(key); }
}

export function deploymentOAuthClientEnvKey(catalogId: string): string {
  return `MCP_OAUTH_CLIENT_${catalogId.replace(/-/g, "_").toUpperCase()}`;
}

export function readDeploymentOAuthClientId(env: Env, catalogId: string): string | null {
  const key = deploymentOAuthClientEnvKey(catalogId);
  const value = (env as unknown as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function defaultOAuthScopes(_catalogId: string): string {
  return "openid offline_access";
}
