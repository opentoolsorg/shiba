/**
 * Friendly structured schedules (interval / daily / weekly / monthly)
 * compiled to five-field cron for the existing tick engine.
 */
import { SCHEDULE_FLOOR_MINUTES, scheduleOccurrenceMs, type ScheduleTrigger } from "./automations.js";

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

const DOW_INTL: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function partsInZone(ms: number, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(new Date(ms));
  const read = (type: string) => parts.find((p) => p.type === type)?.value;
  return {
    year: Number(read("year")),
    month: Number(read("month")),
    day: Number(read("day")),
    hour: Number(read("hour")),
    minute: Number(read("minute")),
    weekday: DOW_INTL[read("weekday") ?? "Sun"] ?? 0,
  };
}

function matchesStructured(structured: StructuredSchedule, ms: number, tz: string): boolean {
  const p = partsInZone(ms, tz);
  switch (structured.mode) {
    case "interval":
      return ms % (clampIntervalMinutes(structured.everyMinutes) * 60_000) === 0;
    case "daily":
      return p.hour === structured.hour && p.minute === structured.minute;
    case "weekly":
      return p.weekday === structured.weekday && p.hour === structured.hour && p.minute === structured.minute;
    case "monthly":
      return p.day === structured.dayOfMonth && p.hour === structured.hour && p.minute === structured.minute;
    default:
      return false;
  }
}

/**
 * Next scheduled run instant for display (for example daily 09:00 IST).
 */
export function computeNextRunAt(
  trigger: ScheduleTriggerWithStructured,
  fromMs: number = Date.now(),
): number | null {
  const normalized = normalizeScheduleTrigger(trigger);
  const tz = normalized.timezone?.trim() || normalized.structured?.timezone?.trim() || "UTC";
  const structured = trigger.structured;
  if (structured) {
    for (let offset = 0; offset < 366 * 24 * 60; offset++) {
      const ms = fromMs + offset * 60_000;
      if (matchesStructured(structured, ms, structured.timezone || tz)) {
        return ms - (ms % 60_000);
      }
    }
    return null;
  }
  const next = scheduleOccurrenceMs(normalized.cron, fromMs + 60_000, tz);
  return next ?? scheduleOccurrenceMs(normalized.cron, fromMs, tz);
}