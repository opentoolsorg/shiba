import type { TokenRecord } from "./agent-tokens.js";
import { verifyToken } from "./agent-tokens.js";
import type { Env } from "./env.js";
import { resolveOrgForApiRequest } from "./org-request-auth.js";
import { resolveUserId } from "./request-auth.js";
import { gmailOwner } from "./gmail-routes.js";
import { isGmailConnectionActive, readGmailForEmployee, resolveGmailResourceCandidates } from "./gmail.js";
import { requireV1Read, requireV1Write, v1Forbidden } from "./v1-auth.js";
import { getCustomAgentById, updateCustomAgent } from "./custom-agents-store.js";
import { createToolRegistry, hashToolArgs, type ToolRegistry } from "./mcp-gateway.js";
import {
  EMPLOYEE_ACTION_IDEMPOTENCY_PREFIX,
  claimEmployeeActionInvocation,
  getCapabilityInvocationByIdempotencyKey,
} from "./capability-invocations.js";
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
const EMPLOYEE_CLAIM_META = "com.shiba/employee-action-claim";
const ROLES: readonly EmployeeRole[] = ["owner", "admin", "operator", "member", "viewer"];
type EmployeeToolResult = Awaited<ReturnType<ToolRegistry["invoke"]>>;

/** Only actions with a reviewed input shape and known side-effect contract are dispatchable. */
export const EMPLOYEE_TOOL_ACTIONS = {
  gmail_read: { risk: "read", requiredScope: "gmail:read", resourceArgument: "messageIds", resourceRequired: true, requiresLiveVerification: false },
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
  return typeof value === "string" && Object.hasOwn(EMPLOYEE_TOOL_ACTIONS, value.slice("mcp:shiba:".length)) && value.startsWith("mcp:shiba:");
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) return true;
  }
  return false;
}

