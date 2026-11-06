import { COLLAB_TENANT_ID } from "./collaboration-store.js";
import type { Env } from "./env.js";
import { randomHex } from "./mailbox-store.js";

type StoreEnv = Pick<Env, "AGENT_AUDIT">;
export type TeamWorkTaskStatus = "backlog" | "todo" | "in-progress" | "in-review" | "done" | "cancelled";
export type TeamWorkTaskPriority = "none" | "low" | "medium" | "high" | "urgent";
export interface TeamWorkActivityEntry { id: string; kind: "created" | "change" | "comment"; actorId: string; text: string; at: number }
export interface TeamWorkTaskPatch {
  title?: string; status?: TeamWorkTaskStatus; priority?: TeamWorkTaskPriority; blocked?: boolean;
  ownerId?: string | null; reviewerId?: string | null; startDate?: string | null; endDate?: string | null;
  parentId?: string | null; objective?: string | null; waitingOn?: string[]; context?: string[]; doneWhen?: string[];
}
export interface TeamWorkTask {
  taskId: string; workspaceId: string; title: string; status: TeamWorkTaskStatus; priority: TeamWorkTaskPriority;
  ownerId: string | null; reviewerId: string | null; startDate: string | null; endDate: string | null; parentId: string | null;
  blocked: boolean; objective: string | null; waitingOn: string[]; context: string[]; doneWhen: string[];
  activity: TeamWorkActivityEntry[]; archived: boolean; createdBy: string; version: number; createdAt: number; updatedAt: number;
}
interface Row {
  task_id: string; workspace_id: string; title: string; status: TeamWorkTaskStatus; priority: TeamWorkTaskPriority;
  owner_id: string | null; reviewer_id: string | null; start_date: string | null; end_date: string | null; parent_id: string | null;
  blocked: number; objective: string | null; waiting_on_json: string; context_json: string; done_when_json: string;
  activity_json: string; archived: number; created_by: string; version: number; created_at: number; updated_at: number;
}

export class TeamWorkTaskError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "TeamWorkTaskError"; }
}

