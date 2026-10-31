/**
 * Worker-side app tools for a normal employee chat/run. This deliberately does
 * not install an MCP bearer token in the coding sandbox: it exposes only the
 * reviewed MCP registry actions inside the authenticated orchestrator Worker.
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { TokenRecord } from "./agent-tokens.js";
import type { Env } from "./env.js";
import { getCustomAgentById } from "./custom-agents-store.js";
import { registerAllMcpTools } from "./mcp-tool-registration.js";
import { createToolRegistry } from "./mcp-gateway.js";
import { capabilityId, selectEmployeeCapabilities } from "./employee-tool-policy.js";
import {
  resolveCurrentEmployeeToolMembership,
  resolveEmployeeToolPolicy,
} from "./employee-tool-store.js";
import { dispatchEmployeeToolForPrincipal, EMPLOYEE_TOOL_ACTIONS } from "./employee-tool-routes.js";

const ACTION_NAMES = Object.keys(EMPLOYEE_TOOL_ACTIONS) as Array<keyof typeof EMPLOYEE_TOOL_ACTIONS>;
const inputSchema = z.object({
  tool: z.enum(ACTION_NAMES),
  args: z.record(z.string(), z.unknown()),
});

export async function employeeRunToolPolicyMode(
  env: Env,
  employeeId: string,
  orgId = "self-hosted",
): Promise<"missing" | "legacy" | "policy"> {
  if (!env.AGENT_AUDIT || !employeeId) return "missing";
  const employee = await getCustomAgentById(env, orgId, employeeId);
  if (!employee) return "missing";
  // Never-enrolled profiles omit toolScopes and keep the legacy Code Mode
  // workflow. The policy endpoint persists [] on explicit revoke, which must
  // remain managed deny-all instead of restoring legacy registry authority.
  return employee.config.toolScopes === undefined ? "legacy" : "policy";
}

export interface EmployeeRunToolContext {
  employeeId: string;
  employeeVersion: number;
  actorId: string;
  role: string;
  principal: TokenRecord;
  allowed: string[];
  resources: Record<string, string[]>;
}

/** Resolve employee, version, actor and grant intersection exclusively from Worker stores. */
export async function resolveEmployeeRunToolContext(
  env: Env,
  employeeId: string,
  orgId = "self-hosted",
  expectedActorId?: string,
): Promise<EmployeeRunToolContext | null> {
  if (!env.AGENT_AUDIT || !employeeId) return null;
  const employee = await getCustomAgentById(env, orgId, employeeId);
  if (!employee || !Array.isArray(employee.config.toolScopes) || employee.config.toolScopes.length === 0) return null;
  if (employee.config.toolScopes.some((id) => !ACTION_NAMES.some((name) => capabilityId(name) === id))) return null;

  const membership = await resolveCurrentEmployeeToolMembership(env, {
    orgId, employeeId, employeeVersion: employee.version,
  });
  if (!membership || (expectedActorId !== undefined && (!expectedActorId || membership.actorId !== expectedActorId))) return null;
  const policy = await resolveEmployeeToolPolicy(env, {
    orgId, employeeId, employeeVersion: employee.version, actorId: membership.actorId,
  });
  if (!policy || policy.role !== membership.role) return null;

  const registry = createToolRegistry(env);
  registerAllMcpTools(registry, env);
  const allowedScopes = new Set(employee.config.toolScopes);
  const scopes = registry.tools().filter((registered) => allowedScopes.has(capabilityId(registered.name))).map((registered) => registered.scope);
  const principal: TokenRecord = {
    kind: "agent", principal: membership.actorId, orgId, scopes,
    created: 0, revoked: false,
  };
  const authority = {
    principal,
    workspaceId: orgId,
    employeeId,
    employeeVersion: employee.version,
    employeeRole: policy.role,
    workspaceCapabilityIds: policy.workspaceCapabilityIds,
    actorCapabilityIds: policy.actorCapabilityIds,
    roleCapabilityIds: policy.roleCapabilityIds,
    employeeCapabilityIds: employee.config.toolScopes,
    registeredTools: registry.tools(),
  };
  const selection = selectEmployeeCapabilities(authority);
  const resources: Record<string, string[]> = {};
  for (const id of selection.allowedCapabilityIds) {
    const all = policy.employeeGrants.filter((grant) => grant.capabilityId === id && grant.lifecycle === "active");
    const workspace = new Set(all.filter((grant) => grant.subjectType === "workspace").map((grant) => grant.resourceId));
    const actor = new Set(all.filter((grant) => grant.subjectType === "actor" && grant.subjectId === membership.actorId).map((grant) => grant.resourceId));
    const roleResources = new Set(all.filter((grant) => grant.subjectType === "role" && grant.subjectId === membership.role).map((grant) => grant.resourceId));
    resources[id] = [...workspace].filter((resource) => actor.has(resource) && roleResources.has(resource)).sort();
  }
  const allowed = selection.allowedCapabilityIds.filter((id) => (resources[id]?.length ?? 0) > 0);
  return { employeeId, employeeVersion: employee.version, actorId: membership.actorId, role: membership.role, principal, allowed, resources };
}

/**
 * The profile turns use these two Worker tools instead of unrestricted
 * orchestrator Code Mode. `employee_tool_catalog` is the per-turn discovery
 * list; every call independently reloads and checks current policy/grants.
 */
export function createEmployeeRunTools(
  env: Env,
  resolveEmployeeId: () => string | null,
  resolveExecutionContextId: () => string | null,
  resolveOrgId: () => string = () => "self-hosted",
  resolveActorId: () => string | null = () => null,
): ToolSet {
  return {
    employee_tool_catalog: tool({
      description: "List the employee’s currently authorized Shiba app tools and exact resource IDs. Only actions in this result are available.",
      inputSchema: z.object({}),
      execute: async () => {
        const employeeId = resolveEmployeeId();
        const orgId = resolveOrgId();
        const actorId = resolveActorId();
        const context = employeeId && actorId ? await resolveEmployeeRunToolContext(env, employeeId, orgId, actorId) : null;
        if (!context) return { employee: employeeId ?? null, actions: [] };
        return {
          employee: { id: context.employeeId, version: context.employeeVersion, role: context.role },
          actions: context.allowed.map((id) => {
            const name = ACTION_NAMES.find((action) => capabilityId(action) === id);
            if (!name) return null;
            return { tool: name, resourceArgument: EMPLOYEE_TOOL_ACTIONS[name].resourceArgument, resources: context.resources[id] };
          }).filter((action) => action !== null),
        };
      },
    }),
    employee_tool_call: tool({
      description: "Call one supported Shiba app tool listed by employee_tool_catalog. The Worker rechecks employee version, grants, resource and exact-payload approval for every call.",
      inputSchema,
      execute: async ({ tool: toolName, args }) => {
        const employeeId = resolveEmployeeId();
        const executionContextId = resolveExecutionContextId();
        const orgId = resolveOrgId();
        const actorId = resolveActorId();
        const context = employeeId && executionContextId && actorId ? await resolveEmployeeRunToolContext(env, employeeId, orgId, actorId) : null;
        if (!context?.allowed.includes(capabilityId(toolName)) || !executionContextId) {
          throw new Error("Employee tool is unavailable under the current policy.");
        }
        const response = await dispatchEmployeeToolForPrincipal(env, context.employeeId, context.principal, toolName, args, executionContextId);
        const body = await response.json().catch(() => ({})) as Record<string, unknown>;
        if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `Employee tool call failed (${response.status}).`);
        return body;
      },
    }),
  };
}
