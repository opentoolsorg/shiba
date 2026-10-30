/**
 * Employee-scoped MCP tool selection and dispatch.
 *
 * Inputs named `resolved*` below must come from current trusted stores (the
 * authenticated request principal, workspace membership/policy, the current
 * versioned employee record, and the connection/resource-grant store). Never
 * construct them from tool-call arguments. The adapter delegates to the MCP
 * registry after policy passes, so the registry's token-scope check and audit
 * remain the final gateway boundary.
 */
import type { TokenRecord } from "./agent-tokens.js";
import { hashToolArgs, type ToolRegistry, type RegisteredTool } from "./mcp-gateway.js";
import {
  decideConnectionDispatch,
  type ActionApproval,
  type CapabilityPolicy,
  type CapabilityRef,
  type ConnectionGrant,
  type DispatchPrincipal,
} from "./connection-policy.js";

export const EMPLOYEE_TOOL_SOURCE = "mcp:shiba" as const;
export const EMPLOYEE_TOOL_POLICY_VERSION = "1" as const;
export const MAX_EMPLOYEE_TOOL_IDS = 50;
export const MAX_EMPLOYEE_TOOL_ID_LENGTH = 96;

export type EmployeeRole = "owner" | "admin" | "operator" | "member" | "viewer";

export interface EmployeeToolAuthority {
  /** Authenticated, current principal. */
  principal: TokenRecord;
  workspaceId: string;
  employeeId: string;
  employeeVersion: number;
  employeeRole: EmployeeRole;
  /** Server-resolved capability grants; each must be scoped to a workspace. */
  workspaceCapabilityIds: readonly string[];
  actorCapabilityIds: readonly string[];
  roleCapabilityIds: readonly string[];
  employeeCapabilityIds: readonly string[];
  registeredTools: readonly RegisteredTool[];
}

export interface EmployeeToolSelection {
  version: typeof EMPLOYEE_TOOL_POLICY_VERSION;
  employeeId: string;
  employeeVersion: number;
  allowedCapabilityIds: string[];
  totalEligible: number;
  truncated: boolean;
}

/** Action approval frozen against the exact employee definition used at run time. */
export interface EmployeeActionApproval extends ActionApproval {
  employeeId: string;
  employeeVersion: number;
  executionContextId?: string;
}

export interface EmployeeToolDispatchInput {
  registry: Pick<ToolRegistry, "invoke">;
  authority: EmployeeToolAuthority;
  selection: EmployeeToolSelection;
  toolName: string;
  args: Record<string, unknown>;
  connection: ConnectionGrant;
  connectionPolicy: CapabilityPolicy;
  approval?: EmployeeActionApproval;
  now?: number;
  idempotencyKey?: string;
  executionContextId?: string;
}

export type EmployeeToolDispatchResult =
  | { allowed: true; result: Awaited<ReturnType<ToolRegistry["invoke"]>>; capabilityId: string }
  | { allowed: false; reason: string };

/**
 * Compute a bounded discovery set as an intersection, never a union:
 * registered ∩ workspace ∩ actor ∩ employee-role ∩ employee selection.
 * Provider connection and resource grants are checked at dispatch time because
 * they can be revoked after discovery.
 */
export function selectEmployeeCapabilities(
  authority: EmployeeToolAuthority,
  options: { limit?: number } = {},
): EmployeeToolSelection {
  assertAuthority(authority);
  const limit = boundedLimit(options.limit);
  const workspace = validateCapabilityIds(authority.workspaceCapabilityIds);
  const actor = validateCapabilityIds(authority.actorCapabilityIds);
  const role = validateCapabilityIds(authority.roleCapabilityIds);
  const employee = validateCapabilityIds(authority.employeeCapabilityIds);
  const allowedByPrincipal = new Set(authority.principal.scopes);
  const registered = new Map<string, RegisteredTool>();
  for (const tool of authority.registeredTools) {
    const id = capabilityId(tool.name);
    if (registered.has(id)) throw new Error("Duplicate registered employee capability.");
    registered.set(id, tool);
  }
  const candidates = [...registered.entries()]
    .filter(([id, tool]) =>
      workspace.has(id) && actor.has(id) && role.has(id) && employee.has(id) && allowedByPrincipal.has(tool.scope),
    )
    .map(([id]) => id)
    .sort();
  return {
    version: EMPLOYEE_TOOL_POLICY_VERSION,
    employeeId: authority.employeeId,
    employeeVersion: authority.employeeVersion,
    allowedCapabilityIds: candidates.slice(0, limit),
    totalEligible: candidates.length,
    truncated: candidates.length > limit,
  };
}

