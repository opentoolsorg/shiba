import { describe, expect, it } from "vitest";
import { bucketContributionWeeks, contributionLevel } from "./activity-heatmap";

const DAY_MS = 86_400_000;

/** Consecutive UTC days ending at `end` (YYYY-MM-DD), oldest first. */
function daysEnding(end: string, n: number, count = 1): { date: string; count: number }[] {
  const endMs = Date.parse(`${end}T00:00:00Z`);
  const days: { date: string; count: number }[] = [];
  for (let i = n - 1; i >= 0; i--) {
    days.push({ date: new Date(endMs - i * DAY_MS).toISOString().slice(0, 10), count });
  }
  return days;
}

describe("bucketContributionWeeks", () => {
  it("fills 52 Monday-first columns exactly when the window ends on a Sunday", () => {
    // 2026-10-11 is a Sunday, so the window aligns to whole weeks.
    const days = daysEnding("2026-10-11", 364);
    const grid = bucketContributionWeeks(days);

    expect(grid.columns).toHaveLength(52);
    expect(grid.columns.every((column) => column.days.every((cell) => cell !== null))).toBe(true);
    expect(grid.columns[0]?.days[0]?.date).toBe(days[0]?.date);
    expect(grid.columns[51]?.days[6]?.date).toBe("2026-10-11");
  });

  it("right-pads a mid-week ending and drops days older than the window", () => {
    // 2026-10-14 is a Wednesday, so the last column holds Mon–Wed only.
    const days = daysEnding("2026-10-14", 364);
    const grid = bucketContributionWeeks(days);

    const lastColumn = grid.columns[51];
    expect(lastColumn?.days[2]?.date).toBe("2026-10-14");
    expect(lastColumn?.days[3]).toBeNull();
    // The window's first Monday is 2025-10-20; the four older days drop off.
    expect(grid.columns[0]?.days[0]?.date).toBe("2025-10-20");
    expect(days.some((day) => day.date === "2025-10-19")).toBe(true);
    expect(
      grid.columns.some((column) => column.days.some((cell) => cell?.date === "2025-10-19")),
    ).toBe(false);
  });

  it("labels the column that contains the 1st of each month", () => {
    // Window = 6 columns: Aug 31–Sep 6 … Oct 5–11.
    const days = daysEnding("2026-10-10", 42);
    const grid = bucketContributionWeeks(days, 6);

    expect(grid.columns.map((column) => column.monthLabel)).toEqual([
      "Sep",
      null,
      null,
      null,
      "Oct",
      null,
    ]);
  });
});

describe("contributionLevel", () => {
  it("buckets counts into quartiles of the window max", () => {
    expect(contributionLevel(0, 10)).toBe(0);
    expect(contributionLevel(5, 0)).toBe(0);
    expect(contributionLevel(1, 10)).toBe(1);
    expect(contributionLevel(4, 10)).toBe(2);
    expect(contributionLevel(7, 10)).toBe(3);
    expect(contributionLevel(9, 10)).toBe(4);
  });
});
