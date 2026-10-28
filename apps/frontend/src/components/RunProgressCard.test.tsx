// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RunProgressCard } from "./RunProgressCard";
import type { RetainedRun } from "../types";

afterEach(cleanup);

const baseRun = (overrides: Partial<RetainedRun>): RetainedRun =>
  ({
    runId: "run-abc",
    sandboxId: "sb",
    repoUrl: "https://github.com/o/r",
    task: "Fix tests",
    baseBranch: "main",
    publishPullRequest: false,
    generation: 1,
    status: "running",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }) as RetainedRun;

describe("RunProgressCard", () => {
  it("shows the profile revision actually retained by a run", () => {
    render(<RunProgressCard run={baseRun({ customAgentId: "cag-a", customAgentVersion: 2 })} />);
    expect(screen.getByTestId("run-agent-version").textContent).toBe("Bot profile v2");
  });
  it("returns null without a run", () => {
    const { container } = render(<RunProgressCard run={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows in-flight guidance for running status", () => {
    render(<RunProgressCard run={baseRun({ status: "running" })} />);
    expect(screen.getByTestId("run-progress").getAttribute("data-run-status")).toBe("running");
    expect(screen.getByText(/Sandbox run in progress/i)).toBeTruthy();
  });

  it("links pullUrl when present", () => {
    render(
      <RunProgressCard
        run={baseRun({
          status: "completed",
          pullUrl: "https://github.com/o/r/pull/3",
        })}
      />,
    );
    expect(screen.getByTestId("run-pull-link").getAttribute("href")).toBe("https://github.com/o/r/pull/3");
  });
});
