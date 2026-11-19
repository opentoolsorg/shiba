import { automationsStub } from "../../automations-stub.js";
import type { Env } from "../../env.js";
import { DASHBOARD_ORG_ID } from "../../org-request-auth.js";
import { redactSecrets } from "../../security.js";

const DAY = 86_400_000;
const HALF_DAY = DAY / 2;

type Candidate = {
  workspaceId: string;
  ownerId: string;
  task: string;
  taskKey: string;
};

export async function sweepLearningCheckIns(env: Env, scheduledAt: number): Promise<void> {
  const db = env.AGENT_AUDIT;
  if (!db || scheduledAt % HALF_DAY !== 0) return;
  const slot = scheduledAt / HALF_DAY;
  const { results } = await db.prepare(
    `WITH recent AS (
       SELECT l.workspace_id, l.owner_id, t.completed_at,
              trim(substr(t.text, 7, instr(t.text, char(10) || 'Employee: ') - 7)) AS task
       FROM learning_threads l JOIN learning_turns t USING (thread_key)
       LEFT JOIN learning_settings s ON s.workspace_id = l.workspace_id
       WHERE l.last_turn_at >= ?1 AND t.completed_at BETWEEN ?1 AND ?2
         AND coalesce(s.turn_setting, '') <> 'off'
         AND substr(t.text, 1, 6) = 'User: '
         AND instr(t.text, char(10) || 'Employee: ') > 6
     )
     SELECT workspace_id AS workspaceId, owner_id AS ownerId, min(task) AS task,
            lower(task) AS taskKey
     FROM recent r
     WHERE length(task) BETWEEN 24 AND 300
       AND NOT EXISTS (
         SELECT 1 FROM learning_check_ins c
         WHERE c.workspace_id = r.workspace_id AND c.owner_id = r.owner_id
           AND (c.slot = ?3 OR c.task_key = lower(r.task))
       )
     GROUP BY workspace_id, owner_id, lower(task)
     HAVING count(DISTINCT CAST(completed_at / 86400000 AS INTEGER)) >= 2
     ORDER BY max(completed_at) DESC, workspace_id, owner_id, lower(task)
     LIMIT 25`,
  ).bind(scheduledAt - 7 * DAY, scheduledAt, slot).all<Candidate>();

  const promptsByWorkspace = new Map<string, Set<string> | null>();
  const surfaced = new Set<string>();
  for (const row of results) {
    const scope = JSON.stringify([row.workspaceId, row.ownerId]);
    if (surfaced.has(scope)) continue;
    if (!promptsByWorkspace.has(row.workspaceId)) {
      const prompts = await routinePrompts(env, row.workspaceId).catch(() => null);
      promptsByWorkspace.set(row.workspaceId, prompts);
    }
    const prompts = promptsByWorkspace.get(row.workspaceId);
    const task = redactSecrets(row.task);
    if (!prompts || task !== row.task || prompts.has(row.taskKey)) continue;
    await db.prepare(
      `INSERT OR IGNORE INTO learning_check_ins
       (id, workspace_id, owner_id, slot, task_key, task)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM learning_settings WHERE workspace_id = ? AND turn_setting = 'off')`,
    ).bind(crypto.randomUUID(), row.workspaceId, row.ownerId, slot, row.taskKey, task, row.workspaceId).run();
    surfaced.add(scope);
  }
}

async function routinePrompts(env: Env, workspaceId: string): Promise<Set<string> | null> {
  if (workspaceId !== DASHBOARD_ORG_ID && env.SHIBA_SCOPED_DO !== "1") return new Set();
  const response = await automationsStub(env, workspaceId).fetch("https://internal/api/automations");
  if (!response.ok) return null;
  const { automations } = await response.json<{ automations: Array<{ prompt: string }> }>();
  return new Set(automations.map(({ prompt }) => prompt.trim().toLowerCase()));
}

export async function listLearningCheckIns(db: D1Database, workspaceId: string, ownerId: string) {
  const { results } = await db.prepare(
    `SELECT id, task FROM learning_check_ins
     WHERE workspace_id = ? AND owner_id = ? AND dismissed_at IS NULL
     ORDER BY slot DESC LIMIT 20`,
  ).bind(workspaceId, ownerId).all<{ id: string; task: string }>();
  return results;
}

export async function dismissLearningCheckIn(
  db: D1Database, workspaceId: string, ownerId: string, id: string,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE learning_check_ins SET dismissed_at = coalesce(dismissed_at, ?)
     WHERE workspace_id = ? AND owner_id = ? AND id = ?`,
  ).bind(Date.now(), workspaceId, ownerId, id).run();
  return result.meta.changes === 1;
}
