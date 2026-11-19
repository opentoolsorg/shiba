/**
 * Published MCP tool surface: `knowledge_search` over the caller's workspace files and notes.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { KNOWLEDGE_SEARCH_TOOL_NAME, knowledgeSearchToolArgsSchema } from "@shiba/shared";
import type { Env } from "../env.js";
import type { ToolRegistry } from "../mcp-gateway.js";
import { InputError } from "../security.js";
import { hybridKnowledgeSearch } from "./knowledge-search.js";

export const KNOWLEDGE_SEARCH_SCOPE = "knowledge:read" as const;

export const KNOWLEDGE_SEARCH_DESCRIPTION =
  "Search the user's uploaded files and notes (hybrid semantic + keyword). Returns ranked passages with the " +
  "source name and id; cite the source name when you use a passage. Personal sources are visible only to their owner.";

export function knowledgeSearchConfigured(env: Pick<Env, "AGENT_AUDIT">): boolean {
  return Boolean(env.AGENT_AUDIT);
}

export function registerKnowledgeSearchTool(registry: ToolRegistry, env: Env): void {
  registry.registerTool(
    KNOWLEDGE_SEARCH_TOOL_NAME,
    KNOWLEDGE_SEARCH_SCOPE,
    async (args, ctx): Promise<CallToolResult> => {
      if (!knowledgeSearchConfigured(env)) {
        return { content: [{ type: "text", text: "Knowledge search is not provisioned." }], isError: true };
      }
      const parsed = knowledgeSearchToolArgsSchema.safeParse(args);
      if (!parsed.success) throw new InputError(parsed.error.issues[0]?.message ?? "Invalid arguments.");
      const workspaceId = (ctx.principal.orgId ?? "self-hosted").replace(/^team:/, "");
      const hits = await hybridKnowledgeSearch(env, ctx.principal.principal, workspaceId, parsed.data.query, parsed.data.limit ?? 8);
      return {
        content: [{ type: "text", text: JSON.stringify({ query: parsed.data.query, hits }, null, 2) }],
      };
    },
    {
      description: KNOWLEDGE_SEARCH_DESCRIPTION,
      inputSchema: knowledgeSearchToolArgsSchema.shape,
      annotations: { readOnlyHint: true },
    },
  );
}
