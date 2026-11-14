import type { Env } from "../env.js";

export const DEFAULT_WEB_SEARCH_BUDGET = 10;

export async function incrementToolUsage(
  env: Pick<Env, "AGENT_AUDIT">,
  input: { orgId: string; runId: string; toolName: string; budgetLimit?: number | null },
): Promise<{ allowed: boolean; count: number; limit: number | null }> {
  if (!env.AGENT_AUDIT) return { allowed: true, count: 0, limit: input.budgetLimit ?? null };
  const now = Date.now();
  const limit = input.budgetLimit ?? null;
  const row = await env.AGENT_AUDIT.prepare(
    `SELECT call_count, budget_limit FROM agent_tool_usage
     WHERE org_id = ? AND run_id = ? AND tool_name = ?`,
  ).bind(input.orgId, input.runId, input.toolName).first<{ call_count: number; budget_limit: number | null }>();
  const count = (row?.call_count ?? 0) + 1;
  if (limit !== null && count > limit) {
    return { allowed: false, count: row?.call_count ?? 0, limit };
  }
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO agent_tool_usage (org_id, run_id, tool_name, call_count, budget_limit, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id, run_id, tool_name) DO UPDATE SET
       call_count = excluded.call_count,
       budget_limit = COALESCE(excluded.budget_limit, agent_tool_usage.budget_limit),
       updated_at = excluded.updated_at`,
  ).bind(input.orgId, input.runId, input.toolName, count, limit, now).run();
  return { allowed: true, count, limit };
}