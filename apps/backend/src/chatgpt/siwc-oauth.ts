/**
 * OAuth discovery, token exchange, and id_token verification for ChatGPT SIWC.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import {
  CHATGPT_RESOURCE,
  type OpenIdDiscovery,
  parseEarliestRefreshAt,
  scopesIncludePlanUsage,
  type ChatGptConnectionRecord,
} from "./siwc.js";

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type: string;
  expires_in: number;
  scope: string;
  earliest_refresh_at?: number | string;
}

export class ChatGptOAuthError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly clearConnection = false,
  ) {
    super(message);
    this.name = "ChatGptOAuthError";
  }
}

let cachedJwks: JWTVerifyGetKey | undefined;
let cachedDiscovery: OpenIdDiscovery | undefined;

export async function fetchDiscovery(
  discoveryUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenIdDiscovery> {
  const response = await fetchImpl(discoveryUrl, { headers: { accept: "application/json" } });
  if (!response.ok) throw new ChatGptOAuthError("Could not reach ChatGPT sign-in discovery.");
  const body = (await response.json()) as OpenIdDiscovery;
  cachedDiscovery = body;
  cachedJwks = createRemoteJWKSet(new URL(body.jwks_uri));
  return body;
}

export function jwksForDiscovery(discovery: OpenIdDiscovery): JWTVerifyGetKey {
  if (cachedDiscovery?.jwks_uri === discovery.jwks_uri && cachedJwks) return cachedJwks;
  cachedJwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
  cachedDiscovery = discovery;
  return cachedJwks;
}

export async function exchangeToken(
  discovery: OpenIdDiscovery,
  body: URLSearchParams,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  const response = await fetchImpl(discovery.token_endpoint, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const raw = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof raw.error === "string" ? raw.error : "exchange_failed";
    const clear =
      body.get("grant_type") === "refresh_token" &&
      ["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"].includes(
        code,
      );
    throw new ChatGptOAuthError(
      code === "access_denied" ? "ChatGPT sign-in was declined." : "ChatGPT token exchange failed.",
      code,
      clear,
    );
  }
  const access = raw.access_token;
  const tokenType = raw.token_type;
  const expiresIn = raw.expires_in;
  const scope = raw.scope;
  if (typeof access !== "string" || access === "") throw new ChatGptOAuthError("Token response missing access_token.");
  if (typeof tokenType !== "string") throw new ChatGptOAuthError("Token response missing token_type.");
  if (typeof expiresIn !== "number" || expiresIn <= 0) throw new ChatGptOAuthError("Token response missing expires_in.");
  if (typeof scope !== "string") throw new ChatGptOAuthError("Token response missing scope.");
  return {
    access_token: access,
    refresh_token: typeof raw.refresh_token === "string" ? raw.refresh_token : undefined,
    id_token: typeof raw.id_token === "string" ? raw.id_token : undefined,
    token_type: tokenType,
    expires_in: expiresIn,
    scope,
    earliest_refresh_at: raw.earliest_refresh_at as number | string | undefined,
  };
}

export async function verifyIdToken(input: {
  idToken: string;
  discovery: OpenIdDiscovery;
  audience: string;
  nonce: string;
  jwks?: JWTVerifyGetKey;
}): Promise<{ subject: string; email: string | null }> {
  const key = input.jwks ?? jwksForDiscovery(input.discovery);
  const { payload } = await jwtVerify(input.idToken, key, {
    issuer: input.discovery.issuer,
    audience: input.audience,
    algorithms: ["RS256", "ES256"],
    clockTolerance: 5,
  });
  if (payload.nonce !== input.nonce || typeof payload.sub !== "string" || !payload.sub) {
    throw new ChatGptOAuthError("ChatGPT identity could not be verified.");
  }
  const email = typeof payload.email === "string" ? payload.email : null;
  return { subject: payload.sub, email };
}

export function connectionFromTokenResponse(input: {
  tokens: TokenResponse;
  clientId: string;
  redirectUri: string;
  hostId: string;
  subject: string;
  email: string | null;
  now: number;
}): ChatGptConnectionRecord {
  const scopes = input.tokens.scope.split(/\s+/).filter(Boolean);
  const planUsageEnabled = scopesIncludePlanUsage(input.tokens.scope);
  return {
    hostId: input.hostId,
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    accessToken: input.tokens.access_token,
    refreshToken: input.tokens.refresh_token ?? null,
    expiresAt: input.now + input.tokens.expires_in * 1000,
    earliestRefreshAt: parseEarliestRefreshAt(input.tokens.earliest_refresh_at),
    scopes,
    subject: input.subject,
    email: input.email,
    planUsageEnabled,
  };
}

export async function refreshConnection(
  discovery: OpenIdDiscovery,
  record: ChatGptConnectionRecord,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<ChatGptConnectionRecord> {
  if (!record.refreshToken) throw new ChatGptOAuthError("ChatGPT connection expired.", "no_refresh", true);
  if (record.earliestRefreshAt !== null && record.earliestRefreshAt > now && record.expiresAt > now) {
    return record;
  }
  if (record.expiresAt - now > 60_000) return record;
  const tokens = await exchangeToken(
    discovery,
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: record.clientId,
      refresh_token: record.refreshToken,
      resource: CHATGPT_RESOURCE,
    }),
    fetchImpl,
  );
  if (!tokens.refresh_token || tokens.token_type.toLowerCase() !== "bearer") {
    throw new ChatGptOAuthError("ChatGPT returned an invalid renewal.");
  }
  const scopes = tokens.scope.split(/\s+/).filter(Boolean);
  const planUsageEnabled = scopesIncludePlanUsage(tokens.scope);
  return {
    ...record,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: now + tokens.expires_in * 1000,
    earliestRefreshAt: parseEarliestRefreshAt(tokens.earliest_refresh_at),
    scopes,
    planUsageEnabled,
  };
}

export async function revokeRefreshToken(
  discovery: OpenIdDiscovery,
  record: ChatGptConnectionRecord,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!discovery.revocation_endpoint || !record.refreshToken) return false;
  const response = await fetchImpl(discovery.revocation_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token: record.refreshToken,
      token_type_hint: "refresh_token",
      client_id: record.clientId,
    }).toString(),
  });
  return response.ok;
}
