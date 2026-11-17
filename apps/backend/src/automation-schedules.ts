/**
 * Friendly structured schedules (interval / daily / weekly / monthly)
 * compiled to five-field cron for the existing tick engine.
 */
import { SCHEDULE_FLOOR_MINUTES, nextScheduleOccurrenceMs, type ScheduleTrigger } from "./automations.js";

export type StructuredSchedule =
  | { mode: "interval"; everyMinutes: number; timezone: string }
  | { mode: "daily"; hour: number; minute: number; timezone: string }
  | { mode: "weekly"; weekday: number; hour: number; minute: number; timezone: string }
  | { mode: "monthly"; dayOfMonth: number; hour: number; minute: number; timezone: string };

export interface ScheduleTriggerWithStructured extends ScheduleTrigger {
  structured?: StructuredSchedule;
}

function clampIntervalMinutes(minutes: number): number {
  const n = Math.floor(minutes);
  return Math.max(SCHEDULE_FLOOR_MINUTES, Math.min(7 * 24 * 60, n));
}

/** Compile a friendly schedule into cron understood by the automation tick. */
export function structuredScheduleToCron(schedule: StructuredSchedule): string {
  switch (schedule.mode) {
    case "interval": {
      const step = clampIntervalMinutes(schedule.everyMinutes);
      return `*/${step} * * * *`;
    }
    case "daily":
      return `${schedule.minute} ${schedule.hour} * * *`;
    case "weekly":
      return `${schedule.minute} ${schedule.hour} * * ${schedule.weekday}`;
    case "monthly":
      return `${schedule.minute} ${schedule.hour} ${schedule.dayOfMonth} * *`;
    default:
      return "0 9 * * *";
  }
}

export function normalizeScheduleTrigger(trigger: ScheduleTriggerWithStructured): ScheduleTrigger {
  if (!trigger.structured) return trigger;
  const cron = structuredScheduleToCron(trigger.structured);
  const timezone = trigger.timezone ?? trigger.structured.timezone;
  return { ...trigger, cron, timezone };
}

/** Next actual scheduler occurrence, using the same cron and timezone as dispatch. */
export function computeNextRunAt(
  trigger: ScheduleTriggerWithStructured,
  fromMs: number = Date.now(),
): number | null {
  const normalized = normalizeScheduleTrigger(trigger);
  return nextScheduleOccurrenceMs(normalized.cron, fromMs, normalized.timezone?.trim() || "UTC");
}
