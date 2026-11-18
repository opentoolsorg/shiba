import type { NoteChatMention } from "@shiba/shared";
import type { Env } from "../env.js";
import { getFile } from "../files/files-store.js";
import { assertKnowledgeRead, KnowledgeAccessError } from "../knowledge/knowledge-access.js";
import { filesBucket } from "../knowledge/knowledge-ingestion.js";
import { getNote } from "./notes-store.js";

export async function buildNoteChatContext(env: Env, userId: string, note: NonNullable<Awaited<ReturnType<typeof getNote>>>, mentions: NoteChatMention[], noteBody?: string): Promise<string> {
  const readBody = async (key: string) => (await (await filesBucket(env).get(key))?.text())?.slice(0, 24000) ?? "Not available";
  const activeBody = noteBody !== undefined ? noteBody : await readBody(note.r2Key);
  const context: unknown[] = [{ kind: "active note", title: note.title, body: activeBody }];
  for (const mention of mentions) {
    const resource = mention.kind === "note" ? await getNote(env, mention.id) : await getFile(env, mention.id);
    if (!resource || resource.archivedAt || resource.workspaceId !== note.workspaceId) { context.push({ status: "Not available" }); continue; }
    try {
      await assertKnowledgeRead(env, userId, { workspaceId: resource.workspaceId, scope: resource.scope, createdBy: resource.createdBy, resourceId: resource.id, resourceKind: mention.kind });
    } catch (error) {
      if (!(error instanceof KnowledgeAccessError)) throw error;
      context.push({ status: "Not available" }); continue;
    }
    if (mention.kind === "note" && "r2Key" in resource) {
      context.push({ kind: "note", title: resource.title, body: await readBody(resource.r2Key) });
    } else if ("name" in resource) {
      const chunks = await env.AGENT_AUDIT.prepare(
        `SELECT text FROM knowledge_chunks WHERE source_kind='file' AND source_id=? AND workspace_id=? AND version=? ORDER BY ordinal LIMIT 24`,
      ).bind(resource.id, resource.workspaceId, resource.version).all<{ text: string }>();
      context.push({ kind: "file", name: resource.name, body: chunks.results.map((row) => row.text).join("\n").slice(0, 12000) || "Not available" });
    }
  }
  return JSON.stringify(context);
}
