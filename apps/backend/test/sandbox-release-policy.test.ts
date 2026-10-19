import { describe, expect, it } from "vitest";
import { shouldDestroySandboxAfterRun } from "../src/sandbox/release-policy.js";
import type { DelegatedRun } from "../src/runs.js";

function run(partial: Partial<DelegatedRun> & Pick<DelegatedRun, "runId" | "sandboxId" | "status">): DelegatedRun {
  return {
    repoUrl: "https://github.com/a/b",
    task: "t",
    generation: 0,
    ...partial,
  } as DelegatedRun;
}

describe("shouldDestroySandboxAfterRun", () => {
  it("does not destroy while another active run shares the sandbox", () => {
    const parent = run({ runId: "parent", sandboxId: "run-shared", status: "completed" });
    const child = run({ runId: "child", sandboxId: "run-shared", status: "running", subagentSandbox: "shared" });
    expect(shouldDestroySandboxAfterRun(parent, [parent, child])).toBe(false);
  });

  it("destroys when no other active run shares the sandbox", () => {
    const parent = run({ runId: "parent", sandboxId: "run-shared", status: "completed" });
    const child = run({ runId: "child", sandboxId: "run-shared", status: "completed", subagentSandbox: "shared" });
    expect(shouldDestroySandboxAfterRun(parent, [parent, child])).toBe(true);
  });
});
