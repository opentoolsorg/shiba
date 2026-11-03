// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DiffView } from "./DiffView";
import type { VMRun } from "../types";

afterEach(() => cleanup());

function run(partial: Partial<VMRun> & Pick<VMRun, "runId" | "status">): VMRun {
  return {
    sandboxId: partial.runId,
    repoUrl: "https://github.com/acme/shop",
    task: partial.task ?? partial.runId,
    baseBranch: "main",
    publishPullRequest: false,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

const patch = "diff --git a/src/cart.ts b/src/cart.ts\n--- a/src/cart.ts\n+++ b/src/cart.ts\n@@ -1 +1 @@\n-old\n+new\n";

describe("DiffView", () => {
  it("scopes the empty state to recorded runs", () => {
    render(<DiffView runs={[]} />);
    expect(screen.getByRole("heading", { name: "No runs yet" })).toBeTruthy();
    expect(screen.queryByText("No changes to review")).toBeNull();
  });

  it("opens the newest run that has a patch when nothing is selected", () => {
    render(
      <DiffView
        runs={[
          run({
            runId: "run-audit",
            status: "running",
            task: "Add a hash",
            createdAt: 20,
            repoUrl: "https://github.com/acme/api",
          }),
          run({
            runId: "run-receipt",
            status: "completed",
            task: "Fix the receipt total",
            createdAt: 10,
            diff: patch,
          }),
        ]}
      />,
    );

    expect(screen.getByRole("region", { name: "Diff for run-receipt" })).toBeTruthy();
    expect(screen.queryByText("No diff yet")).toBeNull();
  });

  it("explains a selected run that has not written a diff", () => {
    render(
      <DiffView
        runs={[
          run({ runId: "run-audit", status: "running", task: "Add a hash", createdAt: 20 }),
        ]}
        selectedRunId="run-audit"
      />,
    );

    expect(screen.getByRole("heading", { name: "No diff yet" })).toBeTruthy();
    expect(screen.getByText(/still writing files/)).toBeTruthy();
  });
});
