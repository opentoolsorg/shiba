import {
  INTEGRATION_CATALOG,
  type ExtensionScope,
  type ExtensionView,
  type IntegrationProviderCatalogItem,
} from "@shiba/shared";
import type { V1Context } from "../v1/context.js";
import { rejectCrossOriginMutation, rejectNonJsonMutation } from "../dashboard-mutation.js";
import { resolveOrgForApiRequest, type ResolvedOrgAuth } from "../org-request-auth.js";
import { OpenConnectorIntegrationProviderError } from "../integrations/openconnector-provider.js";
import { getIntegrationProvider } from "../integrations/runtime.js";
import { openConnectorGate } from "../integrations-provider-routes.js";
import {
  archiveWorkspaceConnector,
  createWorkspaceConnector,
  listWorkspaceConnectors,
  removeWorkspaceConnector,
  resolveConnectorWorkspaceId,
  restoreWorkspaceConnector,
  syncPersonalConnectorsFromProvider,
} from "./connectors-store.js";

const BASE = "/api/v1/extensions/connectors";
const views = ["personal", "workspace", "archived"] as const;

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function decodeConnectorId(raw: string): string | null {
  try {
    const id = decodeURIComponent(raw);
    return id && id.length <= 160 && !/[\\/]/.test(id) && !id.includes("\0") ? id : null;
  } catch {
    return null;
  }
}

function mutationFailure(result: { ok: false; reason: string }): Response {
  const status = result.reason === "not_found" ? 404 : result.reason === "forbidden" ? 403 : 409;
  return Response.json({ ok: false, error: result.reason }, { status });
}

function toApiConnector(row: Awaited<ReturnType<typeof listWorkspaceConnectors>>[number]) {
  return {
    id: row.id,
    provider: row.provider,
    providerKey: row.providerKey,
    scope: row.scope,
    identityLabel: row.identityLabel ?? null,
    ...(row.archivedAt !== undefined ? { archivedAt: row.archivedAt } : {}),
  };
}

async function buildConnectorDirectory(ctx: V1Context, userId: string, teamWorkspaceId?: string) {
  const provider = getIntegrationProvider(ctx.env);
  let items: IntegrationProviderCatalogItem[] = [];
  try {
    const page = await provider.listCatalog({
      userId,
      ...(teamWorkspaceId ? { workspaceId: teamWorkspaceId } : {}),
      limit: 50,
    });
    items = page.items;
  } catch (error) {
    if (error instanceof OpenConnectorIntegrationProviderError) throw error;
    items = INTEGRATION_CATALOG.map((entry) => ({
      id: entry.id,
      providerKey: entry.openConnectorServiceIds?.[0] ?? entry.id,
      name: entry.name,
      description: entry.summary,
      source: "openconnector" as const,
      connectable: entry.status === "live",
      setupState: entry.status === "live" ? "ready" as const : "needs_configuration" as const,
      isConnected: false,
    }));
    return { items, fallbackCatalog: true };
  }
  const merged = new Map<string, IntegrationProviderCatalogItem>();
  for (const item of items) merged.set(item.providerKey, item);
  for (const entry of INTEGRATION_CATALOG) {
    const providerKey = entry.openConnectorServiceIds?.[0];
    if (!providerKey || merged.has(providerKey)) continue;
    merged.set(providerKey, {
      id: entry.id,
      providerKey,
      name: entry.name,
      description: entry.summary,
      source: "openconnector",
      connectable: entry.status === "live",
      setupState: entry.status === "live" ? "ready" : "needs_configuration",
      isConnected: false,
      docsUrl: entry.docsUrl,
      domain: entry.domain,
      kind: entry.kind,
      priority: entry.priority,
    });
  }
  return { items: [...merged.values()], fallbackCatalog: false };
}

