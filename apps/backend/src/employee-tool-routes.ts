import type { TokenRecord } from "./agent-tokens.js";
import { verifyToken } from "./agent-tokens.js";
import type { Env } from "./env.js";
import { resolveOrgForApiRequest } from "./org-request-auth.js";
import { resolveUserId } from "./request-auth.js";
import { requireV1Read, requireV1Write, v1Forbidden } from "./v1-auth.js";
import { getCustomAgentById, updateCustomAgent } from "./custom-agents-store.js";
import { createToolRegistry, hashToolArgs } from "./mcp-gateway.js";
import { registerAllMcpTools } from "./mcp-tool-registration.js";
import {
  EMPLOYEE_TOOL_POLICY_VERSION,
  capabilityId,
  dispatchEmployeeTool,
  selectEmployeeCapabilities,
  type EmployeeRole,
} from "./employee-tool-policy.js";
import {
  asEmployeeActionApproval,
  decideEmployeeActionApproval,
  findEmployeeActionApproval,
  getEmployeeActionApproval,
  listEmployeeActionApprovals,
  listEmployeeToolGrantRecords,
  replaceEmployeeToolGrants,
  requestEmployeeActionApproval,
  resolveEmployeeConnectionGrant,
  resolveEmployeeToolPolicy,
} from "./employee-tool-store.js";

const MAX_TOOLS = 50;
const APPROVAL_TTL_MS = 15 * 60_000;
const ROLES: readonly EmployeeRole[] = ["owner", "admin", "operator", "member", "viewer"];

/** Only actions with a reviewed input shape and known side-effect contract are dispatchable. */
const ACTIONS = {
  run_status: { risk: "read", requiredScope: "runs:read", resourceArgument: "runId", resourceRequired: true, requiresLiveVerification: false },
  queue_run: { risk: "external_write", requiredScope: "sandbox:exec", resourceArgument: "repoUrl", resourceRequired: true, requiresLiveVerification: false },
  send_email: { risk: "external_write", requiredScope: "email:send", resourceArgument: "mailbox", resourceRequired: true, requiresLiveVerification: false },
} as const;

function jsonError(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status, headers: { "cache-control": "no-store" } });
}

async function parseObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch { return null; }
}

function bearer(request: Request): string | null {
  const value = request.headers.get("authorization");
  if (!value) return null;
  const [scheme, ...rest] = value.trim().split(/\s+/);
  return scheme?.toLowerCase() === "bearer" && rest.length > 0 ? rest.join(" ") : null;
}

function supportedToolId(value: unknown): value is string {
  return typeof value === "string" && Object.hasOwn(ACTIONS, value.slice("mcp:shiba:".length)) && value.startsWith("mcp:shiba:");
}

function connectionPolicy(toolName: keyof typeof ACTIONS) {
  const id = capabilityId(toolName);
  const action = ACTIONS[toolName];
  return {
    version: "employee-policy-current",
    allowlist: [{ kind: "mcp" as const, id }],
    actions: [{
      capability: { kind: "mcp" as const, id }, action: toolName, risk: action.risk,
      requiredProviderScopes: [], resourceRequired: action.resourceRequired,
      resourceArgument: action.resourceArgument, requiresLiveVerification: action.requiresLiveVerification,
    }],
  };
}

