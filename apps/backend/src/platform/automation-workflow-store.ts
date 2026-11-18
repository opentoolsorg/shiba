import type { Env } from "../env.js";
import type { DelegatedRun } from "@shiba/shared";
import { isQuietRoutine } from "../routine-outcome.js";
import { redactSecrets } from "../security.js";

export type AutomationWorkflowStatus =
  | "preparing"
  | "awaiting_approval"
  | "dispatched"
  | "terminal"
  | "failed"
  | "cancelled";

export interface AutomationWorkflowRunRow {
  id: string;
  automation_id: string;
  workspace_id: string;
  workflow_instance_id: string | null;
  command_id: string;
  approval_id: string | null;
  run_id: string | null;
  status: AutomationWorkflowStatus;
  error: string | null;
  outcome: "normal" | "quiet" | "failed";
  failure_reason: string | null;
  answer_summary: string | null;
  created_at: number;
  updated_at: number;
}

export async function insertAutomationWorkflowRun(
  env: Env,
  input: {
    automationId: string;
    workspaceId?: string;
    commandId: string;
    workflowInstanceId?: string;
  },
): Promise<AutomationWorkflowRunRow> {
  const id = `awr_${crypto.randomUUID()}`;
  const now = Date.now();
  const workspaceId = input.workspaceId ?? "self-hosted";
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO automation_workflow_runs(id,automation_id,workspace_id,workflow_instance_id,command_id,approval_id,run_id,status,error,created_at,updated_at)
     VALUES(?,?,?,?,?,NULL,NULL,'preparing',NULL,?,?)`,
  ).bind(id, input.automationId, workspaceId, input.workflowInstanceId ?? null, input.commandId, now, now).run();
  const row = await getAutomationWorkflowRun(env, id);
  if (!row) throw new Error("workflow_run_missing");
  return row;
}

export async function getAutomationWorkflowRun(env: Env, id: string): Promise<AutomationWorkflowRunRow | null> {
  return env.AGENT_AUDIT.prepare(`SELECT * FROM automation_workflow_runs WHERE id=?`).bind(id).first<AutomationWorkflowRunRow>();
}

export async function patchAutomationWorkflowRun(
  env: Env,
  id: string,
  patch: Partial<Pick<AutomationWorkflowRunRow, "status" | "approval_id" | "run_id" | "error" | "workflow_instance_id">>,
): Promise<void> {
  const row = await getAutomationWorkflowRun(env, id);
  if (!row) return;
  await env.AGENT_AUDIT.prepare(
    `UPDATE automation_workflow_runs SET status=CASE WHEN answer_summary IS NOT NULL THEN status ELSE ? END,approval_id=?,run_id=?,error=?,workflow_instance_id=?,updated_at=? WHERE id=?`,
  ).bind(
    patch.status ?? row.status,
    patch.approval_id === undefined ? row.approval_id : patch.approval_id,
    patch.run_id === undefined ? row.run_id : patch.run_id,
    patch.error === undefined ? row.error : patch.error,
    patch.workflow_instance_id === undefined ? row.workflow_instance_id : patch.workflow_instance_id,
    Date.now(),
    id,
  ).run();
}

export async function listAutomationWorkflowRuns(env: Env, automationId: string, limit = 32): Promise<AutomationWorkflowRunRow[]> {
  const result = await env.AGENT_AUDIT.prepare(
    `SELECT * FROM automation_workflow_runs WHERE automation_id=? ORDER BY created_at DESC LIMIT ?`,
  ).bind(automationId, limit).all<AutomationWorkflowRunRow>();
  return result.results ?? [];
}

export async function settleRoutineWorkflowRun(env: Env, run: DelegatedRun, answer?: string): Promise<void> {
  if (!run.routineRun || !env.AGENT_AUDIT) return;
  const failure = run.routineOutcome?.failureReason ?? (run.status !== "completed" ? run.error ?? `Run ${run.status}.` : undefined);
  const reason = failure ? redactSecrets(failure).slice(0, 500) : null;
  const outcome = reason ? "failed" : isQuietRoutine(run) ? "quiet" : "normal";
  await env.AGENT_AUDIT.prepare(
    `UPDATE automation_workflow_runs SET run_id=?,status=?,outcome=?,failure_reason=?,answer_summary=?,updated_at=?
     WHERE automation_id=? AND (run_id=? OR approval_id=?)`,
  ).bind(run.runId, reason ? "failed" : "terminal", outcome, reason,
    redactSecrets(answer ?? run.summary ?? "").slice(0, 20_000), Date.now(),
    run.routineRun.automationId, run.runId, run.approval?.approvalId ?? null).run();
}