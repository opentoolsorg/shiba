import { listTokens, orgIdForRecord } from "../agent-tokens.js";
import type { V1Context } from "./context.js";
import { createExternalMcpServer, disableExternalMcpServer, discoverExternalMcpServer,
  getExternalMcpServer, listExternalMcpAccess, listExternalMcpCatalogConnections, listExternalMcpServers, listExternalMcpTools, reviewExternalMcpTool,
  setExternalMcpAccess, setExternalMcpToolEnabled, updateExternalMcpServer } from "../external-mcp.js";
import {
  beginExternalMcpOAuthConnect,
  defaultOAuthScopes,
  discoverExternalMcpOAuth,
  exchangeExternalMcpOAuthCode,
  readDeploymentOAuthClientId,
  revokeExternalMcpOAuth,
  saveExternalMcpBearerToken,
} from "../external-mcp-oauth.js";
import { CURATED_MCP_VENDORS, curatedMcpVendorByCatalogId } from "@shiba/shared";
import { decideEmployeeActionApproval as decideApproval, getEmployeeActionApproval, listEmployeeActionApprovals } from "../employee-tool-store.js";
import { resolveCapabilityInvocationApproval } from "../capability-invocations.js";
import { executeApprovedExternalMcpAction } from "../external-mcp.js";

const BUILTIN_ID = "shiba";
const response = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

async function body(ctx: V1Context): Promise<Record<string, unknown> | null> {
  const length = ctx.request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > 16 * 1024)) return null;
  try {
    const reader = ctx.request.body?.getReader();
    if (!reader) return {};
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength; if (size > 16 * 1024) { await reader.cancel(); return null; }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isRecord(parsed) ? parsed : null;
  } catch { return null; }
}

function knownKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).every((key) => keys.includes(key));
}

function safeError(error: unknown): Response {
  const code = error instanceof Error ? error.message : "external_mcp_unavailable";
  const statuses: Record<string, number> = { destination_not_trusted: 403, invalid_endpoint: 400, invalid_registration: 400,
    invalid_credential_reference: 400, auth_reference_missing: 409, schema_invalid: 502, redirect_rejected: 502,
    schema_version_changed: 409, tool_not_reviewed_or_schema_changed: 409, invalid_effect_review: 400,
    server_limit: 409, server_not_found: 404, tool_disabled: 409, approval_not_found: 404,
    invalid_catalog_id: 400, connection_label_required: 400, invalid_connection_label: 400,
    oauth_discovery_failed: 502, oauth_storage_unavailable: 503, oauth_state_invalid: 400, oauth_token_exchange_failed: 502,
    oauth_client_not_configured: 503, invalid_bearer: 400 };
  const allowed = new Set(Object.keys(statuses));
  return response({ ok: false, error: allowed.has(code) ? code : "external_mcp_unavailable" }, statuses[code] ?? 503);
}

// Credentials are references to pre-provisioned Worker secrets. No body field accepts secret material.
function validCredentialRef(value: unknown): value is string | null {
  return value === null || typeof value === "string" && /^MCP_CREDENTIAL_[A-Z0-9_]{1,48}$/.test(value);
}

