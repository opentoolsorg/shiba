// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { BotRunWorkspace, RunWorkPlan } from "./BotRunWorkspace";
import type { VMRun } from "../types";

afterEach(cleanup);

const run = (overrides: Partial<VMRun>): VMRun => ({
  runId: "run-1",
  sandboxId: "sb",
  repoUrl: "https://github.com/o/r",
  task: "Fix tests",
  baseBranch: "main",
  publishPullRequest: false,
  status: "running",
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
});

const states = (value: VMRun) => Object.fromEntries(new RunWorkPlan(value).steps().map((step) => [step.id, step.state]));

describe("RunWorkPlan", () => {
  it("keeps the run on the approval step until a human approves", () => {
    expect(states(run({ status: "pending" }))).toEqual({ queued: "done", approval: "current", running: "todo", result: "todo" });
  });

  it("tracks running, completed, and failed runs from persisted status", () => {
    expect(states(run({ status: "running" }))).toMatchObject({ approval: "done", running: "current", result: "todo" });
    expect(states(run({ status: "completed" }))).toMatchObject({ running: "done", result: "done" });
    expect(states(run({ status: "error" }))).toMatchObject({ running: "failed", result: "failed" });
  });

  it("labels artifact-workspace runs as having no repository", () => {
    const plan = new RunWorkPlan(run({ repoUrl: "", executionTarget: { kind: "artifact-workspace", workspaceName: "Brief", expectedDeliverables: ["deliverables/brief.md"] } }));
    expect(plan.targetLabel).toBe("Artifact workspace “Brief” · no repository");
  });
});

describe("BotRunWorkspace", () => {
  it("renders plan, children, and the persisted diff in one place", () => {
    const diff = "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n";
    render(<BotRunWorkspace run={run({ status: "completed", diff })} botName="Scout"><p>live panel</p></BotRunWorkspace>);
    expect(screen.getByRole("heading", { name: "Scout · work" })).toBeTruthy();
    expect(screen.getByText("live panel")).toBeTruthy();
    expect(screen.getByTestId("run-files-changed")).toBeTruthy();
    expect(screen.queryByTestId("run-synthetic-badge")).toBeNull();
  });

  it("labels stand-in results as synthetic", () => {
    render(<BotRunWorkspace run={run({ status: "completed", summary: "verify-shiba stand-in coding run completed." })}>{null}</BotRunWorkspace>);
    expect(screen.getByTestId("run-synthetic-badge").textContent).toContain("Synthetic execution");
  });

  it("renders nothing without a run", () => {
    const { container } = render(<BotRunWorkspace run={undefined}>{null}</BotRunWorkspace>);
    expect(container.firstChild).toBeNull();
  });
});