function connectionPolicy(toolName: keyof typeof EMPLOYEE_TOOL_ACTIONS) {
  const id = capabilityId(toolName);
  const action = EMPLOYEE_TOOL_ACTIONS[toolName];
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

function employeeClaimFailure(reason: string): EmployeeToolResult {
  return {
    content: [{ type: "text", text: `Employee action was not dispatched: ${reason}.` }],
    isError: true,
    _meta: { [EMPLOYEE_CLAIM_META]: { reason } },
  };
}

function employeeReceiptReplay(receipt: { invocationId: string; status: string; approvalId?: string }): EmployeeToolResult {
  return {
    content: [{ type: "text", text: `Request replay suppressed; inspect invocation ${receipt.invocationId} for its recorded status.` }],
    _meta: { "com.shiba/invocation": {
      invocationId: receipt.invocationId, status: receipt.status,
      ...(receipt.approvalId ? { approvalId: receipt.approvalId } : {}), replayed: true,
    } },
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
    const toolName = id.slice("mcp:shiba:".length) as keyof typeof EMPLOYEE_TOOL_ACTIONS;
    const registered = catalog.tools().find((tool) => tool.name === toolName);
    if (!registered || registered.scope !== EMPLOYEE_TOOL_ACTIONS[toolName].requiredScope) return jsonError("unsupported_employee_tool_action", 400);
  }
  const toolScopes = entries.map(([id]) => id).sort();
  const resourceConnectionsByCapability: Record<string, Record<string, string>> = {};
  const resourceAccountsByCapability: Record<string, Record<string, string>> = {};
  const gmailCapability = "mcp:shiba:gmail_read";
  if (Object.hasOwn(resourcesByCapability, gmailCapability)) {
    const owner = await gmailOwner(request, env);
    if (!owner) return jsonError("authenticated_gmail_owner_required", 401);
    const ids = resourcesByCapability[gmailCapability];
    if (!Array.isArray(ids) || ids.length > 25 || !ids.every((id) => typeof id === "string")) return jsonError("invalid_gmail_resource_selection", 400);
    const fromSearch = new Map<string, string>();
    try {
      if (ids.length) for (const [id, connectionId] of await resolveGmailResourceCandidates(env, owner, ids as string[])) fromSearch.set(id, connectionId);
    } catch {
      // Existing grants may be retained after discovery expires; new IDs must come from discovery.
    }
    const existing = await listEmployeeToolGrantRecords(env, { orgId: auth.orgId, employeeId, employeeVersion: profile.version });
    for (const resourceId of ids as string[]) {
      let connectionId = fromSearch.get(resourceId);
      if (!connectionId) {
        const previous = existing.filter((grant) => grant.capabilityId === gmailCapability && grant.resourceId === resourceId && grant.lifecycle === "active");
        if (previous.length !== 3 || previous.some((grant) => grant.accountId !== owner || grant.connectionId !== previous[0]!.connectionId)) {
          return jsonError("gmail_resource_not_selected_or_discovery_expired", 403);
        }
        connectionId = previous[0]!.connectionId;
      }
      if (!(await isGmailConnectionActive(env, owner, connectionId))) return jsonError("gmail_connection_disconnected", 403);
      resourceConnectionsByCapability[gmailCapability] ??= {};
      resourceAccountsByCapability[gmailCapability] ??= {};
      resourceConnectionsByCapability[gmailCapability]![resourceId] = connectionId;
      resourceAccountsByCapability[gmailCapability]![resourceId] = owner;
    }
  }
  const updated = await updateCustomAgent(env, auth.orgId, employeeId, { ...profile.config, toolScopes }, profile.version);
  try {
    await replaceEmployeeToolGrants(env, {
      orgId: auth.orgId, employeeId, employeeVersion: updated.version, actorId: body.actorId,
      role: body.role as EmployeeRole,
      capabilityIds: toolScopes,
      resourcesByCapability: resourcesByCapability as Record<string, readonly string[]>,
      resourceConnectionsByCapability,
      resourceAccountsByCapability,
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
  return dispatchEmployeeToolForPrincipal(env, employeeId, principal, body.tool, body.args as Record<string, unknown>);
}

/** Worker-only dispatch for an already vouched external or employee-run identity. */
export async function dispatchEmployeeToolForPrincipal(
  env: Env,
  employeeId: string,
  principal: TokenRecord,
  toolNameRaw: string,
  args: Record<string, unknown>,
  executionContextId?: string,
): Promise<Response> {
  if (principal.kind !== "agent" || principal.revoked || !principal.orgId || !principal.principal) {
    return jsonError("active_employee_agent_required", 401);
  }
  if (executionContextId !== undefined && (!executionContextId.trim() || executionContextId.length > 200 || hasControlCharacters(executionContextId))) {
    return jsonError("invalid_employee_execution_context", 400);
  }
  if (!Object.hasOwn(EMPLOYEE_TOOL_ACTIONS, toolNameRaw)) return jsonError("unsupported_employee_tool_action", 400);
  const toolName = toolNameRaw as keyof typeof EMPLOYEE_TOOL_ACTIONS;
  const action = EMPLOYEE_TOOL_ACTIONS[toolName];
  const orgId = principal.orgId;
  const actorId = principal.principal;
  const employee = await getCustomAgentById(env, orgId, employeeId);
  if (!employee) return jsonError("not_found", 404);
  const policyState = await resolveEmployeeToolPolicy(env, {
    orgId, employeeId, employeeVersion: employee.version, actorId,
  });
  if (!policyState) return jsonError("employee_membership_or_grants_missing", 403);
  const registry = createToolRegistry(env);
  registerAllMcpTools(registry, env);
  const registeredTools = registry.tools();
  const targetTool = registeredTools.find((tool) => tool.name === toolName);
  if (!targetTool || targetTool.scope !== action.requiredScope) return jsonError("unsupported_employee_tool_action", 400);
  const authority = {
    principal,
    workspaceId: orgId,
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
  const resourceKey = action.resourceArgument;
  const gmailIds = toolName === "gmail_read" ? args[resourceKey] : undefined;
  let resourceId: string;
  let connection;
  if (toolName === "gmail_read") {
    if (!Array.isArray(gmailIds) || gmailIds.length < 1 || gmailIds.length > 25 ||
        gmailIds.some((value) => typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) || new Set(gmailIds).size !== gmailIds.length) {
      return jsonError("invalid_gmail_resource_ids", 400);
    }
    resourceId = gmailIds[0] as string;
    const grants = [];
    for (const selectedId of gmailIds as string[]) {
      const grant = await resolveEmployeeConnectionGrant(env, { orgId, employeeId, employeeVersion: employee.version, actorId,
        capabilityId: id, resourceId: selectedId });
      if (!grant || !grant.accountId || !(await isGmailConnectionActive(env, grant.accountId, grant.connectionId))) {
        return jsonError("employee_connection_or_resource_grant_missing", 403);
      }
      grants.push(grant);
    }
    const first = grants[0]!;
    if (grants.some((grant) => grant.connectionId !== first.connectionId || grant.accountId !== first.accountId || grant.generation !== first.generation)) {
      return jsonError("gmail_resources_span_connections", 403);
    }
    connection = { ...first, allowedResources: [...gmailIds] };
  } else {
    if (typeof args[resourceKey] !== "string" || !(args[resourceKey] as string).trim() || (args[resourceKey] as string).length > 200) return jsonError("invalid_resource_id", 400);
    resourceId = args[resourceKey] as string;
    connection = await resolveEmployeeConnectionGrant(env, {
      orgId, employeeId, employeeVersion: employee.version, actorId,
      capabilityId: id, resourceId,
    });
  }
  if (!connection) return jsonError("employee_connection_or_resource_grant_missing", 403);
  const policy = connectionPolicy(toolName);

  let approval;
  if (action.risk === "external_write") {
    const argumentDigest = await hashToolArgs(args);
    const saved = await findEmployeeActionApproval(env, {
      orgId, employeeId, employeeVersion: employee.version, actorId,
      capabilityId: id, action: toolName, argumentDigest, resourceId,
      connectionGeneration: connection.generation, now: Date.now(),
      ...(executionContextId ? { executionContextId } : {}),
    });
    if (!saved || saved.status === "denied" || saved.status === "expired") {
      const pending = await requestEmployeeActionApproval(env, {
        orgId: principal.orgId, employeeId, employeeVersion: employee.version, actorId: principal.principal,
        connectionId: connection.connectionId, connectionGeneration: connection.generation,
        capability: { kind: "mcp", id }, action: toolName, resourceId,
        ...(executionContextId ? { executionContextId } : {}),
        ...(connection.accountId ? { accountId: connection.accountId } : {}), argumentDigest,
        payload: args, policyVersion: policy.version, expiresAt: Date.now() + APPROVAL_TTL_MS,
      });
      const { notifyEmployeeToolApprovalInChat } = await import("./chat-employee.js");
      await notifyEmployeeToolApprovalInChat(env, {
        approvalId: pending.approvalId,
        employeeId,
        action: toolName,
        payload: args,
        executionContextId,
        orgId: principal.orgId,
        employeeLabel: employee.config.name?.trim() || employee.slug,
      }).catch(() => undefined);
      return Response.json({ ok: true, status: "pending_approval", approvalId: pending.approvalId,
        employeeId, employeeVersion: employee.version, tool: toolName }, { status: 202, headers: { "cache-control": "no-store" } });
    }
    if (saved.status !== "approved") return Response.json({ ok: true, status: saved.status, approvalId: saved.approvalId }, { status: 202, headers: { "cache-control": "no-store" } });
    const idempotencyKey = `${EMPLOYEE_ACTION_IDEMPOTENCY_PREFIX}${saved.approvalId}`;
    if (Date.now() >= saved.expiresAt) {
      const receipt = await getCapabilityInvocationByIdempotencyKey(env, {
        orgId, principal: actorId, idempotencyKey,
      });
      if (!receipt) return jsonError(saved.consumedAt !== undefined || saved.consumedInvocationId
        ? "employee_invocation_receipt_pruned_no_replay"
        : "employee_approval_expired_retry_for_consent", 409);
      if (receipt.tool !== toolName || receipt.argsHash !== await hashToolArgs(args)) {
        return jsonError("employee_invocation_payload_conflict", 409);
      }
      // Expired approvals with receipts can only return the frozen receipt.
      // Never re-enter dispatch: a receipt may describe a write whose outcome
      // is unknown, or a Shiba approval that is still being processed.
      return Response.json({ ok: true, result: {
        content: [{ type: "text", text: `Request replay suppressed; inspect invocation ${receipt.invocationId} for its recorded status.` }],
        _meta: { "com.shiba/invocation": {
          invocationId: receipt.invocationId, status: receipt.status,
          ...(receipt.approvalId ? { approvalId: receipt.approvalId } : {}), replayed: true,
        } },
      } }, { headers: { "cache-control": "no-store" } });
    }
    approval = asEmployeeActionApproval(saved);
  }
  const registeredDispatchRegistry: Pick<ToolRegistry, "invoke"> = toolName === "gmail_read" ? { invoke: async (_name, toolArgs) => {
    const currentIds = (toolArgs as Record<string, unknown>).messageIds as string[];
    const freshEmployee = await getCustomAgentById(env, orgId, employeeId);
    if (!freshEmployee || freshEmployee.version !== employee.version) throw new Error("Employee policy changed.");
    const data = await readGmailForEmployee(env, connection.accountId!, connection.connectionId, actorId, currentIds, async (selectedId) => {
      const current = await resolveEmployeeConnectionGrant(env, { orgId, employeeId, employeeVersion: employee.version, actorId,
        capabilityId: id, resourceId: selectedId });
      return Boolean(current && current.connectionId === connection.connectionId && current.accountId === connection.accountId &&
        await isGmailConnectionActive(env, connection.accountId!, connection.connectionId));
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
  } } : registry;
  const approvedAction = approval;
  const dispatchRegistry: Pick<ToolRegistry, "invoke"> = approvedAction ? {
    invoke: async (name, toolArgs, callPrincipal, options) => {
      const idempotencyKey = options?.idempotencyKey;
      if (!idempotencyKey) return employeeClaimFailure("missing idempotency key");
      const claim = await claimEmployeeActionInvocation(env, {
        approvalId: approvedAction.approvalId, orgId, principal: actorId, tool: name,
        argsHash: await hashToolArgs(toolArgs), idempotencyKey,
      });
      if (claim.kind === "claimed") {
        return registeredDispatchRegistry.invoke(name, toolArgs, callPrincipal, {
          ...options, idempotencyKey, claimedInvocation: claim.receipt,
        });
      }
      if (claim.kind === "replay") return employeeReceiptReplay(claim.receipt);
      return employeeClaimFailure(claim.kind);
    },
  } : registeredDispatchRegistry;
  const result = await dispatchEmployeeTool({
    registry: dispatchRegistry, authority, selection, toolName, args, connection,
    connectionPolicy: policy, ...(approval ? { approval } : {}),
    ...(executionContextId ? { executionContextId } : {}),
    ...(approval ? { idempotencyKey: `${EMPLOYEE_ACTION_IDEMPOTENCY_PREFIX}${approval.approvalId}` } : {}),
  });
  if (!result.allowed) return jsonError(result.reason, result.reason === "approval_required" ? 202 : 403);
  const claimMeta = result.result._meta && typeof result.result._meta === "object"
    ? (result.result._meta as Record<string, unknown>)[EMPLOYEE_CLAIM_META]
    : undefined;
  if (claimMeta && typeof claimMeta === "object" && "reason" in claimMeta && typeof claimMeta.reason === "string") {
    const reason = claimMeta.reason;
    return jsonError(reason === "expired" ? "employee_action_approval_expired"
      : reason === "consumed_receipt_missing" ? "employee_invocation_receipt_pruned_no_replay"
      : reason === "payload_conflict" ? "employee_invocation_payload_conflict"
      : reason === "failed" ? "employee_invocation_claim_failed"
      : "employee_action_approval_not_dispatchable", reason === "failed" ? 503 : 409);
  }
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
