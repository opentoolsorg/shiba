import type { KnowledgeFile, KnowledgeNote, KnowledgeProject } from "@shiba/shared";
import type { Env } from "../env.js";
import { listFiles } from "../files/files-store.js";
import { randomHex } from "../mailbox-store.js";
import { listNotes } from "../notes/notes-store.js";

export class ProjectStoreError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ProjectStoreError";
  }
}

function projectDto(
  row: Record<string, unknown>,
  counts?: { fileCount: number; noteCount: number },
): KnowledgeProject {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    createdAt: Number(row.created_at),
    ...(counts ? counts : {}),
  };
}

async function visibleKnowledge(
  env: Env,
  workspaceId: string,
  viewer: string,
): Promise<{ files: KnowledgeFile[]; notes: KnowledgeNote[] }> {
  const [personalFiles, workspaceFiles, personalNotes, workspaceNotes] = await Promise.all([
    listFiles(env, workspaceId, "personal", viewer),
    listFiles(env, workspaceId, "workspace", viewer),
    listNotes(env, workspaceId, "personal", viewer),
    listNotes(env, workspaceId, "workspace", viewer),
  ]);
  return {
    files: [...personalFiles, ...workspaceFiles],
    notes: [...personalNotes, ...workspaceNotes],
  };
}

export async function listProjects(
  env: Env,
  workspaceId: string,
  viewer?: string,
): Promise<KnowledgeProject[]> {
  const rows = await env.AGENT_AUDIT.prepare(
    `SELECT id, workspace_id, name, created_at FROM knowledge_projects WHERE workspace_id=? ORDER BY created_at DESC LIMIT 100`,
  )
    .bind(workspaceId)
    .all<{ id: string; workspace_id: string; name: string; created_at: number }>();
  if (!viewer) return rows.results.map((row) => projectDto(row));
  const visible = await visibleKnowledge(env, workspaceId, viewer);
  return rows.results.map((row) =>
    projectDto(row, {
      fileCount: visible.files.filter((file) => file.projectId === row.id).length,
      noteCount: visible.notes.filter((note) => note.projectId === row.id).length,
    }),
  );
}

export async function getProject(
  env: Env,
  workspaceId: string,
  projectId: string,
): Promise<KnowledgeProject | null> {
  const row = await env.AGENT_AUDIT.prepare(
    `SELECT id, workspace_id, name, created_at FROM knowledge_projects WHERE workspace_id=? AND id=?`,
  )
    .bind(workspaceId, projectId)
    .first<Record<string, unknown>>();
  return row ? projectDto(row) : null;
}

export async function createProject(
  env: Env,
  workspaceId: string,
  name: string,
): Promise<KnowledgeProject> {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 120)
    throw new ProjectStoreError("Project name must be 1–120 characters.");
  const id = `proj_${randomHex(10)}`;
  const createdAt = Date.now();
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO knowledge_projects (id, workspace_id, name, created_at) VALUES (?,?,?,?)`,
  )
    .bind(id, workspaceId, trimmed, createdAt)
    .run();
  return { id, workspaceId, name: trimmed, createdAt, fileCount: 0, noteCount: 0 };
}

export async function renameProject(
  env: Env,
  workspaceId: string,
  projectId: string,
  name: string,
): Promise<KnowledgeProject> {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 120)
    throw new ProjectStoreError("Project name must be 1–120 characters.");
  const result = await env.AGENT_AUDIT.prepare(
    `UPDATE knowledge_projects SET name=? WHERE workspace_id=? AND id=?`,
  )
    .bind(trimmed, workspaceId, projectId)
    .run();
  if (!result.meta.changes) throw new ProjectStoreError("Project not found.", 404);
  const project = await getProject(env, workspaceId, projectId);
  if (!project) throw new ProjectStoreError("Project not found.", 404);
  return project;
}

/** Deleting a project never deletes knowledge; membership is detached first. */
export async function deleteProject(
  env: Env,
  workspaceId: string,
  projectId: string,
): Promise<boolean> {
  const existing = await getProject(env, workspaceId, projectId);
  if (!existing) return false;
  const now = Date.now();
  await env.AGENT_AUDIT.batch([
    env.AGENT_AUDIT.prepare(
      `UPDATE files SET project_id=NULL, updated_at=? WHERE workspace_id=? AND project_id=?`,
    ).bind(now, workspaceId, projectId),
    env.AGENT_AUDIT.prepare(
      `UPDATE notes SET project_id=NULL, updated_at=? WHERE workspace_id=? AND project_id=?`,
    ).bind(now, workspaceId, projectId),
    env.AGENT_AUDIT.prepare(`DELETE FROM knowledge_projects WHERE workspace_id=? AND id=?`).bind(
      workspaceId,
      projectId,
    ),
  ]);
  return true;
}

/** Resources own their project membership; projects only validate same-workspace grouping. */
export async function assignProjectResource(
  env: Env,
  input: {
    workspaceId: string;
    resourceKind: "file" | "note";
    resourceId: string;
    projectId: string | null;
  },
): Promise<boolean> {
  if (input.projectId !== null && !(await getProject(env, input.workspaceId, input.projectId))) {
    throw new ProjectStoreError("Project not found.", 404);
  }
  const table = input.resourceKind === "file" ? "files" : "notes";
  const result = await env.AGENT_AUDIT.prepare(
    `UPDATE ${table} SET project_id=?, updated_at=? WHERE workspace_id=? AND id=? AND archived_at IS NULL`,
  )
    .bind(input.projectId, Date.now(), input.workspaceId, input.resourceId)
    .run();
  return Boolean(result.meta.changes);
}

export async function listProjectResources(
  env: Env,
  workspaceId: string,
  viewer: string,
  projectId: string,
): Promise<{ files: KnowledgeFile[]; notes: KnowledgeNote[] }> {
  const visible = await visibleKnowledge(env, workspaceId, viewer);
  return {
    files: visible.files.filter((file) => file.projectId === projectId),
    notes: visible.notes.filter((note) => note.projectId === projectId),
  };
}
