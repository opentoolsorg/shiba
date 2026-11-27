/**
 * Published MCP tool surface: bounded knowledge retrieval over the caller's workspace files and notes.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  KNOWLEDGE_READ_TOOL_NAME,
  KNOWLEDGE_SEARCH_TOOL_NAME,
  knowledgeReadToolArgsSchema,
  knowledgeSearchToolArgsSchema,
} from "@shiba/shared";
import type { Env } from "../env.js";
import type { ToolRegistry } from "../mcp-gateway.js";
import { InputError } from "../security.js";
import { canAccessKnowledgeResource } from "./knowledge-access.js";
import { filesBucket } from "./knowledge-ingestion.js";
import { hybridKnowledgeSearch } from "./knowledge-search.js";

export const KNOWLEDGE_SEARCH_SCOPE = "knowledge:read" as const;

export const KNOWLEDGE_SEARCH_DESCRIPTION =
  "Search the user's uploaded files and notes (hybrid semantic + keyword). Returns ranked passages with the " +
  "source name and id; cite the source name when you use a passage. Personal sources are visible only to their owner.";

const KNOWLEDGE_READ_MAX_BYTES = 256 * 1024;
const KNOWLEDGE_READ_DESCRIPTION =
  "Read a bounded text excerpt from one exact uploaded file or note after a knowledge_search hit. Use sourceKind and sourceId from the hit. Personal sources are visible only to their owner.";

function textualMime(mime: string): boolean {
  const lower = mime.toLowerCase();
  return lower.startsWith("text/") || ["application/json", "application/xml", "application/javascript", "application/x-ndjson"].includes(lower);
}

async function readKnowledgeSource(
  env: Env,
  viewerUserId: string,
  workspaceId: string,
  args: { sourceKind: "file" | "note"; sourceId: string; maxChars?: number },
): Promise<CallToolResult> {
  const maxChars = args.maxChars ?? 8000;
  const row = args.sourceKind === "file"
    ? await env.AGENT_AUDIT.prepare(
      `SELECT id,workspace_id,scope,created_by,name AS title,mime,size,r2_key,version,sha256,archived_at FROM files WHERE id=? AND workspace_id=?`,
    ).bind(args.sourceId, workspaceId).first<Record<string, unknown>>()
    : await env.AGENT_AUDIT.prepare(
      `SELECT id,workspace_id,scope,created_by,title,'text/markdown' AS mime,NULL AS size,r2_key,version,sha256,archived_at FROM notes WHERE id=? AND workspace_id=?`,
    ).bind(args.sourceId, workspaceId).first<Record<string, unknown>>();
  const archived = Number(row?.archived_at ?? 0) > 0;
  if (!row || archived) return { content: [{ type: "text", text: "Knowledge source not found." }], isError: true };
  const allowed = await canAccessKnowledgeResource(env, viewerUserId, {
    workspaceId,
    scope: row.scope === "workspace" ? "workspace" : "personal",
    createdBy: String(row.created_by),
    resourceId: args.sourceId,
    resourceKind: args.sourceKind,
  });
  if (!allowed) return { content: [{ type: "text", text: "Knowledge source not found." }], isError: true };
  const size = typeof row.size === "number" ? row.size : 0;
  if (size > KNOWLEDGE_READ_MAX_BYTES) return { content: [{ type: "text", text: `Knowledge source is too large to read inline (limit ${KNOWLEDGE_READ_MAX_BYTES} bytes).` }], isError: true };
  const mime = String(row.mime);
  if (!textualMime(mime)) return { content: [{ type: "text", text: `Knowledge source type ${mime} cannot be read as text inline; use knowledge_search passages or the file preview.` }], isError: true };
  const object = await filesBucket(env).get(String(row.r2_key));
  if (!object) return { content: [{ type: "text", text: "Knowledge source bytes are missing." }], isError: true };
  if (object.size > KNOWLEDGE_READ_MAX_BYTES) return { content: [{ type: "text", text: `Knowledge source is too large to read inline (limit ${KNOWLEDGE_READ_MAX_BYTES} bytes).` }], isError: true };
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength > KNOWLEDGE_READ_MAX_BYTES) return { content: [{ type: "text", text: `Knowledge source is too large to read inline (limit ${KNOWLEDGE_READ_MAX_BYTES} bytes).` }], isError: true };
  const full = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const truncated = full.length > maxChars;
  const payload = {
    sourceKind: args.sourceKind,
    sourceId: args.sourceId,
    title: String(row.title),
    mime,
    version: Number(row.version),
    sha256: String(row.sha256),
    truncated,
    content: full.slice(0, maxChars),
  };
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

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
  registry.registerTool(
    KNOWLEDGE_READ_TOOL_NAME,
    KNOWLEDGE_SEARCH_SCOPE,
    async (args, ctx): Promise<CallToolResult> => {
      if (!knowledgeSearchConfigured(env)) {
        return { content: [{ type: "text", text: "Knowledge storage is not provisioned." }], isError: true };
      }
      const parsed = knowledgeReadToolArgsSchema.safeParse(args);
      if (!parsed.success) throw new InputError(parsed.error.issues[0]?.message ?? "Invalid arguments.");
      const workspaceId = (ctx.principal.orgId ?? "self-hosted").replace(/^team:/, "");
      return readKnowledgeSource(env, ctx.principal.principal, workspaceId, parsed.data);
    },
    {
      description: KNOWLEDGE_READ_DESCRIPTION,
      inputSchema: knowledgeReadToolArgsSchema.shape,
      annotations: { readOnlyHint: true },
    },
  );
}
