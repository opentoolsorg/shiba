import type { Automation } from "./automations.js";
import { computeNextRunAt } from "./automation-schedules.js";
import { automationsStub } from "./automations-stub.js";
import type { Env } from "./env.js";

export interface RoutineMetadata {
  id: string;
  name: string;
  schedule: string;
  timezone: string;
  nextRunAt: number | null;
}

type RoutineRecord = Automation & { nextRunAt?: number | null };

export async function readRoutines(env: Env): Promise<RoutineRecord[]> {
  if (!env.Automations) return [];
  try {
    const response = await automationsStub(env).fetch(new Request("https://internal/api/automations"));
    if (!response.ok) return [];
    const body = await response.json() as { automations?: RoutineRecord[] };
    return (body.automations ?? []).filter((automation) => automation.triggers.some((trigger) => trigger.kind === "schedule"));
  } catch {
    // Task and approval history remain available if schedule storage is unavailable.
    return [];
  }
}

export function routineMetadata(automation: RoutineRecord): RoutineMetadata | undefined {
  const schedule = automation.triggers.find((trigger) => trigger.kind === "schedule");
  if (!schedule) return undefined;
  return {
    id: automation.id,
    name: automation.name ?? (automation.prompt.split("\n")[0] ?? "").slice(0, 120),
    schedule: schedule.cron,
    timezone: schedule.timezone ?? "UTC",
    nextRunAt: automation.enabled ? automation.nextRunAt ?? computeNextRunAt(schedule) : null,
  };
}

export function routineForRecord(
  record: { threadKey?: string; approvalId?: string; runId?: string; attempts?: { approvalId?: string; runId?: string }[] },
  automations: RoutineRecord[],
): RoutineMetadata | undefined {
  const identities = record.attempts ?? [record];
  const automation = automations.find((item) => record.threadKey === `automation:${item.id}` ||
    item.occurrences?.some((occurrence) => identities.some((identity) =>
      (identity.approvalId !== undefined && identity.approvalId === occurrence.approvalId) ||
      (identity.runId !== undefined && identity.runId === occurrence.runId),
    )));
  return automation ? routineMetadata(automation) : undefined;
}