export const TEAM_WORK_TASK_LIMITS = { tasks: 500, activity: 200, parentDepth: 50 } as const;
const initialized = new WeakSet<D1Database>();
// Runtime mirror of migrations/0036_team_work_tasks.sql for databases not yet migrated.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS team_work_tasks (
    tenant_id TEXT NOT NULL,workspace_id TEXT NOT NULL,task_id TEXT NOT NULL,title TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('backlog','todo','in-progress','in-review','done','cancelled')),
    priority TEXT NOT NULL CHECK(priority IN ('none','low','medium','high','urgent')),
    owner_id TEXT,reviewer_id TEXT,start_date TEXT,end_date TEXT,parent_id TEXT,blocked INTEGER NOT NULL DEFAULT 0,objective TEXT,
    waiting_on_json TEXT NOT NULL DEFAULT '[]',context_json TEXT NOT NULL DEFAULT '[]',done_when_json TEXT NOT NULL DEFAULT '[]',
    activity_json TEXT NOT NULL DEFAULT '[]',archived INTEGER NOT NULL DEFAULT 0,created_by TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version>0),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
    PRIMARY KEY(tenant_id,workspace_id,task_id))`,
  `CREATE INDEX IF NOT EXISTS team_work_tasks_open ON team_work_tasks(tenant_id,workspace_id,archived,updated_at)`,
];

async function ensureSchema(env: StoreEnv): Promise<D1Database> {
  if (!env.AGENT_AUDIT) throw new TeamWorkTaskError("Workspace storage is unavailable.", 503);
  if (!initialized.has(env.AGENT_AUDIT)) {
    for (const sql of SCHEMA) await env.AGENT_AUDIT.prepare(sql).run();
    initialized.add(env.AGENT_AUDIT);
  }
  return env.AGENT_AUDIT;
}

function toTask(row: Row): TeamWorkTask {
  return {
    taskId: row.task_id, workspaceId: row.workspace_id, title: row.title, status: row.status, priority: row.priority,
    ownerId: row.owner_id, reviewerId: row.reviewer_id, startDate: row.start_date, endDate: row.end_date, parentId: row.parent_id,
    blocked: row.blocked === 1, objective: row.objective, waitingOn: JSON.parse(row.waiting_on_json), context: JSON.parse(row.context_json),
    doneWhen: JSON.parse(row.done_when_json), activity: JSON.parse(row.activity_json), archived: row.archived === 1,
    createdBy: row.created_by, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

const activity = (kind: TeamWorkActivityEntry["kind"], actorId: string, text: string, at: number): TeamWorkActivityEntry =>
  ({ id: `act_${randomHex(12)}`, kind, actorId, text, at });

export async function getTeamWorkTask(env: StoreEnv, workspaceId: string, taskId: string): Promise<TeamWorkTask | null> {
  const db = await ensureSchema(env);
  const row = await db.prepare("SELECT * FROM team_work_tasks WHERE tenant_id=? AND workspace_id=? AND task_id=?")
    .bind(COLLAB_TENANT_ID, workspaceId, taskId).first<Row>();
  return row ? toTask(row) : null;
}

export async function listTeamWorkTasks(env: StoreEnv, workspaceId: string): Promise<{ tasks: TeamWorkTask[]; truncated: boolean }> {
  const db = await ensureSchema(env);
  const { results } = await db.prepare(
    "SELECT * FROM team_work_tasks WHERE tenant_id=? AND workspace_id=? AND archived=0 ORDER BY updated_at DESC, task_id LIMIT ?",
  ).bind(COLLAB_TENANT_ID, workspaceId, TEAM_WORK_TASK_LIMITS.tasks + 1).all<Row>();
  return { tasks: results.slice(0, TEAM_WORK_TASK_LIMITS.tasks).map(toTask), truncated: results.length > TEAM_WORK_TASK_LIMITS.tasks };
}

export async function createTeamWorkTask(env: StoreEnv, workspaceId: string, actorId: string, title: string, now = Date.now()): Promise<TeamWorkTask> {
  const db = await ensureSchema(env);
  const taskId = `task_${randomHex(12)}`;
  const log = JSON.stringify([activity("created", actorId, "Created the task", now)]);
  await db.prepare(`INSERT INTO team_work_tasks
    (tenant_id,workspace_id,task_id,title,status,priority,activity_json,created_by,version,created_at,updated_at)
    VALUES (?,?,?,?,'todo','medium',?,?,1,?,?)`)
    .bind(COLLAB_TENANT_ID, workspaceId, taskId, title, log, actorId, now, now).run();
  const task = await getTeamWorkTask(env, workspaceId, taskId);
  if (!task) throw new TeamWorkTaskError("Task could not be created.", 503);
  return task;
}

async function assertParent(env: StoreEnv, workspaceId: string, taskId: string, parentId: string): Promise<void> {
  let cursor: string | null = parentId;
  for (let depth = 0; cursor; depth++) {
    if (cursor === taskId) throw new TeamWorkTaskError("A task cannot be inside itself.");
    if (depth >= TEAM_WORK_TASK_LIMITS.parentDepth) throw new TeamWorkTaskError("Task nesting is too deep.");
    const parent = await getTeamWorkTask(env, workspaceId, cursor);
    if (!parent || (depth === 0 && parent.archived)) throw new TeamWorkTaskError("Parent task not found.");
    cursor = parent.parentId;
  }
}

const describeChange = (key: keyof TeamWorkTaskPatch, value: TeamWorkTaskPatch[keyof TeamWorkTaskPatch]): string =>
  value === null || (Array.isArray(value) && value.length === 0) ? `Cleared ${key}`
    : Array.isArray(value) ? `Updated ${key}` : `Changed ${key} to ${String(value)}`;

const COLUMNS: Record<keyof TeamWorkTaskPatch, string> = {
  title: "title", status: "status", priority: "priority", blocked: "blocked", ownerId: "owner_id", reviewerId: "reviewer_id",
  startDate: "start_date", endDate: "end_date", parentId: "parent_id", objective: "objective",
  waitingOn: "waiting_on_json", context: "context_json", doneWhen: "done_when_json",
};

async function write(env: StoreEnv, task: TeamWorkTask, sets: Record<string, unknown>, entries: TeamWorkActivityEntry[], now: number): Promise<TeamWorkTask> {
  const db = await ensureSchema(env);
  const log = [...task.activity, ...entries].slice(-TEAM_WORK_TASK_LIMITS.activity);
  const columns = Object.keys(sets);
  const result = await db.prepare(`UPDATE team_work_tasks SET ${columns.map((column) => `${column}=?`).join(",")}${columns.length ? "," : ""}
    activity_json=?,version=version+1,updated_at=? WHERE tenant_id=? AND workspace_id=? AND task_id=? AND version=?`)
    .bind(...Object.values(sets), JSON.stringify(log), now, COLLAB_TENANT_ID, task.workspaceId, task.taskId, task.version).run();
  if (!result.meta.changes) throw new TeamWorkTaskError("Task changed concurrently; reload and retry.", 409);
  const fresh = await getTeamWorkTask(env, task.workspaceId, task.taskId);
  if (!fresh) throw new TeamWorkTaskError("Task not found.", 404);
  return fresh;
}

async function current(env: StoreEnv, workspaceId: string, taskId: string): Promise<TeamWorkTask> {
  const task = await getTeamWorkTask(env, workspaceId, taskId);
  if (!task || task.archived) throw new TeamWorkTaskError("Task not found.", 404);
  return task;
}

export async function updateTeamWorkTask(env: StoreEnv, workspaceId: string, taskId: string, actorId: string, patch: TeamWorkTaskPatch, now = Date.now()): Promise<TeamWorkTask> {
  const task = await current(env, workspaceId, taskId);
  if (patch.parentId) await assertParent(env, workspaceId, taskId, patch.parentId);
  const start = patch.startDate === undefined ? task.startDate : patch.startDate;
  const end = patch.endDate === undefined ? task.endDate : patch.endDate;
  if (start && end && start > end) throw new TeamWorkTaskError("Start date must be on or before the end date.");
  const sets: Record<string, unknown> = {};
  const entries: TeamWorkActivityEntry[] = [];
  for (const [key, value] of Object.entries(patch) as [keyof TeamWorkTaskPatch, TeamWorkTaskPatch[keyof TeamWorkTaskPatch]][]) {
    if (value === undefined) continue;
    sets[COLUMNS[key]] = Array.isArray(value) ? JSON.stringify(value) : typeof value === "boolean" ? Number(value) : value;
    entries.push(activity("change", actorId, describeChange(key, value), now));
  }
  return write(env, task, sets, entries, now);
}

export async function archiveTeamWorkTask(env: StoreEnv, workspaceId: string, taskId: string, actorId: string, now = Date.now()): Promise<TeamWorkTask> {
  const task = await current(env, workspaceId, taskId);
  return write(env, task, { archived: 1 }, [activity("change", actorId, "Archived the task", now)], now);
}

export async function commentTeamWorkTask(env: StoreEnv, workspaceId: string, taskId: string, actorId: string, text: string, now = Date.now()): Promise<TeamWorkTask> {
  const task = await current(env, workspaceId, taskId);
  return write(env, task, {}, [activity("comment", actorId, text, now)], now);
}
