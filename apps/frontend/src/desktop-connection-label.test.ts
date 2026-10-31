import { describe, expect, it } from "vitest";
import type { DesktopStatus } from "@shiba/shared";
import { formatDesktopConnectionLabel, formatDesktopHarnessSummary } from "@shiba/shared";

describe("formatDesktopConnectionLabel", () => {
  it("uses the acceptance phrase when idle", () => {
    expect(formatDesktopConnectionLabel({ state: "idle", machineId: "m1" })).toBe("This computer · idle");
  });

  it("includes run detail when busy", () => {
    expect(
      formatDesktopConnectionLabel({ state: "busy", machineId: "m1", detail: "acme/widgets" }),
    ).toBe("This computer · running · acme/widgets");
  });

  it("names the other origin when paired elsewhere", () => {
    expect(
      formatDesktopConnectionLabel({
        state: "paired-elsewhere",
        pairedTo: "https://other.example.com",
      }),
    ).toBe("Paired to https://other.example.com");
  });
});

describe("formatDesktopHarnessSummary", () => {
  it("marks agy as listed only", () => {
    expect(formatDesktopHarnessSummary(["claude", "agy"])).toBe("claude, agy (listed only)");
  });

  it("returns null for an empty list", () => {
    expect(formatDesktopHarnessSummary([])).toBeNull();
  });
});
