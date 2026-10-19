// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

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
