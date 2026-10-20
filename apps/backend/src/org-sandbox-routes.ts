import { parseSandboxProviderId } from "@shiba/sandbox";
import type { Env } from "./env.js";
import { resolveOrgForApiRequest } from "./org-request-auth.js";
import {
  getDecryptedOrgRunnerToken,
  getOrgSandboxProvider,
  type SetOrgSandboxParams,
  setOrgSandboxProvider,
} from "./org-sandbox-store.js";
import { listSandboxProviderCatalog } from "./sandbox/provider-catalog.js";
import { resolveSandboxSelection } from "./sandbox/selection.js";
import { InputError, validateRunnerUrl } from "./security.js";
import { requireV1Read, requireV1Write, v1Forbidden } from "./v1-auth.js";

function decodePatch(body: unknown): SetOrgSandboxParams | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = body as {
    providerId?: unknown;
    computesdkBackend?: unknown;
    runnerUrl?: unknown;
    runnerToken?: unknown;
  };
  if (typeof raw.providerId !== "string" || !raw.providerId.trim()) return null;
  const computesdkBackend =
    typeof raw.computesdkBackend === "string" && raw.computesdkBackend.trim()
      ? raw.computesdkBackend.trim()
      : undefined;
  const runnerUrl =
    typeof raw.runnerUrl === "string" && raw.runnerUrl.trim() ? raw.runnerUrl.trim() : undefined;
  const runnerToken =
    typeof raw.runnerToken === "string" && raw.runnerToken.trim()
      ? raw.runnerToken.trim()
      : undefined;

  return {
    providerId: raw.providerId.trim(),
    ...(computesdkBackend ? { computesdkBackend } : {}),
    ...(runnerUrl ? { runnerUrl } : {}),
    ...(runnerToken ? { runnerToken } : {}),
  };
}

function normalizeRunnerUrl(raw: string): string | null {
  try {
    return validateRunnerUrl(raw);
  } catch {
    return null;
  }
}

async function pingRunner(
  baseUrl: string,
  token: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const validated = validateRunnerUrl(baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const headers = { authorization: `Bearer ${token}` };
    const pingUrl = `${validated}/v1/ping`;
    const res = await fetch(pingUrl, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: controller.signal,
    }).catch(() => null);

    clearTimeout(timeout);
    if (!res) {
      return { ok: false, message: "Could not reach runner endpoint." };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: "Runner rejected authentication token (401/403)." };
    }
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, message: "ComputeSDK runner reached and authenticated successfully." };
    }
    return { ok: false, message: `Runner returned HTTP status ${res.status}.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Runner ping failed." };
  }
}

export async function handleOrgSandboxSettings(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/org/sandbox" && url.pathname !== "/api/org/sandbox/test") return null;
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

  if (url.pathname === "/api/org/sandbox/test" && request.method === "POST") {
    let body: { runnerUrl?: string; runnerToken?: string } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      // Body may be empty if testing saved configuration
    }
    let runnerUrl = body.runnerUrl?.trim();
    let runnerToken = body.runnerToken?.trim();

    if (!runnerUrl || !runnerToken) {
      const existing = await getOrgSandboxProvider(env, auth.orgId);
      // The stored token only ever goes to the stored URL, never to a caller-supplied one.
      if (runnerUrl && !runnerToken && normalizeRunnerUrl(runnerUrl) !== existing?.runnerUrl) {
        return Response.json(
          { ok: false, error: "runnerToken is required when testing a new runnerUrl." },
          { status: 400 },
        );
      }
      runnerUrl ||= existing?.runnerUrl;
      if (!runnerToken) {
        runnerToken = (await getDecryptedOrgRunnerToken(env, auth.orgId)) ?? undefined;
      }
    }

    if (!runnerUrl) {
      return Response.json(
        { ok: false, error: "runnerUrl is required to test runner." },
        { status: 400 },
      );
    }
    if (!runnerToken) {
      return Response.json(
        { ok: false, error: "runnerToken is required to test runner." },
        { status: 400 },
      );
    }

    const testResult = await pingRunner(runnerUrl, runnerToken);
    return Response.json({ ok: testResult.ok, message: testResult.message });
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
    if (patch.runnerUrl) {
      try {
        validateRunnerUrl(patch.runnerUrl);
      } catch (error) {
        return Response.json(
          { ok: false, error: error instanceof Error ? error.message : "invalid_runner_url" },
          { status: 400 },
        );
      }
    }
    let saved: Awaited<ReturnType<typeof setOrgSandboxProvider>>;
    try {
      saved = await setOrgSandboxProvider(env, auth.orgId, patch);
    } catch (error) {
      if (error instanceof InputError) {
        return Response.json({ ok: false, error: error.message }, { status: 400 });
      }
      throw error;
    }
    const selection = await resolveSandboxSelection(env, { orgId: auth.orgId });
    return Response.json({ ok: true, settings: saved, effective: selection });
  }

  return Response.json({ error: "Method not allowed." }, { status: 405 });
}
