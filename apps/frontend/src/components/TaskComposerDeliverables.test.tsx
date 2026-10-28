// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { TaskComposer } from "./TaskComposer";

afterEach(cleanup);

it("shows the chosen bot's required output contract before submission and updates when switching bots", () => {
  const props = {
    repoUrl: "https://github.com/example/work", task: "Plan the launch", baseBranch: "main",
    publishPullRequest: false, harness: "claude-code", busy: false, isSubmitting: false, clearing: false,
    routing: { codingModel: "", connectionId: "", onCodingModelChange: vi.fn(), onConnectionChange: vi.fn() },
    onRepoUrlChange: vi.fn(), onTaskChange: vi.fn(), onBaseBranchChange: vi.fn(), onPublishPullRequestChange: vi.fn(),
    onHarnessChange: vi.fn(), onSubmit: vi.fn(), onClear: vi.fn(),
    customAgents: [
      { id: "marketing", name: "Marketing bot", slug: "marketing", expectedDeliverables: ["marketing/brief.md", "marketing/campaign.md"] },
      { id: "research", name: "Research bot", slug: "research", expectedDeliverables: ["research/report.md"] },
    ],
  };
  const { rerender } = render(<TaskComposer {...props} customAgentId="marketing" />);
  const outputs = screen.getByRole("list", { name: "Required deliverables" });
  expect(within(outputs).getByText("marketing/brief.md")).toBeTruthy();
  expect(within(outputs).getByText("marketing/campaign.md")).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Task description" }).getAttribute("placeholder")).toContain("outcome and facts");
  expect(props.onSubmit).not.toHaveBeenCalled();

  rerender(<TaskComposer {...props} customAgentId="research" />);
  expect(screen.queryByText("marketing/brief.md")).toBeNull();
  expect(within(screen.getByRole("list", { name: "Required deliverables" })).getByText("research/report.md")).toBeTruthy();

  rerender(<TaskComposer {...props} customAgentId="" />);
  expect(screen.queryByRole("list", { name: "Required deliverables" })).toBeNull();
  expect(screen.getByRole("textbox", { name: "Task description" }).getAttribute("placeholder")).toBe("Describe the change in this repository");
});
