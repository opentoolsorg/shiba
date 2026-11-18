import { noteChatMessageSchema, type NoteChatMessage } from "@shiba/shared";
import type { Env } from "../env.js";

export async function listNoteChat(env: Env, noteId: string, userId: string, workspaceId: string): Promise<NoteChatMessage[]> {
  const rows = await env.AGENT_AUDIT.prepare(
    `SELECT * FROM note_chat_messages WHERE note_id=? AND user_id=? AND workspace_id=? ORDER BY created_at DESC, rowid DESC LIMIT 50`,
  ).bind(noteId, userId, workspaceId).all<Record<string, unknown>>();
  return rows.results.reverse().map((row) => noteChatMessageSchema.parse({
    id: row.id, noteId: row.note_id, role: row.role, content: row.content,
    mentions: JSON.parse(String(row.mentions_json)), createdAt: row.created_at,
  }));
}

export async function appendNoteChat(env: Env, userId: string, workspaceId: string, messages: NoteChatMessage[]): Promise<void> {
  await env.AGENT_AUDIT.batch(messages.map((message) => env.AGENT_AUDIT.prepare(
    `INSERT INTO note_chat_messages (id,note_id,user_id,workspace_id,role,content,mentions_json,created_at) VALUES (?,?,?,?,?,?,?,?)`,
  ).bind(message.id, message.noteId, userId, workspaceId, message.role, message.content, JSON.stringify(message.mentions), message.createdAt)));
}

export async function clearNoteChat(env: Env, noteId: string, userId: string, workspaceId: string): Promise<void> {
  await env.AGENT_AUDIT.prepare(`DELETE FROM note_chat_messages WHERE note_id=? AND user_id=? AND workspace_id=?`)
    .bind(noteId, userId, workspaceId).run();
}
