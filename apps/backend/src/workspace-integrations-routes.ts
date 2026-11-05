import { z } from "zod";
import { IntegrationActionInputPolicyError, CREDENTIAL_INPUT_UNAVAILABLE } from "./integrations/action-input-policy.js";
import type { Env } from "./env.js";
import { resolveOrgForApiRequest } from "./org-request-auth.js";
import { rejectCrossOriginMutation } from "./dashboard-mutation.js";
import { getIntegrationProvider } from "./integrations/runtime.js";
import {
  WorkspaceIntegrationError, assertWorkspaceMemberCurrent, connectionDto, createWorkspaceConnection,
  disconnectWorkspaceConnection, listWorkspaceConnections, reconcileWorkspaceConnection, saveWorkspaceGrant, workspaceGrantDirectory,
} from "./workspace-integrations-store.js";
import { decideWorkspaceAction, discoverWorkspaceActions, executeWorkspaceAction, listWorkspaceApprovals, requestWorkspaceAction } from "./workspace-integration-actions.js";
import { resolveWorkspaceNativeMember, type WorkspaceNativeMember } from "./workspace-native-authority.js";

const BASE = "/api/workspace-integrations";
const positive = z.number().int().positive();
const service = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const connect = z.object({ providerKey: service, audienceConsent: z.literal("workspace-members") }).strict();
const reconcile = z.object({ expectedVersion: positive, pendingId: z.string().max(100), authorizationFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const disconnect = z.object({ expectedVersion: positive }).strict();
const grant = z.object({ employeeId: z.string().min(1).max(120), employeeVersion: positive, actorId: z.string().email().max(254),
  actorMembershipVersion: positive, expectedConnectionVersion: positive, expectedGrantVersion: positive.nullable(),
  permissions: z.array(z.enum(["discover", "execute"])).max(2) }).strict();
const action = z.object({ employeeId: z.string().min(1).max(120), employeeVersion: positive, actionId: z.string().min(1).max(200),
  arguments: z.record(z.string(), z.unknown()), requestId: z.string().uuid() }).strict();
const decision = z.object({ approved: z.boolean() }).strict();
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
async function body(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length;
      if (length > 48_000) throw new WorkspaceIntegrationError("workspace_request_too_large", 413); chunks.push(part.value); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) { if (error instanceof WorkspaceIntegrationError) throw error; throw new WorkspaceIntegrationError("workspace_request_invalid", 400); }
  finally { await reader.cancel().catch(() => {}); }
}
async function parse<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const result = schema.safeParse(await body(request));
  if (!result.success) throw new WorkspaceIntegrationError("workspace_request_invalid", 400);
  return result.data;
}
function sameMember(left: WorkspaceNativeMember, right: WorkspaceNativeMember | null) {
  return right && left.accountId === right.accountId && left.workspaceId === right.workspaceId && left.userId === right.userId && left.role === right.role && left.version === right.version;
}
/** Native authenticated workspace members only; public API credentials cannot select this audience. */
export async function handleWorkspaceIntegrations(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`)) return null;
  if (!request.headers.has("X-Shiba-Workspace") || url.searchParams.has("workspaceId")) return json({ error: "workspace_selector_required" }, 400);
  if (!["GET", "HEAD"].includes(request.method)) { const blocked = rejectCrossOriginMutation(request); if (blocked) return blocked; }
  const auth = await resolveOrgForApiRequest(request, env, { allowMemberWrite: true });
  if (auth instanceof Response) return auth;
  if (!auth.workspace || auth.principal || auth.orgId !== `team:${auth.workspace.workspaceId}`) return json({ error: "native_workspace_session_required" }, 403);
  const member = await resolveWorkspaceNativeMember(request, env, auth.workspace);
  if (!member) return json({ error: "workspace_native_session_required", detail: "Workspace-shared accounts currently require a verified native account. Access-only identities are unavailable for this scope." }, 403);
  try {
    const suffix = url.pathname.slice(BASE.length);
    const sourceFencedDiscovery = request.method === "GET" && /^\/connections\/wci_[a-f0-9]{32}\/actions$/.test(suffix);
    const verifyCurrentSession = async () => {
      const latest = await resolveOrgForApiRequest(request, env, { allowMemberWrite: true });
      if (latest instanceof Response) throw new WorkspaceIntegrationError("workspace_authority_changed", latest.status === 401 ? 401 : 403);
      const current = latest.workspace && !latest.principal ? await resolveWorkspaceNativeMember(request, env, latest.workspace) : null;
      if (!sameMember(member, current)) throw new WorkspaceIntegrationError("workspace_authority_changed", 403);
    };
    const result = await dispatch(request, env, member, url, sourceFencedDiscovery ? verifyCurrentSession : undefined);
    if (sourceFencedDiscovery) return result;
    const approvalsResponse = suffix === "/approvals" || /^\/approvals\/wca_[a-f0-9]{32}\/(decision|execute)$/.test(suffix) || /^\/connections\/wci_[a-f0-9]{32}\/actions\/request$/.test(suffix);
    const receipt = approvalsResponse ? await result.json() as { approvalId?: string } : null;
    const latest = await resolveOrgForApiRequest(request, env, { allowMemberWrite: true });
    if (latest instanceof Response) return latest;
    const current = latest.workspace && !latest.principal ? await resolveWorkspaceNativeMember(request, env, latest.workspace) : null;
    if (!sameMember(member, current)) return json({ error: "workspace_authority_changed" }, 403);
    if (approvalsResponse) return json({ ...await listWorkspaceApprovals(env, member), ...(receipt?.approvalId ? { approvalId: receipt.approvalId } : {}) }, result.status);
    if (suffix === "/connections" && request.method === "GET") return json(await listWorkspaceConnections(env, member));
    return result;
  } catch (error) {
    if (error instanceof WorkspaceIntegrationError) return json({ error: error.code }, error.status);
    if (error instanceof IntegrationActionInputPolicyError) return json({ error: CREDENTIAL_INPUT_UNAVAILABLE }, 409);
    return json({ error: "workspace_integrations_unavailable" }, 503);
  }
}
async function dispatch(request: Request, env: Env, member: WorkspaceNativeMember, url: URL, beforeSourceReturn?: () => Promise<void>): Promise<Response> {
  const suffix = url.pathname.slice(BASE.length);
  if (suffix === "/connections" && request.method === "GET") return json({ ok: true, workspaceId: member.workspaceId });
  if (suffix === "/catalog" && request.method === "GET") {
    await assertWorkspaceMemberCurrent(env, member, true);
    const result = await getIntegrationProvider(env).listCatalog({ userId: member.userId, workspaceId: member.workspaceId,
      query: (url.searchParams.get("query") ?? "").slice(0, 200), limit: Math.max(1, Math.min(50, Number(url.searchParams.get("limit")) || 20)), cursor: url.searchParams.get("cursor") ?? undefined });
    await assertWorkspaceMemberCurrent(env, member, true);
    return json({ ok: true, workspaceId: member.workspaceId, provider: "openconnector", ...result });
  }
  if (suffix === "/connect" && request.method === "POST") {
    const input = await parse(request, connect), result = await createWorkspaceConnection(env, member, input.providerKey, url.origin);
    return json({ ok: true, workspaceId: member.workspaceId, connection: await connectionDto(env, result.row), pendingId: result.pendingId,
      authorizationFingerprint: result.authorizationFingerprint, redirectUrl: result.redirectUrl }, 201);
  }
  const connection = /^\/connections\/(wci_[a-f0-9]{32})\/(reconcile|disconnect|grants|actions(?:\/request)?)$/.exec(suffix);
  if (connection) {
    const connectionId = connection[1]!, operation = connection[2]!;
    if (operation === "reconcile" && request.method === "POST") {
      const input = await parse(request, reconcile);
      const row = await reconcileWorkspaceConnection(env, member, connectionId, input.expectedVersion, input.pendingId, input.authorizationFingerprint);
      return json({ ok: true, workspaceId: member.workspaceId, connection: await connectionDto(env, row, true) });
    }
    if (operation === "disconnect" && request.method === "POST") {
      const input = await parse(request, disconnect), row = await disconnectWorkspaceConnection(env, member, connectionId, input.expectedVersion);
      return json({ ok: true, workspaceId: member.workspaceId, connection: await connectionDto(env, row) });
    }
    if (operation === "grants" && request.method === "GET") return json(await workspaceGrantDirectory(env, member, connectionId));
    if (operation === "grants" && request.method === "PUT") return json(await saveWorkspaceGrant(env, member, connectionId, await parse(request, grant)));
    if (operation === "actions" && request.method === "GET") {
      const employeeId = url.searchParams.get("employeeId") ?? "", employeeVersion = Number(url.searchParams.get("employeeVersion"));
      if (!employeeId || !Number.isSafeInteger(employeeVersion) || employeeVersion < 1) throw new WorkspaceIntegrationError("workspace_employee_version_required", 400);
      return json(await discoverWorkspaceActions(env, member, connectionId, employeeId, employeeVersion, (url.searchParams.get("q") ?? "").slice(0, 200), beforeSourceReturn));
    }
    if (operation === "actions/request" && request.method === "POST") {
      const input = await parse(request, action);
      if (new TextEncoder().encode(JSON.stringify(input.arguments)).length > 32_000) throw new WorkspaceIntegrationError("workspace_arguments_too_large", 413);
      const approvalId = await requestWorkspaceAction(env, member, connectionId, input);
      return json({ ok: true, workspaceId: member.workspaceId, approvalId }, 202);
    }
  }
  if (suffix === "/approvals" && request.method === "GET") return json({ ok: true, workspaceId: member.workspaceId });
  const approval = /^\/approvals\/(wca_[a-f0-9]{32})\/(decision|execute)$/.exec(suffix);
  if (approval && request.method === "POST") {
    if (approval[2] === "decision") {
      const input = await parse(request, decision), approvalId = await decideWorkspaceAction(env, member, approval[1]!, input.approved);
      return json({ ok: true, workspaceId: member.workspaceId, approvalId });
    }
    await parse(request, z.object({}).strict());
    const approvalId = await executeWorkspaceAction(env, member, approval[1]!, request.signal);
    return json({ ok: true, workspaceId: member.workspaceId, approvalId });
  }
  return json({ error: "workspace_integration_route_unavailable" }, 404);
}