/** Recompute policy and check the current connection and frozen approval immediately before dispatch. */
export async function dispatchEmployeeTool(input: EmployeeToolDispatchInput): Promise<EmployeeToolDispatchResult> {
  try {
    assertAuthority(input.authority);
    if (
      input.selection.version !== EMPLOYEE_TOOL_POLICY_VERSION ||
      input.selection.employeeId !== input.authority.employeeId ||
      input.selection.employeeVersion !== input.authority.employeeVersion
    ) return { allowed: false, reason: "employee_selection_stale" };

    const currentSelection = selectEmployeeCapabilities(input.authority, { limit: MAX_EMPLOYEE_TOOL_IDS });
    const registered = input.authority.registeredTools.find((tool) => tool.name === input.toolName);
    if (!registered) return { allowed: false, reason: "unsupported_tool" };
    const id = capabilityId(registered.name);
    // Check both the supplied discovery snapshot and a fresh intersection so
    // that an old list cannot retain access after an employee/policy change.
    if (!input.selection.allowedCapabilityIds.includes(id) || !currentSelection.allowedCapabilityIds.includes(id)) {
      return { allowed: false, reason: "capability_not_allowed" };
    }
    if (input.approval && (
      input.approval.employeeId !== input.authority.employeeId ||
      input.approval.employeeVersion !== input.authority.employeeVersion ||
      input.approval.executionContextId !== input.executionContextId
    )) return { allowed: false, reason: "approval_stale" };
    const argumentDigest = await hashToolArgs(input.args);
    const matchingRules = input.connectionPolicy.actions.filter((rule) =>
      rule.action === registered.name && rule.capability.kind === "mcp" && rule.capability.id === id,
    );
    if (matchingRules.length !== 1) return { allowed: false, reason: "unsupported_action" };
    const resourceArgument = matchingRules[0]!.resourceArgument;
    const resourceValue = resourceArgument ? input.args[resourceArgument] : input.args.resourceId;
    if (resourceValue !== undefined && typeof resourceValue !== "string") {
      return { allowed: false, reason: "resource_not_allowed" };
    }
    const dispatchPrincipal: DispatchPrincipal = {
      userId: input.authority.principal.principal,
      workspaceId: input.authority.workspaceId,
    };
    const decision = decideConnectionDispatch({
      now: input.now ?? Date.now(),
      principal: dispatchPrincipal,
      grant: input.connection,
      policy: input.connectionPolicy,
      request: {
        capability: { kind: "mcp", id },
        action: registered.name,
        ...(typeof resourceValue === "string" ? { resourceId: resourceValue } : {}),
        ...(typeof input.args.accountId === "string" ? { accountId: input.args.accountId } : {}),
        argumentDigest,
      },
      ...(input.approval ? { approval: input.approval } : {}),
    });
    if (!decision.allowed) return { allowed: false, reason: decision.reason };
    const result = await input.registry.invoke(input.toolName, input.args, input.authority.principal, {
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    return { allowed: true, result, capabilityId: id };
  } catch {
    // Policy inputs are privileged metadata. Malformed snapshots should not
    // turn into permissive fallbacks or leak configuration details.
    return { allowed: false, reason: "invalid_policy_context" };
  }
}

export function capabilityId(toolName: string): string {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(toolName)) throw new Error("Invalid registered employee tool name.");
  return `${EMPLOYEE_TOOL_SOURCE}:${toolName}`;
}

function assertAuthority(authority: EmployeeToolAuthority): void {
  if (
    !authority || !authority.principal || authority.principal.revoked || authority.principal.kind === "api_key" ||
    !authority.principal.principal || !authority.principal.orgId || authority.principal.orgId !== authority.workspaceId ||
    !authority.employeeId || !Number.isSafeInteger(authority.employeeVersion) || authority.employeeVersion < 1 ||
    !["owner", "admin", "operator", "member", "viewer"].includes(authority.employeeRole) ||
    !Array.isArray(authority.registeredTools) || authority.registeredTools.length > 100
  ) throw new Error("Invalid employee tool authority.");
  if (authority.principal.expiresAt !== undefined && Date.now() >= authority.principal.expiresAt) {
    throw new Error("Expired employee tool principal.");
  }
}

function validateCapabilityIds(values: readonly string[]): Set<string> {
  if (!Array.isArray(values) || values.length > MAX_EMPLOYEE_TOOL_IDS * 4) throw new Error("Invalid employee capability grants.");
  const result = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.length > MAX_EMPLOYEE_TOOL_ID_LENGTH || !/^mcp:shiba:[a-z][a-z0-9_]{0,63}$/.test(value)) {
      throw new Error("Unsupported employee capability id.");
    }
    result.add(value);
  }
  return result;
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return MAX_EMPLOYEE_TOOL_IDS;
  if (!Number.isInteger(value) || value < 1) throw new Error("Employee capability limit must be positive.");
  return Math.min(value, MAX_EMPLOYEE_TOOL_IDS);
}