async function configurePolicy(request: Request, env: Env, employeeId: string): Promise<Response> {
  if (!env.AGENT_AUDIT) return jsonError("employee_policy_storage_unavailable", 503);
  const auth = await resolveOrgForApiRequest(request, env);
  if (auth instanceof Response) return auth;
  if (auth.principal && !requireV1Write(auth.principal)) return v1Forbidden();
  const configurer = auth.principal?.principal ?? await resolveUserId(request, env);
  if (!configurer) return jsonError("authentication_required", 401);
  const body = await parseObject(request);
  if (!body || !Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1 ||
      typeof body.actorId !== "string" || !body.actorId.trim() || body.actorId.length > 128 ||
      typeof body.role !== "string" || !ROLES.includes(body.role as EmployeeRole) ||
      typeof body.resourcesByCapability !== "object" || body.resourcesByCapability === null || Array.isArray(body.resourcesByCapability)) {
    return jsonError("invalid_employee_tool_policy", 400);
  }
  const profile = await getCustomAgentById(env, auth.orgId, employeeId);
  if (!profile) return jsonError("not_found", 404);
  if (profile.version !== Number(body.expectedVersion)) return jsonError("version_conflict", 409);
  const resourcesByCapability = body.resourcesByCapability as Record<string, unknown>;
  const entries = Object.entries(resourcesByCapability);
  if (entries.length > MAX_TOOLS || entries.some(([id, resources]) =>
    !supportedToolId(id) || !Array.isArray(resources) || resources.length < 1 || resources.length > 100 ||
    !resources.every((resource) => typeof resource === "string" && resource.trim() && resource.length <= 200),
  )) return jsonError("unsupported_or_invalid_capability_grants", 400);
  const catalog = createToolRegistry(env);
  registerAllMcpTools(catalog, env);
  for (const [id] of entries) {
    const toolName = id.slice("mcp:shiba:".length) as keyof typeof ACTIONS;
    const registered = catalog.tools().find((tool) => tool.name === toolName);
    if (!registered || registered.scope !== ACTIONS[toolName].requiredScope) return jsonError("unsupported_employee_tool_action", 400);
  }
  const toolScopes = entries.map(([id]) => id).sort();
  const updated = await updateCustomAgent(env, auth.orgId, employeeId, { ...profile.config, toolScopes }, profile.version);
  try {
    await replaceEmployeeToolGrants(env, {
      orgId: auth.orgId, employeeId, employeeVersion: updated.version, actorId: body.actorId,
      role: body.role as EmployeeRole,
      capabilityIds: toolScopes,
      resourcesByCapability: resourcesByCapability as Record<string, readonly string[]>,
    });
  } catch (error) {
    // Config scopes alone never authorize dispatch; a failed grant write leaves
    // the employee safely unusable until this versioned endpoint is retried.
    return jsonError(error instanceof Error ? error.message : "employee_tool_grant_write_failed", 400);
  }
  return Response.json({ ok: true, employeeId, employeeVersion: updated.version, actorId: body.actorId,
    role: body.role, toolScopes }, { headers: { "cache-control": "no-store" } });
}

async function readPolicy(request: Request, env: Env, employeeId: string): Promise<Response> {
  if (!env.AGENT_AUDIT) return jsonError("employee_policy_storage_unavailable", 503);
  const auth = await resolveOrgForApiRequest(request, env);
  if (auth instanceof Response) return auth;
  if (auth.principal && !requireV1Read(auth.principal)) return v1Forbidden();
  const profile = await getCustomAgentById(env, auth.orgId, employeeId, { includeArchived: true });
  if (!profile) return jsonError("not_found", 404);
  const grants = await listEmployeeToolGrantRecords(env, {
    orgId: auth.orgId, employeeId, employeeVersion: profile.version,
  });
  return Response.json({ ok: true, employeeId, employeeVersion: profile.version,
    toolScopes: profile.config.toolScopes ?? [], grants: grants.map(({ subjectType, subjectId, capabilityId, resourceId, lifecycle, updatedAt }) => ({
      subjectType, subjectId, capabilityId, resourceId, lifecycle, updatedAt,
    })) }, { headers: { "cache-control": "no-store" } });
}

