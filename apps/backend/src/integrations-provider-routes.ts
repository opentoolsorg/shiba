import {
  INTEGRATIONS_PROVIDER_PAGE_SIZE_DEFAULT,
  SHIBA_INTEGRATIONS_OAUTH_CHANNEL,
  type IntegrationProviderBeginConnectResponse,
} from "@shiba/shared";
import { gmailOwner } from "./gmail-routes.js";
import type { Env } from "./env.js";
import { isAuthorizedRequest } from "./request-auth.js";
import { hasSameOriginIntent } from "./route-utils.js";
import { getIntegrationProvider, getSelectedIntegrationsProviderId } from "./integrations/runtime.js";
import {
  ComposioIntegrationProvider,
  ComposioIntegrationProviderError,
} from "./integrations/composio-provider.js";

const PROVIDER_BASE = "/api/integrations/provider";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

function oauthCallbackPage(origin: string, ok: boolean, detail: Record<string, unknown>): string {
  const payload = JSON.stringify({
    type: SHIBA_INTEGRATIONS_OAUTH_CHANNEL,
    ok,
    provider: "composio",
    ...detail,
  });
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Shiba integrations</title></head>
<body>
<p>${ok ? "Connection complete. Returning to Shiba…" : "Connection did not complete. Returning to Shiba…"}</p>
<script>
(function () {
  var payload = ${payload};
  try {
    var bc = new BroadcastChannel(${JSON.stringify(SHIBA_INTEGRATIONS_OAUTH_CHANNEL)});
    bc.postMessage(payload);
    bc.close();
  } catch (e) {}
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(payload, ${JSON.stringify(origin)});
    }
  } catch (e2) {}
  setTimeout(function () { window.close(); }, 400);
})();
</script>
</body>
</html>`;
}

function parseLimit(raw: string | null): number {
  if (!raw) return INTEGRATIONS_PROVIDER_PAGE_SIZE_DEFAULT;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1) return INTEGRATIONS_PROVIDER_PAGE_SIZE_DEFAULT;
  return Math.min(value, 50);
}

async function readJsonBody(request: Request, maxBytes = 4096): Promise<Record<string, unknown> | null> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) return null;
  if (!request.body) return {};
  const reader = request.body.getReader();
  const bytes = new Uint8Array(maxBytes);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.length > bytes.length) return null;
      bytes.set(value, size);
      size += value.length;
    }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(0, size)));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function requireSameOrigin(request: Request): Response | null {
  if (!hasSameOriginIntent(request)) {
    return json({ ok: false, error: "Same-origin request required." }, 403);
  }
  return null;
}

function asComposio(provider: ReturnType<typeof getIntegrationProvider>): ComposioIntegrationProvider | null {
  return provider instanceof ComposioIntegrationProvider ? provider : null;
}

export async function handleIntegrationProviderRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== PROVIDER_BASE && !url.pathname.startsWith(`${PROVIDER_BASE}/`)) {
    return null;
  }

  const provider = getIntegrationProvider(env);
  const selectedId = getSelectedIntegrationsProviderId(env);
  const suffix = url.pathname.slice(PROVIDER_BASE.length);

  if (suffix === "/callback" && request.method === "GET") {
    const ok =
      url.searchParams.get("status") === "success" ||
      url.searchParams.has("connectedAccountId") ||
      url.searchParams.get("success") === "true";
    const origin = url.origin;
    return html(
      oauthCallbackPage(origin, ok, {
        query: Object.fromEntries(url.searchParams.entries()),
      }),
    );
  }

  if (!(await isAuthorizedRequest(request, env))) {
    return json({ ok: false, error: "Authentication required." }, 401);
  }

  const owner = await gmailOwner(request, env);
  if (!owner) {
    return json({ ok: false, error: "Authenticated owner required." }, 401);
  }

  if (suffix === "/meta" && request.method === "GET") {
    const health = await provider.health();
    return json({ ok: true, provider: selectedId, health });
  }

  if (suffix === "/connections" && request.method === "GET") {
    const connections = await provider.listConnections({ userId: owner });
    return json({ ok: true, provider: selectedId, connections });
  }

  if (suffix === "/catalog" && request.method === "GET") {
    try {
      const page = await provider.listCatalog({
        userId: owner,
        query: url.searchParams.get("query") ?? undefined,
        cursor: url.searchParams.get("cursor") ?? undefined,
        limit: parseLimit(url.searchParams.get("limit")),
      });
      return json({
        ok: true,
        provider: selectedId,
        items: page.items,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        fallbackCatalog: page.fallbackCatalog,
      });
    } catch (error) {
      if (error instanceof ComposioIntegrationProviderError) {
        return json({ ok: false, error: error.message }, error.status);
      }
      return json({ ok: false, error: "Integration catalog unavailable." }, 503);
    }
  }

  if (suffix === "/session" && request.method === "POST") {
    const sameOrigin = requireSameOrigin(request);
    if (sameOrigin) return sameOrigin;
    const composio = asComposio(provider);
    if (!composio) {
      return json({ ok: false, error: "Tool router sessions require INTEGRATIONS_PROVIDER=composio." }, 503);
    }
    const body = await readJsonBody(request);
    const toolkitSlugs = Array.isArray(body?.toolkitSlugs)
      ? body!.toolkitSlugs.filter((value): value is string => typeof value === "string")
      : typeof body?.toolkitSlug === "string"
        ? [body.toolkitSlug]
        : [];
    const result = await composio.createToolRouterSession({ userId: owner, toolkitSlugs });
    return json(result, result.ok ? 200 : 503);
  }

  if (suffix === "/execute" && request.method === "POST") {
    const sameOrigin = requireSameOrigin(request);
    if (sameOrigin) return sameOrigin;
    const composio = asComposio(provider);
    if (!composio) {
      return json(
        { ok: false, status: "failed", error: "Composio tool execution requires INTEGRATIONS_PROVIDER=composio." },
        503,
      );
    }
    const body = await readJsonBody(request, 64 * 1024);
    const toolSlug = typeof body?.toolSlug === "string" ? body.toolSlug.trim() : "";
    if (!toolSlug) return json({ ok: false, status: "failed", error: "toolSlug is required." }, 400);
    const args =
      body?.arguments && typeof body.arguments === "object" && !Array.isArray(body.arguments)
        ? (body.arguments as Record<string, unknown>)
        : {};
    const result = await composio.executeTool({
      userId: owner,
      toolSlug,
      arguments: args,
      toolkitSlug: typeof body?.toolkitSlug === "string" ? body.toolkitSlug : undefined,
      sessionId: typeof body?.sessionId === "string" ? body.sessionId : undefined,
      connectedAccountId: typeof body?.connectedAccountId === "string" ? body.connectedAccountId : undefined,
    });
    return json(result, result.ok ? 200 : 503);
  }

  if (suffix === "/connect" && request.method === "POST") {
    const sameOrigin = requireSameOrigin(request);
    if (sameOrigin) return sameOrigin;
    const body = await readJsonBody(request);
    const providerKey = typeof body?.providerKey === "string" ? body.providerKey.trim() : "";
    if (!providerKey) return json({ ok: false, error: "providerKey is required." }, 400);
    const origin =
      typeof body?.callbackOrigin === "string" && body.callbackOrigin.trim()
        ? body.callbackOrigin.trim()
        : url.origin;
    const result: IntegrationProviderBeginConnectResponse = await provider.beginConnect({
      userId: owner,
      providerKey,
      callbackOrigin: origin,
    });
    return json(result, result.ok ? 200 : 503);
  }

  if (suffix === "/disconnect" && request.method === "POST") {
    const sameOrigin = requireSameOrigin(request);
    if (sameOrigin) return sameOrigin;
    const body = await readJsonBody(request);
    const providerKey = typeof body?.providerKey === "string" ? body.providerKey.trim() : "";
    if (!providerKey) return json({ ok: false, error: "providerKey is required." }, 400);
    try {
      await provider.disconnect({ userId: owner, providerKey, callbackOrigin: url.origin });
      return json({ ok: true, provider: selectedId, disconnected: providerKey });
    } catch (error) {
      return json(
        { ok: false, error: error instanceof Error ? error.message : "Disconnect failed." },
        503,
      );
    }
  }

  return json({ ok: false, error: "Integration provider route not found." }, 404);
}
