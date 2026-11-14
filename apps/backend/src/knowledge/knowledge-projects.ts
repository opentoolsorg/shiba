import type { KnowledgeProject } from "@shiba/shared";
import type { Env } from "../env.js";
import { randomHex } from "../mailbox-store.js";

export async function listProjects(env: Env, workspaceId: string): Promise<KnowledgeProject[]> {
  const rows = await env.AGENT_AUDIT.prepare(
    `SELECT id, workspace_id, name, created_at FROM knowledge_projects WHERE workspace_id=? ORDER BY created_at DESC LIMIT 100`,
  ).bind(workspaceId).all<{ id: string; workspace_id: string; name: string; created_at: number }>();
  return rows.results.map((row) => ({
    id: row.id, workspaceId: row.workspace_id, name: row.name, createdAt: row.created_at,
  }));
}

export async function createProject(env: Env, workspaceId: string, name: string): Promise<KnowledgeProject> {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 120) throw new Error("Project name must be 1–120 characters.");
  const id = `proj_${randomHex(10)}`;
  const createdAt = Date.now();
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO knowledge_projects (id, workspace_id, name, created_at) VALUES (?,?,?,?)`,
  ).bind(id, workspaceId, trimmed, createdAt).run();
  return { id, workspaceId, name: trimmed, createdAt };
}
