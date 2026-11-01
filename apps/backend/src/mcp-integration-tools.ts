import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Env } from "./env.js";
import type { ToolRegistry } from "./mcp-gateway.js";
import { dispatchEmployeeToolForPrincipal } from "./employee-tool-routes.js";
import { getIntegrationProvider } from "./integrations/runtime.js";

const service = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const base = z.object({ toolkitSlug: service, employeeId: z.string().min(1).max(120).optional() });
const search = base.extend({ query: z.string().max(200).optional(), limit: z.number().int().min(1).max(50).optional() }).strict();
const execute = base.extend({ toolSlug: z.string().min(1).max(200), arguments: z.record(z.string(), z.unknown()) }).strict();

export function integrationToolInput(name: string, args: unknown): boolean {
  return (name === "integrations.search_actions" ? search : execute).safeParse(args).success;
}
function result(payload: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}

/** An owner is supplied only by employee dispatch after current grants and approval pass. */
export function registerIntegrationTools(registry: ToolRegistry, env: Env, owner?: string, revalidate?: () => Promise<void>): void {
  for (const name of ["integrations.search_actions", "integrations.execute"] as const) {
    const isSearch = name === "integrations.search_actions";
    registry.registerTool(name, isSearch ? "integrations:read" : "integrations:execute", async (args, context) => {
      const schema = isSearch ? search : execute;
      if (!schema.safeParse(args).success) throw new Error("Invalid integration tool input.");
      if (!owner) {
        if (typeof args.employeeId !== "string") throw new Error("An employeeId with current integration grants is required.");
        const response = await dispatchEmployeeToolForPrincipal(env, args.employeeId, context.principal, name, args);
        const body = await response.json() as Record<string, unknown>;
        const nested = body.result as CallToolResult | undefined;
        return { ...result(body), ...(!response.ok || nested?.isError ? { isError: true } : {}) };
      }
      await revalidate?.();
      const provider = getIntegrationProvider(env);
      if (!provider.searchActions) throw new Error("Action discovery is unsupported by this provider.");
      const toolkitSlug = String(args.toolkitSlug);
      if (isSearch) return result({ actions: await provider.searchActions({ userId: owner, toolkitSlug,
        query: typeof args.query === "string" ? args.query : undefined, limit: typeof args.limit === "number" ? args.limit : 20 }) });
      if (!provider.executeTool) throw new Error("Action execution is unsupported by this provider.");
      // The service resource grant cannot be used to execute an action from another service.
      const actions = await provider.searchActions({ userId: owner, toolkitSlug, actionId: String(args.toolSlug), limit: 50 });
      if (!actions.some((action) => action.id === args.toolSlug && action.service === toolkitSlug)) throw new Error("Action does not belong to the granted integration.");
      await revalidate?.();
      const output = await provider.executeTool({ userId: owner, toolkitSlug, toolSlug: String(args.toolSlug), arguments: args.arguments as Record<string, unknown> });
      return { ...result({ ...output }), ...(!output.ok ? { isError: true } : {}) };
    }, {
      description: isSearch ? "Search actions on an employee-authorized connected integration. Requires employeeId and toolkitSlug." : "Request an integration action using employee grants. Every execution requires human approval of these exact arguments; retry after approval. Never auto-approves.",
      inputSchema: (isSearch ? search : execute).shape,
      annotations: { readOnlyHint: isSearch, destructiveHint: !isSearch },
    });
  }
}
