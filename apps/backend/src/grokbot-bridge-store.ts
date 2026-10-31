import { randomHex } from "./mailbox-store.js";
import type { AuditEnv } from "./audit.js";
import { initAudit } from "./audit.js";
import type { GrokbotBridgeTaskStatus } from "@shiba/shared";

export interface GrokbotBridgeTask {
  id: string;
  orgId: string;
  ownerId: string;
  principal: string;
  founderSkillId: string;
  automationId: string | null;
  status: GrokbotBridgeTaskStatus;
  payloadJson: string;
  resultJson: string | null;
  slackText: string | null;
  slackPostedAt: number | null;
  approvalId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

const TABLES = [
  `CREATE TABLE IF NOT EXISTS grokbot_bridge_tasks (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    principal TEXT NOT NULL,
    founder_skill_id TEXT NOT NULL,
    automation_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('queued','running','awaiting_approval','completed','failed')),
    payload_json TEXT NOT NULL,
    result_json TEXT,
    slack_text TEXT,
    slack_posted_at INTEGER,
    approval_id TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS grokbot_bridge_org_updated ON grokbot_bridge_tasks(org_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS grokbot_bridge_principal ON grokbot_bridge_tasks(org_id, principal, updated_at DESC)`,
];

const initialized = new WeakSet<D1Database>();

async function ensureTables(env: AuditEnv): Promise<void> {
  if (initialized.has(env.AGENT_AUDIT)) return;
  await initAudit(env);
  for (const sql of TABLES) await env.AGENT_AUDIT.prepare(sql).run();
  initialized.add(env.AGENT_AUDIT);
}

function rowToTask(row: Record<string, unknown>): GrokbotBridgeTask {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    ownerId: String(row.owner_id),
    principal: String(row.principal),
    founderSkillId: String(row.founder_skill_id),
    automationId: row.automation_id == null ? null : String(row.automation_id),
    status: row.status as GrokbotBridgeTaskStatus,
    payloadJson: String(row.payload_json),
    resultJson: row.result_json == null ? null : String(row.result_json),
    slackText: row.slack_text == null ? null : String(row.slack_text),
    slackPostedAt: row.slack_posted_at == null ? null : Number(row.slack_posted_at),
    approvalId: row.approval_id == null ? null : String(row.approval_id),
    error: row.error == null ? null : String(row.error),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function publicBridgeTask(task: GrokbotBridgeTask) {
  return {
    taskId: task.id,
    founderSkillId: task.founderSkillId,
    automationId: task.automationId ?? undefined,
    status: task.status,
    principal: task.principal,
    payload: JSON.parse(task.payloadJson) as unknown,
    ...(task.resultJson ? { result: JSON.parse(task.resultJson) as unknown } : {}),
    ...(task.slackPostedAt ? { slackPostedAt: task.slackPostedAt } : {}),
    ...(task.approvalId ? { approvalId: task.approvalId } : {}),
    ...(task.error ? { error: task.error } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export async function createGrokbotBridgeTask(
  env: AuditEnv,
  input: {
    orgId: string;
    ownerId: string;
    principal: string;
    founderSkillId: string;
    automationId?: string;
    payload?: Record<string, unknown>;
  },
  now = Date.now(),
): Promise<GrokbotBridgeTask> {
  await ensureTables(env);
  const id = `gbt-${randomHex(10)}`;
  const payloadJson = JSON.stringify(input.payload ?? {});
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO grokbot_bridge_tasks (
      id, org_id, owner_id, principal, founder_skill_id, automation_id, status,
      payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
  ).bind(
    id,
    input.orgId,
    input.ownerId,
    input.principal,
    input.founderSkillId,
    input.automationId ?? null,
    payloadJson,
    now,
    now,
  ).run();
  const task = await getGrokbotBridgeTask(env, input.orgId, input.principal, id);
  if (!task) throw new Error("Bridge task create failed.");
  return task;
}

export async function getGrokbotBridgeTask(
  env: AuditEnv,
  orgId: string,
  principal: string,
  id: string,
): Promise<GrokbotBridgeTask | null> {
  await ensureTables(env);
  const row = await env.AGENT_AUDIT.prepare(
    `SELECT * FROM grokbot_bridge_tasks WHERE org_id = ? AND id = ? AND principal = ?`,
  ).bind(orgId, id, principal).first();
  return row ? rowToTask(row as Record<string, unknown>) : null;
}

export async function updateGrokbotBridgeTask(
  env: AuditEnv,
  orgId: string,
  principal: string,
  id: string,
  patch: Partial<Pick<GrokbotBridgeTask, "status" | "resultJson" | "slackText" | "slackPostedAt" | "approvalId" | "error">>,
  now = Date.now(),
): Promise<GrokbotBridgeTask | null> {
  await ensureTables(env);
  const current = await getGrokbotBridgeTask(env, orgId, principal, id);
  if (!current) return null;
  const next = {
    status: patch.status ?? current.status,
    resultJson: patch.resultJson !== undefined ? patch.resultJson : current.resultJson,
    slackText: patch.slackText !== undefined ? patch.slackText : current.slackText,
    slackPostedAt: patch.slackPostedAt !== undefined ? patch.slackPostedAt : current.slackPostedAt,
    approvalId: patch.approvalId !== undefined ? patch.approvalId : current.approvalId,
    error: patch.error !== undefined ? patch.error : current.error,
  };
  await env.AGENT_AUDIT.prepare(
    `UPDATE grokbot_bridge_tasks SET status = ?, result_json = ?, slack_text = ?, slack_posted_at = ?,
     approval_id = ?, error = ?, updated_at = ?
     WHERE org_id = ? AND id = ? AND principal = ?`,
  ).bind(
    next.status,
    next.resultJson,
    next.slackText,
    next.slackPostedAt,
    next.approvalId,
    next.error,
    now,
    orgId,
    id,
    principal,
  ).run();
  return getGrokbotBridgeTask(env, orgId, principal, id);
}
