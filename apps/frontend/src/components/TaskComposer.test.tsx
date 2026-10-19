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

function renderComposer(variant: "hero" | "docked") {
  render(
    <TaskComposer
      repoUrl=""
      task=""
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
});
