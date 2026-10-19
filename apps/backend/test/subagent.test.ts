import { describe, expect, it } from "vitest";
import {
  canSpawnSubagentAt,
  nextSubagentPath,
  resolveSubagentSandboxId,
  subagentDepth,
} from "@shiba/shared";

describe("subagent tree", () => {
  it("caps depth at three", () => {
    expect(subagentDepth("1")).toBe(1);
    expect(canSpawnSubagentAt("1.2.3")).toBe(false);
    expect(canSpawnSubagentAt("1.2")).toBe(true);
  });

  it("allocates dotted sibling paths", () => {
    expect(nextSubagentPath(undefined, [])).toBe("1");
    expect(nextSubagentPath("1", ["1.1", "1.2"])).toBe("1.3");
    expect(nextSubagentPath("2", ["2.1"])).toBe("2.2");
  });

  it("reuses parent sandbox id in shared mode", () => {
    const parent = { sandboxId: "run-abc", runId: "r1" };
    expect(resolveSubagentSandboxId(parent, "shared", "run-fresh")).toBe("run-abc");
    expect(resolveSubagentSandboxId(parent, "fresh", "run-fresh")).toBe("run-fresh");
  });
});
