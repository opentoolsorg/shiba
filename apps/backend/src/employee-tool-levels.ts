import type { AuditEnv } from "./audit.js";

/**
 * Per-employee Ask / Auto / Off levels for the Worker-side employee actions.
 *
 * Levels only decide whether an in-run action needs a one-time human approval.
 * They never replace approvals for sandbox execution or external writes.
 */
export type EmployeeToolLevel = "ask" | "auto" | "off";
export const EMPLOYEE_TOOL_LEVELS: readonly EmployeeToolLevel[] = ["ask", "auto", "off"];

const ASK_OR_OFF_ONLY = new Set(["queue_run", "integrations.execute", "send_email"]);

export const STANDING_SUGGESTION_APPROVALS = 2;
export const STANDING_SUGGESTION_WINDOW_MS = 14 * 24 * 60 * 60_000;

export function isEmployeeToolLevel(value: unknown): value is EmployeeToolLevel {
  return typeof value === "string" && (EMPLOYEE_TOOL_LEVELS as readonly string[]).includes(value);
}

export function allowedEmployeeToolLevels(toolName: string): EmployeeToolLevel[] {
  return ASK_OR_OFF_ONLY.has(toolName) ? ["ask", "off"] : ["ask", "auto", "off"];
}

export function defaultEmployeeToolLevel(risk: "read" | "external_write"): EmployeeToolLevel {
  return risk === "read" ? "auto" : "ask";
}

/** A stored level that is no longer allowed for its tool falls back to Ask, never to Auto. */
export function effectiveEmployeeToolLevel(toolName: string, risk: "read" | "external_write", stored: string | undefined): EmployeeToolLevel {
  if (stored === undefined) return defaultEmployeeToolLevel(risk);
  if (!isEmployeeToolLevel(stored) || !allowedEmployeeToolLevels(toolName).includes(stored)) return "ask";
  return stored;
}

export interface EmployeeToolLevelRecord { capabilityId: string; level: EmployeeToolLevel; setBy: string; updatedAt: number }

export async function listEmployeeToolLevels(env: AuditEnv, input: { orgId: string; employeeId: string }): Promise<EmployeeToolLevelRecord[]> {
  const rows = await env.AGENT_AUDIT.prepare(`SELECT capability_id, level, set_by, updated_at FROM employee_tool_levels
    WHERE org_id = ? AND employee_id = ? ORDER BY capability_id`).bind(input.orgId, input.employeeId).all<Record<string, unknown>>();
  return (rows.results ?? []).flatMap((row) => isEmployeeToolLevel(row.level) ? [{
    capabilityId: String(row.capability_id), level: row.level, setBy: String(row.set_by), updatedAt: Number(row.updated_at),
  }] : []);
}

export async function getStoredEmployeeToolLevel(env: AuditEnv, input: { orgId: string; employeeId: string; capabilityId: string }): Promise<string | undefined> {
  const row = await env.AGENT_AUDIT.prepare(`SELECT level FROM employee_tool_levels WHERE org_id = ? AND employee_id = ? AND capability_id = ?`)
    .bind(input.orgId, input.employeeId, input.capabilityId).first<{ level: string }>();
  return row?.level;
}

export async function setEmployeeToolLevel(env: AuditEnv, input: {
  orgId: string; employeeId: string; capabilityId: string; level: EmployeeToolLevel; setBy: string; now?: number;
}): Promise<void> {
  await env.AGENT_AUDIT.prepare(`INSERT INTO employee_tool_levels (org_id, employee_id, capability_id, level, set_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(org_id, employee_id, capability_id) DO UPDATE SET level = excluded.level, set_by = excluded.set_by, updated_at = excluded.updated_at`)
    .bind(input.orgId, input.employeeId, input.capabilityId, input.level, input.setBy, input.now ?? Date.now()).run();
}

/** Capabilities approved one call at a time at least twice in the last 14 days. */
export async function countRecentOneTimeApprovals(env: AuditEnv, input: { orgId: string; employeeId: string; now?: number }): Promise<Map<string, number>> {
  const since = (input.now ?? Date.now()) - STANDING_SUGGESTION_WINDOW_MS;
  const rows = await env.AGENT_AUDIT.prepare(`SELECT capability_id, COUNT(*) AS approvals FROM employee_tool_approvals
    WHERE org_id = ? AND employee_id = ? AND decided_by IS NOT NULL
      AND status IN ('approved', 'expired') AND level_at_decision = 'ask' AND decided_at >= ? GROUP BY capability_id`)
    .bind(input.orgId, input.employeeId, since).all<{ capability_id: string; approvals: number }>();
  return new Map((rows.results ?? []).map((row) => [String(row.capability_id), Number(row.approvals)]));
}
