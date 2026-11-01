// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ApprovalCard } from "./ApprovalCard";

afterEach(cleanup);
const approval = {
  approvalId: "approval-1", messageId: "message-1", toolCallId: "tool-1", tool: "runTask",
  input: { repoUrl: "https://github.com/acme/shop", baseBranch: "fix/receipt", task: "Fix receipts", route: "coding-model" },
};

describe("ApprovalCard", () => {
  it("keeps the frozen payload visible and requires an explicit decision", () => {
    const decide = vi.fn();
    render(<ApprovalCard approval={approval} decided={false} onDecideApproval={decide} />);
    expect(screen.getByRole("status").textContent).toBe("Waiting for your approval");
    expect(screen.getByText(/https:\/\/github.com\/acme\/shop/).textContent).toContain("coding-model");
    expect(decide).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(decide).toHaveBeenCalledWith("approval-1", true);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(decide).toHaveBeenCalledWith("approval-1", false);
  });

  it("shows a neutral status for a recorded decision with an unavailable outcome", () => {
    render(<ApprovalCard approval={approval} decided onDecideApproval={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toBe("Decision recorded");
    expect(screen.queryByText("Needs approval")).toBeNull();
    for (const button of screen.getAllByRole("button")) expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([[true, "Approved — sandbox starting"], [false, "Rejected — nothing ran"]] as const)("explains settled decision %s", (decision, message) => {
    render(<ApprovalCard approval={approval} decided decision={decision} onDecideApproval={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toBe(message);
    for (const button of screen.getAllByRole("button")) expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
