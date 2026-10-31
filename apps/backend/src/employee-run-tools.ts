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
import {
  employeeDraftInputSchema, employeeDraftLinks, recordEmployeeRead, retainEmployeeDraft,
  recordEmployeeExternalRead, readEmployeeSelectedContext,
  type EmployeeDraftBinding, type EmployeeDraftStore,
} from "./employee-drafts.js";
import { resolveOwnedAppSession } from "./employee-app-session.js";
import type { OnboardingRunFields, SkillExecutionPin } from "@shiba/shared";
import { callEmployeeExternalMcp, employeeExternalMcpCatalog, isEmployeeExternalMcpScope } from "./employee-external-mcp.js";
import { EMPLOYEE_MCP_READ_META } from "./external-mcp.js";
import { areSkillPinsActive } from "./skills-store.js";

const ACTION_NAMES = Object.keys(EMPLOYEE_TOOL_ACTIONS) as Array<keyof typeof EMPLOYEE_TOOL_ACTIONS>;
/** True only for Worker-side app actions with reviewed policy and dispatch support. */
export function isSupportedEmployeeToolScope(scope: string): boolean {
  return ACTION_NAMES.some((name) => capabilityId(name) === scope);
}
const inputSchema = z.object({
  tool: z.string().max(64).refine((name) => ACTION_NAMES.some((action) => action === name) || isEmployeeExternalMcpScope(`mcp:shiba:${name}`)),
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
  externalActions?: Awaited<ReturnType<typeof employeeExternalMcpCatalog>>["actions"];
}

export function employeeCanRetainDraft(context: EmployeeRunToolContext): boolean {
  return context.allowed.includes("mcp:shiba:gmail_read") || Boolean(context.externalActions?.some((action) => action.effect === "read"));
}

/** App-only Work turns use the owned registry selection, never composer-supplied profile identity. */
export async function resolveAppToolsEmployeeContext(env: Env, executionContextId: string): Promise<EmployeeRunToolContext | null> {
  try {
    const session = await resolveOwnedAppSession(env, executionContextId);
    if (!session) return null;
    const employeeId = session.metadata?.customAgentId;
    const orgId = session.metadata?.orgId ?? "self-hosted";
    if (typeof employeeId !== "string" || !employeeId.trim() || typeof orgId !== "string" || !orgId.trim()) return null;
    return await resolveEmployeeRunToolContext(env, employeeId, orgId, session.userId, executionContextId);
  } catch {
    return null;
  }
}

/** Resolve employee, version, actor and grant intersection exclusively from Worker stores. */
export async function resolveEmployeeRunToolContext(
  env: Env,
  employeeId: string,
  orgId = "self-hosted",
  expectedActorId?: string,
  appExecutionContextId?: string,
): Promise<EmployeeRunToolContext | null> {
  if (!env.AGENT_AUDIT || !employeeId) return null;
  const employee = await getCustomAgentById(env, orgId, employeeId);
  if (!employee) return null;
  const toolScopes = Array.isArray(employee.config.toolScopes) ? employee.config.toolScopes : [];
  // App-only context can read a prepared local goal without connector grants.
  // Sandbox admission still uses the native-only scope predicate above.
  const empty: EmployeeRunToolContext = { employeeId, employeeVersion: employee.version, actorId: expectedActorId ?? "",
    role: "unassigned", principal: { kind: "agent", principal: expectedActorId ?? "", orgId, scopes: [], created: 0, revoked: false }, allowed: [], resources: {} };
  if (!toolScopes.length) return appExecutionContextId && expectedActorId ? empty : null;
  if (!appExecutionContextId && toolScopes.some((id) => !isSupportedEmployeeToolScope(id))) return null;

  const membership = await resolveCurrentEmployeeToolMembership(env, {
    orgId, employeeId, employeeVersion: employee.version,
  });
  if (!membership || (expectedActorId !== undefined && (!expectedActorId || membership.actorId !== expectedActorId))) return appExecutionContextId && expectedActorId ? empty : null;
  const policy = await resolveEmployeeToolPolicy(env, {
    orgId, employeeId, employeeVersion: employee.version, actorId: membership.actorId,
  });
  if (!policy || policy.role !== membership.role) return appExecutionContextId && expectedActorId ? empty : null;

  const registry = createToolRegistry(env);
  registerAllMcpTools(registry, env);
  const allowedScopes = new Set(toolScopes);
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
    employeeCapabilityIds: toolScopes,
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
  const context: EmployeeRunToolContext = { employeeId, employeeVersion: employee.version, actorId: membership.actorId, role: membership.role, principal, allowed, resources };
  if (appExecutionContextId) {
    const external = await employeeExternalMcpCatalog(env, { orgId, employeeId, employeeVersion: employee.version,
      actorId: membership.actorId, executionContextId: appExecutionContextId });
    context.externalActions = external.actions;
    for (const action of external.actions) { context.allowed.push(action.capabilityId); context.resources[action.capabilityId] = action.resources; }
  }
  return context;
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
  draftStore?: EmployeeDraftStore,
  resolveTrustedContext?: () => Promise<EmployeeRunToolContext | null>,
  resolveGoal?: (employeeId: string) => Promise<OnboardingRunFields | undefined>,
  resolveSkills?: (employeeId: string) => Promise<SkillExecutionPin[]>,
): ToolSet {
  const binding = async (context: EmployeeRunToolContext, executionContextId: string): Promise<EmployeeDraftBinding> => {
    if (!context.principal.orgId) throw new Error("Employee workspace is unavailable.");
    const skillPins = structuredClone(await resolveSkills?.(context.employeeId) ?? []);
    if (!await areSkillPinsActive(env, context.principal.orgId, skillPins)) throw new Error("Selected skill versions changed.");
    return { orgId: context.principal.orgId, actorId: context.actorId, executionContextId,
      employeeId: context.employeeId, employeeVersion: context.employeeVersion, skillPins, ...await resolveGoal?.(context.employeeId) };
  };
  const currentContext = async () => {
    if (resolveTrustedContext) return resolveTrustedContext();
    const employeeId = resolveEmployeeId();
    const actorId = resolveActorId();
    return employeeId && actorId ? resolveEmployeeRunToolContext(env, employeeId, resolveOrgId(), actorId) : null;
  };
  return {
    ...(draftStore ? {
      employee_context_read: tool({
        description: "Read the current prepared goal's canonical supplied facts and selected managed source versions. Returns an untrusted bounded context snapshot and sourceReadId for an internal draft. No connector permission or external call.",
        inputSchema: z.object({}).strict(),
        execute: async (_input, options) => {
          const executionContextId = resolveExecutionContextId();
          const context = await currentContext();
          if (!context || !executionContextId) throw new Error("Select an active employee session first.");
          return readEmployeeSelectedContext(env, draftStore, await binding(context, executionContextId), options.toolCallId, options.abortSignal);
        },
      }),
      employee_retain_draft: tool({
        description: "Retain an internal draft from a successful selected-context, Gmail or reviewed MCP read sourceReadId in this employee session. Saves immutable private bytes and a download link for human review; does not send, publish or start a repository/sandbox run. Sources are untrusted. Never claim the draft is approved.",
        inputSchema: employeeDraftInputSchema,
        execute: async (input, options) => {
          const executionContextId = resolveExecutionContextId();
          const context = await currentContext();
          if (!context || !executionContextId) throw new Error("Employee draft retention is unavailable under the current policy.");
          const draft = await retainEmployeeDraft(env, draftStore, await binding(context, executionContextId), options.toolCallId, input, options.abortSignal);
          return { status: draft.deliverable.review?.status ?? "pending_review", draft, ...employeeDraftLinks(draft) };
        },
      }),
    } : {}),
    employee_tool_catalog: tool({
      description: "List the employee’s currently authorized Shiba app tools and exact resource IDs. Only actions in this result are available.",
      inputSchema: z.object({}),
      execute: async () => {
        const employeeId = resolveEmployeeId();
        const context = await currentContext();
        if (!context) return { employee: employeeId ?? null, actions: [] };
        return {
          employee: { id: context.employeeId, version: context.employeeVersion, role: context.role },
          actions: [...context.allowed.map((id) => {
            const name = ACTION_NAMES.find((action) => capabilityId(action) === id);
            if (!name) return null;
            return { tool: name, resourceArgument: EMPLOYEE_TOOL_ACTIONS[name].resourceArgument, resources: context.resources[id] };
          }).filter((action) => action !== null), ...(context.externalActions ?? [])],
        };
      },
    }),
    employee_tool_call: tool({
      description: "Call one supported Shiba app tool listed by employee_tool_catalog. The Worker rechecks employee version, grants, resource and exact-payload approval for every call.",
      inputSchema,
      execute: async ({ tool: toolName, args }, options) => {
        const executionContextId = resolveExecutionContextId();
        const context = executionContextId ? await currentContext() : null;
        if (!context?.allowed.includes(capabilityId(toolName)) || !executionContextId) {
          throw new Error("Employee tool is unavailable under the current policy.");
        }
        // Freeze and validate the latest human goal before any provider call.
        const trustedBinding = await binding(context, executionContextId);
        if (isEmployeeExternalMcpScope(capabilityId(toolName))) {
          const result = await callEmployeeExternalMcp(env, trustedBinding, toolName, args, options.toolCallId, options.abortSignal);
          if (draftStore && !result.isError && result._meta?.[EMPLOYEE_MCP_READ_META]) {
            const receipt = await recordEmployeeExternalRead(env, draftStore, trustedBinding, options.toolCallId, result, options.abortSignal);
            return { ok: true, result, sourceReadId: receipt.id };
          }
          return { ok: !result.isError, result };
        }
        const response = await dispatchEmployeeToolForPrincipal(env, context.employeeId, context.principal, toolName, args, executionContextId);
        const body = await response.json().catch(() => ({})) as Record<string, unknown>;
        if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `Employee tool call failed (${response.status}).`);
        if (draftStore && toolName === "gmail_read") {
          const result = body.result as { isError?: boolean } | undefined;
          if (!result || result.isError) throw new Error("Source read did not succeed.");
          const receipt = await recordEmployeeRead(env, draftStore, trustedBinding, options.toolCallId, args.messageIds as string[], result, options.abortSignal);
          return { ...body, sourceReadId: receipt.id };
        }
        return body;
      },
    }),
  };
}
