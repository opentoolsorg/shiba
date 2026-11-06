import {
  workspaceIntegrationConnectionsResponseSchema,
  workspaceIntegrationConnectResponseSchema,
  workspaceIntegrationConnectionResponseSchema,
  workspaceIntegrationGrantsResponseSchema,
  workspaceIntegrationActionsResponseSchema,
  workspaceIntegrationApprovalsResponseSchema,
  type WorkspaceIntegrationConnection,
} from "@shiba/shared";
import { teamWorkspaceHeaders } from "./team-workspaces-client";

const BASE = "/api/workspace-integrations";
export class WorkspaceIntegrationRequestError extends Error {
  constructor(public readonly status: number, code?: string) {
    super(code === "workspace_native_session_required" ? "Workspace app sharing requires a verified email sign-in. This identity is not supported for shared app setup."
      : [401, 403, 404].includes(status)
      ? "Workspace access or permission changed. Refresh before continuing."
      : status === 409 ? "This account or grant changed. Refresh and review its current version."
      : status === 503 ? "Workspace apps are unavailable. Ask the operator to check the integration service."
      : "The workspace app request could not be verified.");
  }
}
export const workspaceAccessChanged = (error: unknown) => error instanceof WorkspaceIntegrationRequestError && [401, 403, 404].includes(error.status);
type Parser<T> = { parse(value: unknown): T };