export async function handleExtensionConnectors(ctx: V1Context): Promise<Response | null> {
  const pathname = ctx.url.pathname.replace(/\/$/, "") || "/";
  if (pathname !== BASE && !pathname.startsWith(`${BASE}/`)) return null;

  const auth = ctx.request.headers.has("X-Shiba-Workspace")
    ? await resolveOrgForApiRequest(ctx.request, ctx.env)
    : null;
  if (auth instanceof Response) return auth;

  if (!ctx.env.AGENT_AUDIT) {
    return Response.json({ error: "connector_storage_unavailable" }, { status: 503 });
  }

  const team = auth?.workspace;
  const userId = team ? team.userId : ctx.principal.principal;
  if (!userId) return Response.json({ error: "Authentication required." }, { status: 401 });

  const registryWorkspaceId = resolveConnectorWorkspaceId(auth?.orgId ?? ctx.principal.orgId);
  const teamWorkspaceId = team?.workspaceId;
  const canManageWorkspace = team ? team.role !== "member" : ctx.principal.scopes.includes("api:keys:admin");

  if (pathname === BASE && ctx.request.method === "GET") {
    const rawView = ctx.url.searchParams.get("view");
    const view = views.includes(rawView as ExtensionView) ? rawView as ExtensionView : "personal";
    const gate = openConnectorGate(ctx.env);
    if (!gate) {
      try {
        await syncPersonalConnectorsFromProvider(ctx.env, registryWorkspaceId, userId, teamWorkspaceId);
      } catch {
        /* Registry sync is best-effort when the provider returns errors. */
      }
    }
    const connectors = await listWorkspaceConnectors(ctx.env, registryWorkspaceId, userId, view);
    return Response.json({ connectors: connectors.map(toApiConnector) }, { headers: { "cache-control": "no-store" } });
  }

  if (pathname === `${BASE}/directory` && ctx.request.method === "GET") {
    const gate = openConnectorGate(ctx.env);
    if (gate) return gate;
    try {
      const directory = await buildConnectorDirectory(ctx, userId, teamWorkspaceId);
      return Response.json(directory ?? { items: [], fallbackCatalog: true }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      if (error instanceof OpenConnectorIntegrationProviderError) {
        return Response.json({ ok: false, code: "openconnector_not_bound", error: "Set up OpenConnector." }, { status: 503 });
      }
      return Response.json({ ok: false, error: "Integration catalog unavailable." }, { status: 503 });
    }
  }

  if (ctx.request.method !== "GET" && ctx.request.method !== "HEAD") {
    if (!ctx.principal.apiKey) {
      const originBlock = rejectCrossOriginMutation(ctx.request);
      if (originBlock) return originBlock;
    }
    const jsonBlock = rejectNonJsonMutation(ctx.request);
    if (jsonBlock) return jsonBlock;
  }

  const match = pathname.match(/^\/api\/v1\/extensions\/connectors\/([^/]+)(?:\/(archive|restore))?$/);
  if (!match) {
    if (pathname === BASE && ctx.request.method === "POST") {
      const body = await jsonBody(ctx.request);
      const providerKey = typeof body?.providerKey === "string" ? body.providerKey.trim() : "";
      const connectedAccountId = typeof body?.connectedAccountId === "string" ? body.connectedAccountId.trim() : "";
      const scope = body?.scope === "workspace" ? "workspace" : "personal";
      if (!providerKey || !connectedAccountId) return badRequest("providerKey and connectedAccountId are required");
      if (body?.provider !== undefined && body.provider !== "openconnector") return badRequest("Only openconnector is supported");
      try {
        const connector = await createWorkspaceConnector(
          ctx.env,
          registryWorkspaceId,
          userId,
          { providerKey, connectedAccountId, scope },
          teamWorkspaceId,
        );
        return Response.json({ connector: toApiConnector(connector) }, { status: 201, headers: { "cache-control": "no-store" } });
      } catch (error) {
        const message = error instanceof Error ? error.message : "connector_create_failed";
        const status = message === "connection_not_verified" ? 403
          : message === "workspace_scope_requires_consent" ? 409
          : 400;
        return Response.json({ error: message }, { status });
      }
    }
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  const id = decodeConnectorId(match[1]!);
  if (!id) return badRequest("Invalid connector id.");
  const action = match[2];

  if (action === "archive" && ctx.request.method === "POST") {
    const result = await archiveWorkspaceConnector(ctx.env, registryWorkspaceId, userId, id, canManageWorkspace);
    return result.ok ? Response.json({ ok: true }) : mutationFailure(result);
  }
  if (action === "restore" && ctx.request.method === "POST") {
    const result = await restoreWorkspaceConnector(ctx.env, registryWorkspaceId, userId, id, canManageWorkspace);
    return result.ok ? Response.json({ ok: true }) : mutationFailure(result);
  }
  if (!action && ctx.request.method === "DELETE") {
    const result = await removeWorkspaceConnector(ctx.env, registryWorkspaceId, userId, id, canManageWorkspace);
    return result.ok ? Response.json({ ok: true }) : mutationFailure(result);
  }
  if (!action && ctx.request.method === "PATCH") {
    return Response.json({ error: "Use workspace app consent to share connectors with the workspace." }, { status: 409 });
  }

  return Response.json({ error: "Method not allowed." }, { status: 405 });
}