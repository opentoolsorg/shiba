// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TaskComposer } from "./TaskComposer";

afterEach(() => cleanup());

const routing = {
  codingModel: "",
  connectionId: "",
  onCodingModelChange: vi.fn(),
  onConnectionChange: vi.fn(),
};

function renderComposer(variant: "hero" | "docked", options: { customAgentId?: string; customAgentsLoading?: boolean; repoUrl?: string; task?: string } = {}) {
  render(
    <TaskComposer
      repoUrl={options.repoUrl ?? ""}
      task={options.task ?? ""}
      baseBranch="main"
      publishPullRequest={false}
      harness="opencode"
      routing={routing}
      busy={false}
      isSubmitting={false}
      clearing={false}
      onRepoUrlChange={vi.fn()}
      onTaskChange={vi.fn()}
      onBaseBranchChange={vi.fn()}
      onPublishPullRequestChange={vi.fn()}
      onHarnessChange={vi.fn()}
      onSubmit={vi.fn()}
      onClear={vi.fn()}
      variant={variant}
      customAgentId={options.customAgentId}
      customAgentsLoading={options.customAgentsLoading}
    />,
  );
}

describe("TaskComposer", () => {
  it("states the empty-thread prompt and keeps send disabled until there is a task", () => {
    renderComposer("hero");
    expect(screen.getByRole("heading", { name: "What should Shiba change?" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Task description" }).getAttribute("placeholder")).toBe(
      "Describe the change in this repository",
    );
    expect(screen.getByRole("button", { name: "Send task" }).hasAttribute("disabled")).toBe(true);
  });

  it("docks without the empty-thread heading once a run is going", () => {
    renderComposer("docked");
    expect(screen.queryByRole("heading", { name: "What should Shiba change?" })).toBeNull();
  });

  it("shows an unavailable saved bot and prevents a silent fallback to the standard agent", () => {
    renderComposer("docked", { customAgentId: "deleted-bot", repoUrl: "https://github.com/example/a", task: "Fix login" });
    expect(screen.getByRole("status").textContent).toContain("Bot unavailable");
    expect(screen.getByRole("button", { name: "Send task" }).hasAttribute("disabled")).toBe(true);
  });

  it("distinguishes a loading bot from a deleted bot", () => {
    renderComposer("docked", { customAgentId: "pending-bot", customAgentsLoading: true });
    expect(screen.getByRole("status").textContent).toContain("Loading bot");
    expect(screen.queryByText(/Bot unavailable/)).toBeNull();
  });
});