async function callEmployeeTool(request: Request, env: Env, employeeId: string): Promise<Response> {
  if (!env.AGENT_AUDIT) return jsonError("employee_policy_storage_unavailable", 503);
  const rawToken = bearer(request);
  if (!rawToken) return jsonError("mcp_agent_token_required", 401);
  const principal = await verifyToken(env, rawToken);
  if (!principal || principal.kind !== "agent" || principal.revoked || !principal.orgId) return jsonError("active_mcp_agent_required", 401);
  const body = await parseObject(request);
  if (!body || typeof body.tool !== "string" || typeof body.args !== "object" || body.args === null || Array.isArray(body.args)) {
    return jsonError("invalid_employee_tool_call", 400);
  }
  const args = body.args as Record<string, unknown>;
  if (!Object.hasOwn(ACTIONS, body.tool)) return jsonError("unsupported_employee_tool_action", 400);
  const toolName = body.tool as keyof typeof ACTIONS;
  const employee = await getCustomAgentById(env, principal.orgId, employeeId);
  if (!employee) return jsonError("not_found", 404);
  const policyState = await resolveEmployeeToolPolicy(env, {
    orgId: principal.orgId, employeeId, employeeVersion: employee.version, actorId: principal.principal,
  });
  if (!policyState) return jsonError("employee_membership_or_grants_missing", 403);
  const registry = createToolRegistry(env);
  registerAllMcpTools(registry, env);
  const registeredTools = registry.tools();
  const targetTool = registeredTools.find((tool) => tool.name === toolName);
  if (!targetTool || targetTool.scope !== ACTIONS[toolName].requiredScope) return jsonError("unsupported_employee_tool_action", 400);
  const authority = {
    principal,
    workspaceId: principal.orgId,
    employeeId,
    employeeVersion: employee.version,
    employeeRole: policyState.role,
    workspaceCapabilityIds: policyState.workspaceCapabilityIds,
    actorCapabilityIds: policyState.actorCapabilityIds,
    roleCapabilityIds: policyState.roleCapabilityIds,
    employeeCapabilityIds: employee.config.toolScopes ?? [],
    registeredTools,
  };
  const selection = selectEmployeeCapabilities(authority);
  const id = capabilityId(toolName);
  const resourceKey = ACTIONS[toolName].resourceArgument;
  const resourceId = args[resourceKey];
  if (typeof resourceId !== "string" || !resourceId.trim() || resourceId.length > 200) return jsonError("invalid_resource_id", 400);
  const connection = await resolveEmployeeConnectionGrant(env, {
    orgId: principal.orgId, employeeId, employeeVersion: employee.version, actorId: principal.principal,
    capabilityId: id, resourceId,
  });
  if (!connection) return jsonError("employee_connection_or_resource_grant_missing", 403);
  const policy = connectionPolicy(toolName);

  let approval;
  if (ACTIONS[toolName].risk === "external_write") {
    const argumentDigest = await hashToolArgs(args);
    const saved = await findEmployeeActionApproval(env, {
      orgId: principal.orgId, employeeId, employeeVersion: employee.version, actorId: principal.principal,
      capabilityId: id, action: toolName, argumentDigest, resourceId,
      connectionGeneration: connection.generation,
    });
    if (!saved || saved.status === "denied" || saved.status === "expired") {
      const pending = await requestEmployeeActionApproval(env, {
        orgId: principal.orgId, employeeId, employeeVersion: employee.version, actorId: principal.principal,
        connectionId: connection.connectionId, connectionGeneration: connection.generation,
        capability: { kind: "mcp", id }, action: toolName, resourceId,
        ...(connection.accountId ? { accountId: connection.accountId } : {}), argumentDigest,
        payload: args, policyVersion: policy.version, expiresAt: Date.now() + APPROVAL_TTL_MS,
      });
      return Response.json({ ok: true, status: "pending_approval", approvalId: pending.approvalId,
        employeeId, employeeVersion: employee.version, tool: toolName }, { status: 202, headers: { "cache-control": "no-store" } });
    }
    if (saved.status !== "approved") return Response.json({ ok: true, status: saved.status, approvalId: saved.approvalId }, { status: 202, headers: { "cache-control": "no-store" } });
    approval = asEmployeeActionApproval(saved);
  }
  const result = await dispatchEmployeeTool({
    registry, authority, selection, toolName, args, connection,
    connectionPolicy: policy, ...(approval ? { approval } : {}),
    ...(approval ? { idempotencyKey: `employee-action:${approval.approvalId}` } : {}),
  });
  if (!result.allowed) return jsonError(result.reason, result.reason === "approval_required" ? 202 : 403);
  return Response.json({ ok: true, result: result.result }, { headers: { "cache-control": "no-store" } });
}

