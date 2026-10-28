/**
 * Dashboard API for org-scoped public API keys (KV AGENT_TOKENS).
 */
import {
  createApiKey,
  listApiKeys,
  orgIdForRecord,
  revokeApiKeyById,
  type TokenRecord,
} from "./agent-tokens.js";
import type { Env } from "./env.js";
import { authorizeV1Request, requireV1Scope, v1Forbidden, v1Unauthorized } from "./v1-auth.js";
import { isAuthorizedRequest } from "./request-auth.js";
import { InputError } from "./security.js";

function publicKeyRow(record: TokenRecord) {
  return {
    keyId: record.keyId ?? "",
    label: record.label ?? record.principal,
    principal: record.principal,
    orgId: orgIdForRecord(record),
    scopes: record.scopes,
    createdAt: record.created,
    revoked: record.revoked,
    expiresAt: record.expiresAt ?? null,
  };
}

export async function handleApiKeys(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/api-keys") return null;
  const dashboard = !request.headers.has("authorization") && await isAuthorizedRequest(request, env);
  const v1 = dashboard ? null : await authorizeV1Request(request, env);
  if (!dashboard) {
    if (!v1) return v1Unauthorized();
    if (!requireV1Scope(v1, "api:keys:admin")) return v1Forbidden();
  }
  const orgId = v1?.orgId ?? "self-hosted";
  if (request.method === "GET") {
    const keys = await listApiKeys(env, orgId);
    return Response.json(
      { ok: true, keys: keys.map(publicKeyRow) },
      { headers: { "cache-control": "no-store" } },
    );
  }
  if (request.method === "POST") {
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await request.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      body = parsed as Record<string, unknown>;
    } catch {
      return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
    }
    const label = typeof body.label === "string" ? body.label : "";
    const principal =
      typeof body.principal === "string" && body.principal.trim()
        ? body.principal.trim()
        : (v1?.principal ?? "api-integration");
    const scopes = Array.isArray(body.scopes)
      ? body.scopes.filter((scope): scope is string => typeof scope === "string")
      : ["api:read", "api:write"];
    try {
      const minted = await createApiKey(env, { orgId, label, principal, scopes });
      return Response.json(
        { ok: true, key: publicKeyRow(minted.record), token: minted.token },
        { status: 201, headers: { "cache-control": "no-store" } },
      );
    } catch (error: unknown) {
      if (error instanceof InputError) {
        return Response.json({ ok: false, error: error.message }, { status: 400 });
      }
      return Response.json({ ok: false, error: "Could not mint API key." }, { status: 500 });
    }
  }
  if (request.method === "DELETE") {
    const keyId = url.searchParams.get("keyId")?.trim();
    if (!keyId) return Response.json({ ok: false, error: "keyId is required." }, { status: 400 });
    const revoked = await revokeApiKeyById(env, orgId, keyId);
    return Response.json({ ok: revoked, keyId });
  }
  return Response.json({ error: "Method not allowed." }, { status: 405 });
}
