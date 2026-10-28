// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

afterEach(() => cleanup());
import { StoredApprovalCard } from "./WorkspacePanel";
import type { StoredApproval } from "../types";

const approval: StoredApproval = {
  approvalId: "ap-1",
  threadKey: "",
  repoUrl: "https://github.com/o/r",
  task: "Ship fix",
  createdAt: Date.now(),
  status: "pending",
  kind: "run",
  publishPullRequest: true,
  reviewAfterPublish: true,
};

describe("StoredApprovalCard", () => {
  it("shows the frozen deliverable requirements before approving that exact record", () => {
    const frozen: StoredApproval = { ...approval, customAgentVersion: 2, expectedDeliverables: ["marketing/brief.md", "marketing/campaign.md"] };
    const onDecide = vi.fn();
    const { container } = render(<StoredApprovalCard approval={frozen} decided={false} onDecide={onDecide} />);
    const required = screen.getByRole("list", { name: "Frozen required deliverables" });
    expect(within(required).getByText("marketing/brief.md")).toBeTruthy();
    expect(within(required).getByText("marketing/campaign.md")).toBeTruthy();
    expect(screen.getByText("Bot profile v2")).toBeTruthy();
    expect(JSON.parse(container.querySelector("pre")!.textContent!).expectedDeliverables).toEqual(frozen.expectedDeliverables);
    expect(onDecide).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onDecide).toHaveBeenCalledExactlyOnceWith(frozen, true);
  });

  it("explains approve vs reject before decision", () => {
    render(<StoredApprovalCard approval={approval} decided={false} onDecide={vi.fn()} />);
    expect(screen.getByText(/Approve to start the run/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("labels buttons after approval", () => {
    render(
      <StoredApprovalCard approval={approval} decided decision={true} onDecide={vi.fn()} />,
    );
    const approved = screen.getByRole("button", { name: "Approved" }) as HTMLButtonElement;
    expect(approved.disabled).toBe(true);
    expect(approved.closest("div")?.querySelectorAll("button")).toHaveLength(2);
  });
});
