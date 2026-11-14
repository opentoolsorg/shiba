/**
 * Public `/api/v1` authentication: dashboard session (Access / better-auth /
 * loopback dev) or org-scoped API keys (`shk_…`) in KV AGENT_TOKENS.
 */
import {
  API_KEY_SCOPES,
  isApiKeyBearer,
  orgIdForRecord,
  type Scope,
  type TokenRecord,
  verifyToken,
} from "./agent-tokens.js";
import type { Env } from "./env.js";
import { verifyOAuthAccessToken } from "./oauth-mcp.js";
import { isAuthorizedRequest, resolveUserId } from "./request-auth.js";

export interface V1Principal {
  principal: string;
  orgId: string;
  scopes: Scope[];
  /** Present when the caller used a bearer API key. */
  apiKey?: TokenRecord;
}

function bearerToken(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (auth === null) return null;
  const [scheme, ...rest] = auth.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer" || rest.length === 0) return null;
  return rest.join(" ");
}

async function resolveBearerRecord(env: Env, bearer: string): Promise<TokenRecord | null> {
  if (isApiKeyBearer(bearer)) {
    return verifyToken(env, bearer);
  }
  if (bearer.startsWith("shb_")) {
    return verifyToken(env, bearer);
  }
  if (bearer.startsWith("sho_")) {
    return verifyOAuthAccessToken(env, bearer);
  }
  return null;
}

const DASHBOARD_API_SCOPES = [...API_KEY_SCOPES] as Scope[];

export async function authorizeV1Request(request: Request, env: Env): Promise<V1Principal | null> {
  const bearer = bearerToken(request);
  if (request.headers.has("authorization")) {
    if (bearer === null) return null;
    const record = await resolveBearerRecord(env, bearer);
    if (!record || record.kind !== "api_key") {
      return null;
    }
    if (!record.scopes.some((scope) => (API_KEY_SCOPES as readonly string[]).includes(scope))) {
      return null;
    }
    if (await apiKeyRateLimited(env, record, request)) {
      return null;
    }
    return {
      principal: record.principal,
      orgId: orgIdForRecord(record),
      scopes: record.scopes,
      apiKey: record,
    };
  }
  if (!(await isAuthorizedRequest(request, env))) {
    return null;
  }
  return {
    principal: (await resolveUserId(request, env)) ?? "default",
    orgId: "self-hosted",
    scopes: DASHBOARD_API_SCOPES,
  };
}

export function requireV1Scope(principal: V1Principal, scope: Scope): boolean {
  return principal.scopes.includes(scope);
}

export function requireV1Write(principal: V1Principal): boolean {
  return requireV1Scope(principal, "api:write");
}

export function requireV1Read(principal: V1Principal): boolean {
  return requireV1Scope(principal, "api:read");
}

export function v1Unauthorized(): Response {
  return Response.json({ _tag: "shiba/Unauthorized" }, { status: 401 });
}

export function v1Forbidden(): Response {
  return Response.json({ _tag: "shiba/Forbidden" }, { status: 403 });
}

export function v1TooManyRequests(): Response {
  return Response.json({ _tag: "shiba/TooManyRequests" }, { status: 429 });
}

const API_KEY_RATE_LIMIT = 120;
const API_KEY_RATE_WINDOW_MS = 60_000;

/** Returns true when the API key has exceeded its per-minute request budget. */
export async function apiKeyRateLimited(env: Env, record: TokenRecord, request: Request): Promise<boolean> {
  const kv = env.AGENT_TOKENS;
  if (!kv || record.kind !== "api_key" || !record.keyId) return false;
  const window = Math.floor(Date.now() / API_KEY_RATE_WINDOW_MS);
  const key = `rl_api_key:${record.keyId}:${window}`;
  try {
    const raw = await kv.get(key, { type: "text" });
    const count = raw === null ? 0 : Number.parseInt(raw, 10);
    if (!Number.isFinite(count) || count >= API_KEY_RATE_LIMIT) return true;
    await kv.put(key, String(count + 1), {
      expirationTtl: Math.ceil((API_KEY_RATE_WINDOW_MS * 2) / 1000),
    });
    return false;
  } catch {
    return true;
  }
}

export function apiKeyAllowsHttpMethod(principal: V1Principal, method: string): boolean {
  const readOnly = method === "GET" || method === "HEAD";
  return readOnly ? requireV1Read(principal) : requireV1Write(principal);
}