async function request<T extends { workspaceId: string }>(workspaceId: string, path: string, schema: Parser<T>, signal?: AbortSignal, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, { method, credentials: "same-origin", cache: "no-store", redirect: "error", signal,
    headers: { ...teamWorkspaceHeaders(workspaceId), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const failure: unknown = await response.json().catch(() => null);
    const code = failure && typeof failure === "object" && "error" in failure && failure.error === "workspace_native_session_required" ? failure.error : undefined;
    throw new WorkspaceIntegrationRequestError(response.status, code);
  }
  let parsed: T;
  try { parsed = schema.parse(await response.json()); }
  catch { throw new Error("The workspace app response could not be verified. Refresh before continuing."); }
  if (parsed.workspaceId !== workspaceId) throw new Error("The app response belongs to another workspace. Refresh before continuing.");
  return parsed;
}
function connectionScope(connection: WorkspaceIntegrationConnection, workspaceId: string) {
  if (connection.workspaceId !== workspaceId || connection.scope !== "workspace" || !connection.id) throw new Error("The shared account scope could not be verified.");
  return connection;
}

export async function workspaceAppConnections(workspaceId: string, signal?: AbortSignal) {
  const body = await request(workspaceId, "/connections", workspaceIntegrationConnectionsResponseSchema, signal);
  body.connections.forEach((connection) => connectionScope(connection, workspaceId));
  if (new Set(body.connections.map((connection) => connection.id)).size !== body.connections.length) throw new Error("Duplicate workspace account records were reported. Refresh before continuing.");
  return body;
}
export async function beginWorkspaceAppConsent(workspaceId: string, providerKey: string, signal?: AbortSignal) {
  const body = await request(workspaceId, "/connect", workspaceIntegrationConnectResponseSchema, signal, "POST", { providerKey, audienceConsent: "workspace-members" });
  connectionScope(body.connection, workspaceId);
  if (body.connection.providerKey !== providerKey || body.connection.state !== "pending" || !body.pendingId || !/^[a-f0-9]{64}$/.test(body.authorizationFingerprint) || body.connection.authorizationFingerprint !== body.authorizationFingerprint) throw new Error("The new app consent could not be bound to this workspace request.");
  return body;
}
export async function reconcileWorkspaceAppConsent(workspaceId: string, connection: WorkspaceIntegrationConnection, pendingId: string, authorizationFingerprint: string, signal?: AbortSignal) {
  const body = await request(workspaceId, `/connections/${encodeURIComponent(connection.id)}/reconcile`, workspaceIntegrationConnectionResponseSchema, signal, "POST", { expectedVersion: connection.version, pendingId, authorizationFingerprint });
  connectionScope(body.connection, workspaceId);
  if (body.connection.id !== connection.id || body.connection.providerKey !== connection.providerKey || body.connection.generation !== connection.generation || body.connection.version < connection.version || body.connection.authorizationFingerprint !== authorizationFingerprint) throw new Error("The returned account does not match this consent request.");
  return body;
}
export async function disconnectWorkspaceApp(workspaceId: string, connection: WorkspaceIntegrationConnection, signal?: AbortSignal) {
  const body = await request(workspaceId, `/connections/${encodeURIComponent(connection.id)}/disconnect`, workspaceIntegrationConnectionResponseSchema, signal, "POST", { expectedVersion: connection.version });
  connectionScope(body.connection, workspaceId);
  if (body.connection.id !== connection.id || body.connection.providerKey !== connection.providerKey || body.connection.generation !== connection.generation) throw new Error("The disconnected account could not be verified.");
  return body;
}
export async function workspaceAppGrants(workspaceId: string, connectionId: string, signal?: AbortSignal) {
  const body = await request(workspaceId, `/connections/${encodeURIComponent(connectionId)}/grants`, workspaceIntegrationGrantsResponseSchema, signal);
  if (body.connectionId !== connectionId) throw new Error("The grant directory belongs to another account.");
  return body;
}
export interface WorkspaceAppGrantInput {
  employeeId: string; employeeVersion: number; actorId: string; actorMembershipVersion: number;
  expectedConnectionVersion: number; expectedGrantVersion: number | null; permissions: Array<"discover" | "execute">;
}
export async function saveWorkspaceAppGrant(workspaceId: string, connectionId: string, input: WorkspaceAppGrantInput, signal?: AbortSignal) {
  const body = await request(workspaceId, `/connections/${encodeURIComponent(connectionId)}/grants`, workspaceIntegrationGrantsResponseSchema, signal, "PUT", input);
  if (body.connectionId !== connectionId) throw new Error("The grant receipt belongs to another account.");
  const matches = body.grants.filter((grant) => grant.employeeId === input.employeeId && grant.actorId === input.actorId);
  const grant = matches[0], expectedPermissions = [...new Set(input.permissions)].sort();
  if (body.connectionVersion !== input.expectedConnectionVersion || matches.length !== 1 || !grant ||
    grant.employeeVersion !== input.employeeVersion || grant.actorMembershipVersion !== input.actorMembershipVersion ||
    grant.version !== (input.expectedGrantVersion ?? 0) + 1 || grant.state !== (expectedPermissions.length ? "active" : "revoked") ||
    JSON.stringify([...grant.permissions].sort()) !== JSON.stringify(expectedPermissions)) throw new Error("The exact employee and member grant receipt could not be verified. Refresh permissions before another change.");
  return body;
}
export async function workspaceAppActions(workspaceId: string, connectionId: string, employeeId: string, employeeVersion: number, query: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ employeeId, employeeVersion: String(employeeVersion), q: query });
  const body = await request(workspaceId, `/connections/${encodeURIComponent(connectionId)}/actions?${params}`, workspaceIntegrationActionsResponseSchema, signal);
  if (body.connectionId !== connectionId) throw new Error("The action directory belongs to another account.");
  return body;
}
export function workspaceAppApprovals(workspaceId: string, signal?: AbortSignal) {
  return request(workspaceId, "/approvals", workspaceIntegrationApprovalsResponseSchema, signal);
}
export function requestWorkspaceAppAction(workspaceId: string, connectionId: string, input: { employeeId: string; employeeVersion: number; actionId: string; arguments: Record<string, unknown>; requestId: string }, signal?: AbortSignal) {
  return request(workspaceId, `/connections/${encodeURIComponent(connectionId)}/actions/request`, workspaceIntegrationApprovalsResponseSchema, signal, "POST", input);
}
export async function decideWorkspaceAppAction(workspaceId: string, approvalId: string, approved: boolean, signal?: AbortSignal) {
  const body = await request(workspaceId, `/approvals/${encodeURIComponent(approvalId)}/decision`, workspaceIntegrationApprovalsResponseSchema, signal, "POST", { approved });
  if (body.approvalId !== approvalId || !body.approvals.some((approval) => approval.id === approvalId)) throw new Error("The human decision receipt could not be verified. Refresh requests before another action.");
  return body;
}
export async function executeWorkspaceAppAction(workspaceId: string, approvalId: string, signal?: AbortSignal) {
  const body = await request(workspaceId, `/approvals/${encodeURIComponent(approvalId)}/execute`, workspaceIntegrationApprovalsResponseSchema, signal, "POST", {});
  if (body.approvalId !== approvalId || !body.approvals.some((approval) => approval.id === approvalId)) throw new Error("The execution receipt could not be verified. Inspect the outcome before another action.");
  return body;
}
