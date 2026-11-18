import { describe, expect, it } from "vitest";
import { dependentRuns, serializeRun, terminalStatusFor } from "../src/agents/orchestrator-projections.js";
import type { DelegatedRun } from "../src/runs.js";

const run = (runId: string, extra: Partial<DelegatedRun> = {}) => ({
  runId,
  status: "completed",
  task: runId,
  repoUrl: "https://github.com/example/repo",
  createdAt: 1,
  updatedAt: 1,
  ...extra,
}) as DelegatedRun;

describe("orchestrator pure projections", () => {
  it("maps classified failures to their stable terminal statuses", () => {
    expect(terminalStatusFor("cancelled")).toBe("cancelled");
    expect(terminalStatusFor("outcome_unknown")).toBe("unknown");
    expect(terminalStatusFor("container_lost")).toBe("unknown");
    expect(terminalStatusFor("server_error")).toBe("error");
  });

  it("finds descendants through terminal intermediaries and breaks cycles", () => {
    const runs = [
      run("child", { parentRunId: "root" }),
      run("grandchild", { parentRunId: "child" }),
      run("review", { reviewOf: "grandchild" }),
      run("cycle", { parentRunId: "review" }),
      run("root", { parentRunId: "cycle" }),
      run("unrelated"),
    ];
    expect(dependentRuns(runs, "root").map((item) => item.runId)).toEqual(["child", "grandchild", "review", "cycle"]);
  });

  it("does not expose sealed environment data in API projections", () => {
    const source = run("private", { envSealed: "sealed" });
    expect(serializeRun(source)).not.toHaveProperty("envSealed");
    expect(source.envSealed).toBe("sealed");
  });
});