async function handleApprovals(request: Request, env: Env, approvalId?: string): Promise<Response> {
  if (!env.AGENT_AUDIT) return jsonError("employee_policy_storage_unavailable", 503);
  const auth = await resolveOrgForApiRequest(request, env);
  if (auth instanceof Response) return auth;
  if (auth.principal && (request.method === "GET" ? !requireV1Read(auth.principal) : !requireV1Write(auth.principal))) return v1Forbidden();
  // Payload previews can contain email text or repository tasks; only the
  // authenticated dashboard operator sees or decides these exact records.
  if (auth.principal) return v1Forbidden();
  if (request.method === "GET" && !approvalId) {
    const rows = await listEmployeeActionApprovals(env, { orgId: auth.orgId, status: "pending", limit: 50 });
    return Response.json({ ok: true, approvals: rows }, { headers: { "cache-control": "no-store" } });
  }
  if (request.method === "POST" && approvalId) {
    const body = await parseObject(request);
    if (!body || typeof body.approved !== "boolean") return jsonError("invalid_approval_decision", 400);
    const record = await getEmployeeActionApproval(env, {
      orgId: auth.orgId, employeeId: typeof body.employeeId === "string" ? body.employeeId : "", approvalId,
    });
    if (!record) return jsonError("not_found", 404);
    const decidedBy = await resolveUserId(request, env);
    if (!decidedBy) return jsonError("authentication_required", 401);
    const decided = await decideEmployeeActionApproval(env, {
      orgId: auth.orgId, employeeId: record.employeeId, approvalId,
      approved: body.approved, decidedBy,
    });
    if (!decided || decided.status === "pending" || decided.status === "expired") return jsonError("approval_not_decidable", 409);
    return Response.json({ ok: true, approvalId, status: decided.status, decidedAt: decided.decidedAt }, { headers: { "cache-control": "no-store" } });
  }
  return jsonError("method_not_allowed", 405);
}

/** Authenticated local employee policy, approval and tool-call endpoints. */
export async function handleEmployeeTools(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/employee-tools")) return null;
  const approvalMatch = url.pathname.match(/^\/api\/employee-tools\/approvals(?:\/([^/]+))?\/?$/);
  if (approvalMatch) {
    let approvalId: string | undefined;
    try { approvalId = approvalMatch[1] ? decodeURIComponent(approvalMatch[1]) : undefined; }
    catch { return jsonError("invalid_approval_id", 400); }
    if (request.method === "GET" && !approvalId || request.method === "POST" && approvalId) return handleApprovals(request, env, approvalId);
    return jsonError("method_not_allowed", 405);
  }
  const match = url.pathname.match(/^\/api\/employee-tools\/([^/]+)\/(policy|call)\/?$/);
  if (!match) return jsonError("not_found", 404);
  let employeeId: string;
  try { employeeId = decodeURIComponent(match[1]!); } catch { return jsonError("invalid_employee_id", 400); }
  if (!employeeId || /[/\\]/.test(employeeId) || employeeId.length > 120) return jsonError("invalid_employee_id", 400);
  if (match[2] === "policy" && request.method === "GET") return readPolicy(request, env, employeeId);
  if (match[2] === "policy" && request.method === "PUT") return configurePolicy(request, env, employeeId);
  if (match[2] === "call" && request.method === "POST") return callEmployeeTool(request, env, employeeId);
  return jsonError("method_not_allowed", 405);
}
