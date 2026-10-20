import type { Env } from "./env.js";
import {
  deleteOrgModelKey,
  getDecryptedOrgModelKey,
  isSupportedModelProvider,
  listOrgModelKeyStatuses,
  type SupportedModelProvider,
  setOrgModelKey,
} from "./org-model-keys-store.js";
import { resolveOrgForApiRequest } from "./org-request-auth.js";
import { requireV1Read, requireV1Write, v1Forbidden } from "./v1-auth.js";

async function probeModelKey(
  provider: SupportedModelProvider,
  apiKey: string,
): Promise<{ ok: boolean; message: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    let res: Response | null = null;
    if (provider === "anthropic") {
      res = await fetch("https://api.anthropic.com/v1/models", {
        method: "GET",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: controller.signal,
      }).catch(() => null);
    } else if (provider === "openai") {
      res = await fetch("https://api.openai.com/v1/models", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
      }).catch(() => null);
    } else if (provider === "google") {
      res = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
        method: "GET",
        headers: {
          "x-goog-api-key": apiKey,
        },
        signal: controller.signal,
      }).catch(() => null);
    } else if (provider === "xai") {
      res = await fetch("https://api.x.ai/v1/models", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
      }).catch(() => null);
    }

    clearTimeout(timeout);
    if (!res) {
      return { ok: false, message: "Network connection to provider API failed." };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Provider authentication failed (${res.status}): invalid API key.`,
      };
    }
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, message: `Successfully authenticated with ${provider}.` };
    }
    return { ok: false, message: `Provider returned HTTP status ${res.status}.` };
  } catch (error) {
    clearTimeout(timeout);
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Provider probe failed.",
    };
  }
}

export async function handleOrgModelKeys(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/org/model-keys")) return null;
  if (!env.AGENT_AUDIT) {
    return Response.json(
      { ok: false, error: "AGENT_AUDIT D1 binding is not configured." },
      { status: 503 },
    );
  }

  const auth = await resolveOrgForApiRequest(request, env);
  if (auth instanceof Response) return auth;
  if (auth.principal) {
    if (request.method === "GET" && !requireV1Read(auth.principal)) return v1Forbidden();
    if (request.method !== "GET" && !requireV1Write(auth.principal)) return v1Forbidden();
  }

  // GET /api/org/model-keys
  if (url.pathname === "/api/org/model-keys" && request.method === "GET") {
    const keys = await listOrgModelKeyStatuses(env, auth.orgId);
    return Response.json(
      { ok: true, orgId: auth.orgId, keys },
      { headers: { "cache-control": "no-store" } },
    );
  }

  // POST /api/org/model-keys/test
  if (url.pathname === "/api/org/model-keys/test" && request.method === "POST") {
    let body: { provider?: string; apiKey?: string } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
    }
    const provider = body.provider?.trim().toLowerCase();
    if (!provider || !isSupportedModelProvider(provider)) {
      return Response.json(
        { ok: false, error: "Invalid or unsupported provider." },
        { status: 400 },
      );
    }
    let apiKey = body.apiKey?.trim();
    if (!apiKey) {
      apiKey = (await getDecryptedOrgModelKey(env, auth.orgId, provider)) ?? undefined;
    }
    if (!apiKey) {
      return Response.json({ ok: false, error: "API key is required to test." }, { status: 400 });
    }

    const testResult = await probeModelKey(provider, apiKey);
    return Response.json({ ok: testResult.ok, message: testResult.message });
  }

  // PUT /api/org/model-keys/:provider
  // DELETE /api/org/model-keys/:provider
  const match = url.pathname.match(/^\/api\/org\/model-keys\/([a-zA-Z0-9_-]+)$/);
  if (match && match[1]) {
    const provider = match[1].toLowerCase();
    if (!isSupportedModelProvider(provider)) {
      return Response.json(
        { ok: false, error: "Invalid or unsupported provider." },
        { status: 400 },
      );
    }

    if (request.method === "PUT") {
      let body: { apiKey?: unknown };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
      }
      if (typeof body.apiKey !== "string" || !body.apiKey.trim()) {
        return Response.json({ ok: false, error: "apiKey is required." }, { status: 400 });
      }
      const saved = await setOrgModelKey(env, auth.orgId, provider, body.apiKey.trim());
      return Response.json({ ok: true, key: saved });
    }

    if (request.method === "DELETE") {
      await deleteOrgModelKey(env, auth.orgId, provider);
      return Response.json({ ok: true });
    }

    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }

  return Response.json({ error: "Not found." }, { status: 404 });
}
