import { describe, expect, it } from "vitest";
import type { DesktopStatus } from "@shiba/shared";
import { formatDesktopConnectionLabel, formatDesktopHarnessSummary } from "@shiba/shared";

describe("formatDesktopConnectionLabel", () => {
  it("uses the acceptance phrase when idle", () => {
    expect(formatDesktopConnectionLabel({ state: "idle", machineId: "m1" })).toBe("This computer · idle");
  });

  it("keeps the busy row free of repository names", () => {
    expect(formatDesktopConnectionLabel({ state: "busy", machineId: "m1", activeRunId: "r1" })).toBe(
      "This computer · running",
    );
  });

  it("builds offline copy from typed reasons", () => {
    expect(formatDesktopConnectionLabel({ state: "offline", reason: "retrying", retryInMs: 8000 })).toBe(
      "This computer · offline · retrying in 8s",
    );
    expect(formatDesktopConnectionLabel({ state: "offline", reason: "daemon-stopped" })).toBe(
      "This computer · offline · daemon stopped",
    );
    expect(formatDesktopConnectionLabel({ state: "offline" })).toBe("This computer · offline");
  });

  it("shows a crash as an exit code, never daemon text", () => {
    expect(formatDesktopConnectionLabel({ state: "crashed", reason: "exit", exitCode: 78 })).toBe(
      "Daemon crashed · exit 78",
    );
    expect(formatDesktopConnectionLabel({ state: "crashed" })).toBe("Daemon crashed · check logs");
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
