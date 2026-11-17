import { describe, expect, it } from "vitest";
import { computeNextRunAt, structuredScheduleToCron } from "../src/automation-schedules.js";

describe("automation structured schedules", () => {
  it("compiles daily 09:00 to cron", () => {
    expect(
      structuredScheduleToCron({ mode: "daily", hour: 9, minute: 0, timezone: "Asia/Kolkata" }),
    ).toBe("0 9 * * *");
  });

  it("shows the correct next run for daily 09:00 IST", () => {
    const trigger = {
      kind: "schedule" as const,
      cron: "0 9 * * *",
      timezone: "Asia/Kolkata",
      structured: { mode: "daily" as const, hour: 9, minute: 0, timezone: "Asia/Kolkata" },
    };
    const from = Date.UTC(2026, 10, 14, 3, 30, 0);
    const next = computeNextRunAt(trigger, from);
    expect(next).not.toBeNull();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kolkata",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    }).formatToParts(new Date(next!));
    const hour = parts.find((p) => p.type === "hour")?.value;
    const minute = parts.find((p) => p.type === "minute")?.value;
    expect(hour).toBe("09");
    expect(minute).toBe("00");
  });
});

describe("routine next run", () => {
  const next = (cron: string, timezone: string, from: string) => computeNextRunAt({ kind: "schedule", cron, timezone }, Date.parse(from));

  it("finds the next weekly occurrence rather than a past tick window", () => {
    expect(next("0 9 * * 1", "Asia/Kolkata", "2026-11-17T10:00:00Z")).toBe(Date.parse("2026-11-23T03:30:00Z"));
    expect(next("0 9 * * 1", "Asia/Kolkata", "2026-11-23T03:30:15Z")).toBe(Date.parse("2026-11-30T03:30:00Z"));
  });

  it("keeps wall-clock time across daylight saving changes", () => {
    expect(next("0 9 * * 1", "America/New_York", "2026-03-06T15:00:00Z")).toBe(Date.parse("2026-03-09T13:00:00Z"));
    expect(next("30 2 * * *", "America/New_York", "2026-03-08T06:59:00Z")).toBe(Date.parse("2026-03-09T06:30:00Z"));
    expect(next("30 1 * * *", "America/New_York", "2026-11-01T05:31:00Z")).toBe(Date.parse("2026-11-01T06:30:00Z"));
  });

  it("handles a half-hour DST transition within a UTC hour", () => {
    expect(next("45 2 * * *", "Australia/Lord_Howe", "2026-10-03T15:00:00Z")).toBe(Date.parse("2026-10-03T15:45:00Z"));
  });

  it("returns null for an invalid timezone or impossible annual date", () => {
    expect(next("0 9 * * 1", "Unknown/Zone", "2026-11-17T10:00:00Z")).toBeNull();
    expect(next("0 9 31 2 *", "UTC", "2026-11-17T10:00:00Z")).toBeNull();
  });
});
