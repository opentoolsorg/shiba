import type { ExecutionTarget } from "@shiba/shared";

export interface RoutineSource {
  prompt: string;
  repoUrl?: string;
  executionTarget?: ExecutionTarget;
  customAgentId?: string;
}
export interface RoutineInfo {
  id: string;
  name: string;
  schedule: string;
  nextRunAt: number | null;
  timezone?: string;
}
export interface RoutineRecord extends RoutineSource {
  id: string;
  name?: string;
  enabled: boolean;
  skipWhilePending?: boolean;
  nextRunAt?: number | null;
  lastTriggeredAt?: number;
  occurrences?: { runId?: string; approvalId?: string; outcome: string }[];
  triggers: { kind: string; cron?: string; timezone?: string }[];
}
export type RoutinePreset = "daily" | "weekdays" | "weekly" | "monthly" | "custom";
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function routineCron(preset: RoutinePreset, time: string, weekday: number, day: number, custom: string): string {
  const [hour = Number.NaN, minute = Number.NaN] = time.split(":").map(Number);
  if (preset === "custom") return custom.trim();
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new Error("Choose a valid time.");
  switch (preset) {
    case "daily": return `${minute} ${hour} * * *`;
    case "weekdays": return `${minute} ${hour} * * 1-5`;
    case "weekly": return `${minute} ${hour} * * ${weekday}`;
    case "monthly": return `${minute} ${hour} ${day} * *`;
  }
}

export function routineCadence(cron: string, timezone = "UTC"): string {
  const [minute = "", hour = "", day = "", month = "", weekday = ""] = cron.split(/\s+/);
  if (/^\d+$/.test(minute ?? "") && /^\d+$/.test(hour ?? "") && month === "*") {
    const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
    const cadence = day !== "*" ? `Every month on ${day}` : weekday === "*" ? "Every day" : weekday === "1-5" ? "Every weekday" : WEEKDAYS[Number(weekday)] ? `Every ${WEEKDAYS[Number(weekday)]}` : null;
    if (cadence) return `${cadence} ${time} (${timezone})`;
  }
  return `${cron} (${timezone})`;
}

export function routineInfo(record: RoutineRecord): RoutineInfo {
  const trigger = record.triggers.find((item) => item.kind === "schedule");
  return { id: record.id, name: record.name || (record.prompt.split("\n")[0] ?? "").slice(0, 120), schedule: trigger?.cron ?? "", timezone: trigger?.timezone ?? "UTC", nextRunAt: record.nextRunAt ?? null };
}

export function routineSourceFromRun(run: { task: string; repoUrl: string; baseBranch: string; executionTarget?: ExecutionTarget; customAgentId?: string }): RoutineSource {
  return {
    prompt: run.task,
    repoUrl: run.repoUrl || undefined,
    executionTarget: run.executionTarget ?? { kind: "repository", repoUrl: run.repoUrl, baseBranch: run.baseBranch.trim() || "main" },
    customAgentId: run.customAgentId,
  };
}
