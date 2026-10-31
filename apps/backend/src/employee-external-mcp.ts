/** Employee boundary over the existing reviewed HTTPS MCP adapter, not another transport or registry. */
import type { Env } from "./env.js";
import type { TokenRecord } from "./agent-tokens.js";
import { createToolRegistry, hashToolArgs } from "./mcp-gateway.js";
import { capabilityId, selectEmployeeCapabilities } from "./employee-tool-policy.js";
import {
  employeeExternalPolicyVersion, isEmployeeExternalMcpApprovalCurrent, resolveEmployeeExternalMcpPolicy,
  type EmployeeExternalMcpBinding, type EmployeeExternalMcpApprovalContext,
} from "./employee-tool-store.js";
import {
  EXTERNAL_MCP_SCOPE, listExternalMcpServers, registerExternalMcpTools,
  validateExternalMcpEndpoint,
  type ExternalMcpServer, type ExternalMcpTool,
} from "./external-mcp.js";

export function isEmployeeExternalMcpScope(value: string): boolean {
  return /^mcp:shiba:ext_[a-f0-9]{12}_[a-f0-9]{16}$/.test(value);
}

function resourceArguments(tool: ExternalMcpTool): string[] {
  // ponytail: one flat required string selector; structured selectors need a separate review.
  const schema = tool.inputSchema;
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties) || !Array.isArray(schema.required)) return [];
  return schema.required.filter((key): key is string => {
    if (typeof key !== "string") return false;
    const definition = (properties as Record<string, unknown>)[key];
    return typeof definition === "object" && definition !== null && (definition as { type?: unknown }).type === "string";
  });
}

/** Owner policy UI: only reviewed, enabled, healthy tools with a bounded resource field. No network discovery. */
export async function listEmployeeExternalMcpChoices(env: Env, orgId: string, ownerId: string) {
  const choices = [];
  for (const server of await listExternalMcpServers(env, orgId, ownerId)) {
    if (server?.status !== "enabled" || server.health !== "healthy") continue;
    try { validateExternalMcpEndpoint(server.endpoint, env); } catch { continue; }
    for (const tool of server.tools) {
      const fields = resourceArguments(tool);
      if (!tool.enabled || !tool.reviewedAt || tool.effect === "unreviewed" || !fields.length) continue;
      choices.push({ capabilityId: capabilityId(tool.gatewayName), tool: tool.gatewayName, label: `${server.name} · ${tool.remoteName}`,
        serverId: server.id, generation: server.generation, schemaVersion: tool.schemaVersion,
        resourceArguments: fields, effect: tool.effect });
    }
  }
  return choices;
}

type Authority = NonNullable<Awaited<ReturnType<typeof resolveEmployeeExternalMcpPolicy>>>;

function eligibleResources(authority: Authority, server: ExternalMcpServer, tool: ExternalMcpTool, principal: TokenRecord) {
  const id = capabilityId(tool.gatewayName);
  const { profile, policy } = authority;
  const selection = selectEmployeeCapabilities({ principal, workspaceId: server.orgId, employeeId: profile.id,
    employeeVersion: profile.version, employeeRole: policy.role, workspaceCapabilityIds: policy.workspaceCapabilityIds,
    actorCapabilityIds: policy.actorCapabilityIds, roleCapabilityIds: policy.roleCapabilityIds,
    employeeCapabilityIds: profile.config.toolScopes ?? [], registeredTools: [{ name: tool.gatewayName, scope: EXTERNAL_MCP_SCOPE,
      handler: async () => ({ content: [] }), meta: {} }] });
  if (!selection.allowedCapabilityIds.includes(id)) return null;
  for (const resourceArgument of resourceArguments(tool)) {
    const policyVersion = employeeExternalPolicyVersion(server.generation, tool.schemaVersion, resourceArgument);
    const grants = policy.employeeGrants.filter((grant) => grant.capabilityId === id && grant.connectionId === server.id &&
      grant.accountId === server.id && grant.generation === server.generation && grant.policyVersion === policyVersion && grant.lifecycle === "active");
    const resources = [...new Set(grants.map((grant) => grant.resourceId))].filter((resource) => {
      const current = grants.filter((grant) => grant.resourceId === resource);
      return current.length === 3 && new Set(current.map((grant) => grant.subjectType)).size === 3;
    }).sort();
    if (resources.length) return { resourceArgument, resources };
  }
  return null;
}

async function employeeRegistry(env: Env, binding: EmployeeExternalMcpBinding) {
  const registry = createToolRegistry(env);
  const actions: Array<{ tool: string; capabilityId: string; resourceArgument: string; resources: string[];
    inputSchema: Record<string, unknown>; schemaVersion: string; description: string }> = [];
  const principal: TokenRecord = { kind: "agent", principal: binding.actorId, orgId: binding.orgId,
    scopes: [EXTERNAL_MCP_SCOPE], created: 0, revoked: false };
  const authority = await resolveEmployeeExternalMcpPolicy(env, binding);
  if (!authority) return { registry, principal, actions };
  await registerExternalMcpTools(registry, env, principal, {
    toolNames: (authority.profile.config.toolScopes ?? []).filter(isEmployeeExternalMcpScope).map((id) => id.slice("mcp:shiba:".length)),
    allowTool: async (server, tool) => {
      const allowed = eligibleResources(authority, server, tool, principal);
      if (!allowed) return false;
      actions.push({ tool: tool.gatewayName, capabilityId: capabilityId(tool.gatewayName), ...allowed,
        inputSchema: structuredClone(tool.inputSchema), schemaVersion: tool.schemaVersion,
        description: `UNTRUSTED owner-reviewed MCP description (${tool.effect}): ${tool.description}` });
      return true;
    },
    authorize: async (server, tool, args) => {
      const current = await resolveEmployeeExternalMcpPolicy(env, binding);
      if (!current) return null;
      const allowed = eligibleResources(current, server, tool, principal);
      if (!allowed || typeof args[allowed.resourceArgument] !== "string" || !allowed.resources.includes(args[allowed.resourceArgument] as string)) return null;
      const context: EmployeeExternalMcpApprovalContext = { ...binding, capabilityId: capabilityId(tool.gatewayName),
        schemaVersion: tool.schemaVersion, resourceArgument: allowed.resourceArgument, resourceIds: [args[allowed.resourceArgument] as string] };
      return await isEmployeeExternalMcpApprovalCurrent(env, context, server.id, server.generation, tool.schemaVersion) ? context : null;
    },
  });
  const registered = new Set(registry.tools().map((tool) => tool.name));
  return { registry, principal, actions: actions.filter((action) => registered.has(action.tool)) };
}

export async function employeeExternalMcpCatalog(env: Env, binding: EmployeeExternalMcpBinding) {
  const { actions } = await employeeRegistry(env, binding);
  return { actions, totalAuthorized: actions.length, returned: actions.length };
}

/** Actual tool invocation ID plus trusted session/profile binding form the durable operation identity. */
export async function callEmployeeExternalMcp(
  env: Env, binding: EmployeeExternalMcpBinding, tool: string, args: Record<string, unknown>, toolCallId: string,
) {
  if (!toolCallId || toolCallId.length > 200) throw new Error("Employee MCP call requires a tool invocation identity.");
  const { registry, principal, actions } = await employeeRegistry(env, binding);
  if (!actions.some((action) => action.tool === tool)) throw new Error("Employee MCP capability is unavailable under the current policy.");
  const operation = await hashToolArgs({ ...binding, toolCallId });
  return registry.invoke(tool, args, principal, { idempotencyKey: `employee-mcp:${operation}` });
}
