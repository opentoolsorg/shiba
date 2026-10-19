import { parseSandboxProviderId } from "@shiba/sandbox";
import type { Env } from "./env.js";
import { isAuthorizedRequest } from "./request-auth.js";
import {
  authorizeV1Request,
  requireV1Read,
  requireV1Write,
  v1Forbidden,
  v1Unauthorized,
  type V1Principal,
} from "./v1-auth.js";
import { getOrgSandboxProvider, setOrgSandboxProvider } from "./org-sandbox-store.js";
import { listSandboxProviderCatalog } from "./sandbox/provider-catalog.js";
import { resolveSandboxSelection } from "./sandbox/selection.js";

async function resolveOrgId(
  request: Request,
  env: Env,
): Promise<{ orgId: string; principal: V1Principal | null } | Response> {
  const dashboard = await isAuthorizedRequest(request, env);
  if (dashboard) return { orgId: "self-hosted", principal: null };
  const principal = await authorizeV1Request(request, env);
  if (!principal) return v1Unauthorized();
  return { orgId: principal.orgId, principal };
}

function decodePatch(body: unknown): { providerId: string; computesdkBackend?: string } | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = body as { providerId?: unknown; computesdkBackend?: unknown };
  if (typeof raw.providerId !== "string" || !raw.providerId.trim()) return null;
  const computesdkBackend =
    typeof raw.computesdkBackend === "string" && raw.computesdkBackend.trim()
      ? raw.computesdkBackend.trim()
      : undefined;
  return { providerId: raw.providerId.trim(), ...(computesdkBackend ? { computesdkBackend } : {}) };
}

export async function handleOrgSandboxSettings(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/org/sandbox") return null;
  if (!env.AGENT_AUDIT) {
    return Response.json({ ok: false, error: "AGENT_AUDIT D1 binding is not configured." }, { status: 503 });
  }

  const auth = await resolveOrgId(request, env);
  if (auth instanceof Response) return auth;
  if (auth.principal) {
    if (request.method === "GET" && !requireV1Read(auth.principal)) return v1Forbidden();
    if (request.method !== "GET" && !requireV1Write(auth.principal)) return v1Forbidden();
  }

  if (request.method === "GET") {
    const settings = await getOrgSandboxProvider(env, auth.orgId);
    const selection = await resolveSandboxSelection(env, { orgId: auth.orgId });
    const providers = listSandboxProviderCatalog(env);
    return Response.json(
      {
        ok: true,
        orgId: auth.orgId,
        settings,
        effective: selection,
        providers,
        deploymentDefault: env.SHIBA_SANDBOX_PROVIDER?.trim() || "cloudflare",
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  if (request.method === "PATCH") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
    }
    const patch = decodePatch(body);
    if (!patch) {
      return Response.json({ ok: false, error: "providerId is required." }, { status: 400 });
    }
    try {
      parseSandboxProviderId(patch.providerId);
    } catch (error) {
      return Response.json(
        { ok: false, error: error instanceof Error ? error.message : "invalid_provider" },
        { status: 400 },
      );
    }
    const saved = await setOrgSandboxProvider(
      env,
      auth.orgId,
      patch.providerId,
      patch.computesdkBackend,
    );
    const selection = await resolveSandboxSelection(env, { orgId: auth.orgId });
    return Response.json({ ok: true, settings: saved, effective: selection });
  }

  return Response.json({ error: "Method not allowed." }, { status: 405 });
}
