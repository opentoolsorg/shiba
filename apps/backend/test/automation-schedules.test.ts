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