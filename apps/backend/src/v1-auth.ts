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
  if (bearer !== null) {
    const record = await resolveBearerRecord(env, bearer);
    if (!record || record.kind !== "api_key") {
      return null;
    }
    if (!record.scopes.some((scope) => (API_KEY_SCOPES as readonly string[]).includes(scope))) {
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
