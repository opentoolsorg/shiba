import type { Env } from "../env.js";
import type { ToolRegistry } from "../mcp-gateway.js";
import { z } from "zod";

/** WS07 flips this when knowledge_search is published; hidden until then. */
export const KNOWLEDGE_SEARCH_PUBLISHED = false;

const inputSchema = {
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(20).optional(),
};

export function registerKnowledgeSearchTool(registry: ToolRegistry, _env: Env): void {
  if (!KNOWLEDGE_SEARCH_PUBLISHED) return;
  registry.registerTool(
    "knowledge_search",
    "memory:read",
    async (args) => ({
      content: [{ type: "text", text: JSON.stringify({ ok: false, error: "knowledge_search handler not wired." }) }],
      structuredContent: { ok: false, query: String(args.query) },
    }),
    {
      description: "Search workspace knowledge (WS07).",
      inputSchema,
      annotations: { readOnlyHint: true },
    },
  );
}