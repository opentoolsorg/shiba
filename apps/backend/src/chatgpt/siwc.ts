/**
 * Sign in with ChatGPT (OSS token sharing) — pure OAuth/PKCE helpers (t3code pattern).
 */
export const CHATGPT_DISCOVERY_URL = "https://auth.openai.com/.well-known/openid-configuration";
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
export const CHATGPT_AGENT_NAME_HINT = "shiba";
export const CHATGPT_DYNAMIC_CLIENT_ID = "dynamic_agent_client";
export const CHATGPT_PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const CHATGPT_AUTHORIZE_SCOPE =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

export interface OpenIdDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  revocation_endpoint?: string;
}

export interface PendingChatGptSignIn {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  registeredClientId?: string;
  hostId: string;
  createdAt: number;
}

export interface CallbackValidationOk {
  ok: true;
  code: string;
  clientId: string;
  redirectUri: string;
}

export interface CallbackValidationErr {
  ok: false;
  reason: string;
}

export type CallbackValidation = CallbackValidationOk | CallbackValidationErr;

function bytesToBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function randomBase64Url(byteLength: number): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function pkceChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return bytesToBase64Url(new Uint8Array(digest));
}

export function newHostId(): string {
  return `urn:uuid:${crypto.randomUUID()}`;
}

export function pickLoopbackPort(): number {
  return 49_152 + Math.floor(Math.random() * (65_536 - 49_152));
}

export function loopbackRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}/auth/callback`;
}

const CALLBACK_PATH = /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/auth\/callback$/u;

export function assertDiscoveryEndpoints(discovery: OpenIdDiscovery): string | null {
  if (discovery.issuer !== "https://auth.openai.com") return "unexpected issuer";
  for (const endpoint of [
    discovery.authorization_endpoint,
    discovery.token_endpoint,
    discovery.jwks_uri,
    ...(discovery.revocation_endpoint ? [discovery.revocation_endpoint] : []),
  ]) {
    if (new URL(endpoint).origin !== discovery.issuer) return "endpoint origin mismatch";
  }
  return null;
}

export function buildAuthorizeUrl(input: {
  discovery: OpenIdDiscovery;
  hostId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  registeredClientId?: string;
  loginHint?: string;
  idTokenHint?: string;
  promptConsent?: boolean;
}): string {
  if (!CALLBACK_PATH.test(input.redirectUri)) {
    throw new Error("redirect_uri must be http://127.0.0.1:<port>/auth/callback");
  }
  const url = new URL(input.discovery.authorization_endpoint);
  const params = new URLSearchParams({
    client_id: input.registeredClientId ?? CHATGPT_DYNAMIC_CLIENT_ID,
    ext_agent_host_id: input.hostId,
    response_type: "code",
    redirect_uri: input.redirectUri,
    scope: CHATGPT_AUTHORIZE_SCOPE,
    resource: CHATGPT_RESOURCE,
    state: input.state,
    nonce: input.nonce,
    code_challenge_method: "S256",
    code_challenge: input.codeChallenge,
  });
  if (!input.registeredClientId) {
    params.set("agent_name_hint", CHATGPT_AGENT_NAME_HINT);
  } else {
    if (input.loginHint) params.set("login_hint", input.loginHint);
    if (input.idTokenHint) params.set("id_token_hint", input.idTokenHint);
    if (input.promptConsent) params.set("prompt", "consent");
  }
  url.search = params.toString();
  return url.toString();
}

export function validateCallbackUrl(
  pasted: string,
  pending: Pick<PendingChatGptSignIn, "state" | "redirectUri" | "registeredClientId">,
): CallbackValidation {
  let url: URL;
  try {
    url = new URL(pasted.trim());
  } catch {
    return { ok: false, reason: "Callback URL is not a valid URL." };
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    return { ok: false, reason: "Callback must use http://127.0.0.1 (not localhost)." };
  }
  const expected = new URL(pending.redirectUri);
  if (
    url.pathname !== expected.pathname ||
    url.port !== expected.port ||
    url.protocol !== expected.protocol ||
    url.hostname !== expected.hostname
  ) {
    return { ok: false, reason: "Callback URL does not match the active sign-in redirect." };
  }
  if (url.searchParams.get("state") !== pending.state) {
    return { ok: false, reason: "Sign-in state mismatch — start again." };
  }
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    return {
      ok: false,
      reason: oauthError === "access_denied" ? "ChatGPT sign-in was declined." : "ChatGPT sign-in failed.",
    };
  }
  const code = url.searchParams.get("code");
  const clientId = pending.registeredClientId ?? url.searchParams.get("client_id");
  if (!code || !clientId || !clientId.startsWith("oaiapp_")) {
    return { ok: false, reason: "Callback is missing authorization code or client registration." };
  }
  if (
    pending.registeredClientId &&
    url.searchParams.has("client_id") &&
    url.searchParams.get("client_id") !== pending.registeredClientId
  ) {
    return { ok: false, reason: "Callback client_id does not match the saved registration." };
  }
  if (url.searchParams.get("code") && url.searchParams.getAll("code").length > 1) {
    return { ok: false, reason: "Callback must contain a single authorization code." };
  }
  return { ok: true, code, clientId, redirectUri: pending.redirectUri };
}

export function scopesIncludePlanUsage(scopeString: string): boolean {
  return scopeString.split(/\s+/).filter(Boolean).includes(CHATGPT_PLAN_SCOPE);
}

export function parseEarliestRefreshAt(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value * 1000;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export const REFRESH_INVALID_ERRORS = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

export function shouldClearConnectionOnRefreshError(errorCode: string): boolean {
  return REFRESH_INVALID_ERRORS.has(errorCode);
}

export interface ChatGptConnectionRecord {
  hostId: string;
  clientId: string;
  redirectUri: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  earliestRefreshAt: number | null;
  scopes: string[];
  subject: string;
  email: string | null;
  planUsageEnabled: boolean;
  threadId?: string;
}

export function connectionStatusFromRecord(record: ChatGptConnectionRecord | null): {
  connected: boolean;
  planUsageEnabled?: boolean;
  expiresAt?: number;
  savedAt?: number;
  emailHash?: string;
} {
  if (!record) return { connected: false };
  return {
    connected: true,
    planUsageEnabled: record.planUsageEnabled,
    expiresAt: record.expiresAt,
  };
}

export function pickNewerConnection(
  current: ChatGptConnectionRecord,
  incoming: ChatGptConnectionRecord,
): ChatGptConnectionRecord {
  return incoming.expiresAt >= current.expiresAt ? incoming : current;
}