export async function handleMcp(ctx: V1Context): Promise<Response | null> {
  if (ctx.url.pathname === "/api/v1/mcp/vendors" && ctx.request.method === "GET") {
    return response({ ok: true, vendors: CURATED_MCP_VENDORS });
  }
  if (ctx.url.pathname === "/api/v1/mcp/catalog-connections" && ctx.request.method === "GET") {
    return response({ ok: true, connections: await listExternalMcpCatalogConnections(ctx.env, ctx.principal.orgId, ctx.principal.principal) });
  }
  if (ctx.url.pathname === "/api/v1/mcp/oauth/callback" && ctx.request.method === "GET") {
    const state = ctx.url.searchParams.get("state") ?? "";
    const code = ctx.url.searchParams.get("code") ?? "";
    if (!state || !code) return response({ ok: false, error: "invalid_request" }, 400);
    try {
      const result = await exchangeExternalMcpOAuthCode(ctx.env, { state, code });
      const server = await getExternalMcpServer(ctx.env, result.orgId, result.ownerId, result.serverId);
      if (server) await discoverExternalMcpServer(ctx.env, server).catch(() => {});
      return response({ ok: true, serverId: result.serverId });
    } catch (error) { return safeError(error); }
  }
  const match = ctx.url.pathname.match(/^\/api\/v1\/mcp\/servers(?:\/([^/]+)(?:\/(.*))?)?$/);
  if (!match) return null;
  const part = match[1];
  if (!part) {
    if (ctx.request.method === "GET") return response({ ok: true, servers: await listExternalMcpServers(ctx.env, ctx.principal.orgId, ctx.principal.principal), builtin: {
      id: BUILTIN_ID, projectId: null, name: "shiba", config: { transport: "http", url: `${ctx.url.origin}/mcp`, needsAuth: true }, enabled: true,
    } });
    if (ctx.request.method !== "POST") return response({ ok: false, error: "method_not_allowed" }, 405);
    const input = await body(ctx); if (!input || !knownKeys(input, ["name", "transport", "url", "credentialRef", "catalogId", "connectionLabel", "visibility", "authMode"]) ||
      (input.name !== undefined && typeof input.name !== "string") ||
      (input.transport !== undefined && input.transport !== "streamable_http") ||
      (input.url !== undefined && typeof input.url !== "string") ||
      (input.catalogId !== undefined && typeof input.catalogId !== "string") ||
      (input.connectionLabel !== undefined && typeof input.connectionLabel !== "string") ||
      (input.visibility !== undefined && input.visibility !== "private" && input.visibility !== "workspace") ||
      (input.authMode !== undefined && input.authMode !== "oauth" && input.authMode !== "bearer_ref" && input.authMode !== "none") ||
      !validCredentialRef(input.credentialRef ?? null)) return response({ ok: false, error: "invalid_request" }, 400);
    try {
      const server = await createExternalMcpServer(ctx.env, { orgId: ctx.principal.orgId, ownerId: ctx.principal.principal,
        name: typeof input.name === "string" ? input.name : "",
        endpoint: typeof input.url === "string" ? input.url : "",
        credentialRef: (input.credentialRef ?? null) as string | null,
        catalogId: typeof input.catalogId === "string" ? input.catalogId : null,
        connectionLabel: typeof input.connectionLabel === "string" ? input.connectionLabel : null,
        visibility: input.visibility === "workspace" ? "workspace" : "private",
        authMode: input.authMode === "oauth" || input.authMode === "none" ? input.authMode : "bearer_ref",
      });
      return response({ ok: true, server }, 201);
    } catch (error) { return safeError(error); }
  }
  let id: string;
  try { id = decodeURIComponent(part); } catch { return response({ ok: false, error: "invalid_server_id" }, 400); }
  if (id === BUILTIN_ID) return ctx.request.method === "DELETE" || ctx.request.method === "PATCH"
    ? response({ ok: false, error: "mcp_server_read_only" }, 409) : response({ ok: false, error: "mcp_server_not_found" }, 404);
  const server = await getExternalMcpServer(ctx.env, ctx.principal.orgId, ctx.principal.principal, id);
  if (!server) return response({ ok: false, error: "mcp_server_not_found" }, 404);
  const action = match[2] ?? "";
  if (action === "" && ctx.request.method === "PATCH") {
    const input = await body(ctx); if (!input || !knownKeys(input, ["name", "url", "credentialRef"]) ||
      (input.name !== undefined && typeof input.name !== "string") || (input.url !== undefined && typeof input.url !== "string") ||
      (input.credentialRef !== undefined && !validCredentialRef(input.credentialRef))) return response({ ok: false, error: "invalid_request" }, 400);
    try { return response({ ok: true, server: await updateExternalMcpServer(ctx.env, { orgId: server.orgId, ownerId: server.ownerId, id,
      ...(typeof input.name === "string" ? { name: input.name } : {}), ...(typeof input.url === "string" ? { endpoint: input.url } : {}),
      ...(input.credentialRef !== undefined ? { credentialRef: input.credentialRef as string | null } : {}) }) }); }
    catch (error) { return safeError(error); }
  }
  if (action === "" && ctx.request.method === "DELETE") { await disableExternalMcpServer(ctx.env, server); return response({ ok: true, disabled: true }); }
  if (action === "revoke" && ctx.request.method === "POST") {
    try {
      await revokeExternalMcpOAuth(ctx.env, { orgId: server.orgId, ownerId: server.ownerId, serverId: server.id });
      await disableExternalMcpServer(ctx.env, server);
      return response({ ok: true, revoked: true });
    } catch (error) { return safeError(error); }
  }
  if (action === "oauth/begin" && ctx.request.method === "POST") {
    const input = await body(ctx);
    if (!input || !knownKeys(input, ["redirectUri"]) || typeof input.redirectUri !== "string") {
      return response({ ok: false, error: "invalid_request" }, 400);
    }
    if (!server.catalogId || server.authMode !== "oauth") return response({ ok: false, error: "invalid_request" }, 400);
    const vendor = curatedMcpVendorByCatalogId(server.catalogId);
    if (!vendor) return response({ ok: false, error: "invalid_catalog_id" }, 400);
    const clientId = readDeploymentOAuthClientId(ctx.env, server.catalogId);
    if (!clientId) return response({ ok: false, error: "oauth_client_not_configured" }, 503);
    try {
      const discovery = await discoverExternalMcpOAuth(vendor);
      const begin = await beginExternalMcpOAuthConnect(ctx.env, {
        serverId: server.id,
        orgId: server.orgId,
        ownerId: server.ownerId,
        catalogId: server.catalogId,
        redirectUri: input.redirectUri,
        clientId,
        scopes: defaultOAuthScopes(server.catalogId),
        discovery,
      });
      return response({ ok: true, ...begin, discovery: { resource: discovery.resource.resource, issuer: discovery.authorizationServer.issuer } });
    } catch (error) { return safeError(error); }
  }
  if (action === "bearer" && ctx.request.method === "POST") {
    const input = await body(ctx);
    if (!input || !knownKeys(input, ["token"]) || typeof input.token !== "string") {
      return response({ ok: false, error: "invalid_request" }, 400);
    }
    try {
      await saveExternalMcpBearerToken(ctx.env, server.orgId, server.ownerId, server.id, input.token);
      return response({ ok: true });
    } catch (error) { return safeError(error); }
  }
  if (action === "discover" && ctx.request.method === "POST") {
    try { const result = await discoverExternalMcpServer(ctx.env, server); return response({ ok: true, schemaVersion: result.schemaVersion, tools: result.tools }); }
    catch (error) { return safeError(error); }
  }
  if (action === "tools" && ctx.request.method === "GET") return response({ ok: true, tools: await listExternalMcpTools(ctx.env, id), access: await listExternalMcpAccess(ctx.env, server.orgId, id) });

  const toolRoute = action.match(/^tools\/([^/]+)\/(review|enable|disable|grant)$/);
  if (toolRoute && ctx.request.method === "POST") {
    let toolId: string; try { toolId = decodeURIComponent(toolRoute[1]!); } catch { return response({ ok: false, error: "invalid_tool_id" }, 400); }
    const input = await body(ctx); if (!input) return response({ ok: false, error: "invalid_request" }, 400);
    try {
      if (toolRoute[2] === "review") {
        if (!knownKeys(input, ["effect", "schemaVersion"]) || typeof input.effect !== "string" || typeof input.schemaVersion !== "string") throw new Error("invalid_effect_review");
        await reviewExternalMcpTool(ctx.env, server, toolId, input.effect as "read" | "approval_required", input.schemaVersion);
        return response({ ok: true });
      }
      if (toolRoute[2] === "enable" || toolRoute[2] === "disable") {
        if (!knownKeys(input, ["schemaVersion"]) || typeof input.schemaVersion !== "string") return response({ ok: false, error: "invalid_request" }, 400);
        await setExternalMcpToolEnabled(ctx.env, server, toolId, toolRoute[2] === "enable", input.schemaVersion);
        return response({ ok: true });
      }
      if (!knownKeys(input, ["principal", "enabled"]) || typeof input.principal !== "string" || typeof input.enabled !== "boolean" || input.principal.length > 128) return response({ ok: false, error: "invalid_request" }, 400);
      const token = (await listTokens(ctx.env)).find((candidate) => candidate.principal === input.principal && orgIdForRecord(candidate) === server.orgId && !candidate.revoked && candidate.kind !== "api_key");
      if (!token || !token.scopes.includes("mcp:external")) return response({ ok: false, error: "principal_needs_active_mcp_external_scope" }, 409);
      await setExternalMcpAccess(ctx.env, { orgId: server.orgId, ownerId: server.ownerId, serverId: id, toolId,
        principal: input.principal, enabled: input.enabled });
      return response({ ok: true });
    } catch (error) { return safeError(error); }
  }

  if (action === "approvals" && ctx.request.method === "GET") {
    const approvals = await listEmployeeActionApprovals(ctx.env, { orgId: server.orgId, status: "pending", limit: 50 });
    return response({ ok: true, approvals: approvals.filter((item) => item.employeeId === server.id) });
  }
  const approvalMatch = action.match(/^approvals\/([^/]+)$/);
  if (approvalMatch && ctx.request.method === "POST") {
    let approvalId: string; try { approvalId = decodeURIComponent(approvalMatch[1]!); } catch { return response({ ok: false, error: "invalid_approval_id" }, 400); }
    const input = await body(ctx); if (!input || !knownKeys(input, ["approved"]) || typeof input.approved !== "boolean") return response({ ok: false, error: "invalid_request" }, 400);
    const approval = await getEmployeeActionApproval(ctx.env, { orgId: server.orgId, employeeId: server.id, approvalId });
    if (!approval) return response({ ok: false, error: "approval_not_found" }, 404);
    const decided = await decideApproval(ctx.env, { orgId: server.orgId, employeeId: server.id, approvalId, approved: input.approved, decidedBy: ctx.principal.principal });
    if (!decided) return response({ ok: false, error: "approval_not_found" }, 404);
    const status = input.approved ? "approved" : "denied";
    if (decided.status !== status) return response({ ok: false, error: "approval_decision_conflict" }, 409);
    await resolveCapabilityInvocationApproval(ctx.env, { approvalId, status });
    const dispatch = input.approved ? await executeApprovedExternalMcpAction(ctx.env, server, decided) : { status: "denied" };
    return response({ ok: true, approval: decided, dispatch });
  }
  return response({ ok: false, error: "mcp_server_route_not_found" }, 404);
}
