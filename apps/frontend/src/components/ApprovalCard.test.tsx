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
  it("shows saved login metadata only and never describes sign-in as a sandbox action", () => {
    const decide = vi.fn();
    const signIn = { ...approval, tool: "browser_sign_in", input: { loginId: "fixture-login-id", label: "Example Portal", password: "fixture-not-for-display" } };
    const { rerender } = render(<ApprovalCard approval={signIn} decided={false} onDecideApproval={decide} />);
    expect(screen.getByText("Confirm saved sign-in")).toBeTruthy();
    expect(screen.getByText("Example Portal")).toBeTruthy();
    expect(screen.getByText("fixture-login-id")).toBeTruthy();
    expect(screen.queryByText(/fixture-not-for-display|sandbox/)).toBeNull();
    expect(decide).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(decide).toHaveBeenCalledWith("approval-1", true);
    rerender(<ApprovalCard approval={signIn} decided decision onDecideApproval={decide} />);
    expect(screen.getByRole("status").textContent).toBe("Approved — saved sign-in permitted");
  });
  it("identifies the cloud computer from the inline approval input, not ordinary runs", () => {
    const { rerender } = render(<ApprovalCard approval={{ ...approval, input: { ...approval.input, computer: true } }} decided={false} onDecideApproval={vi.fn()} />);
    expect(screen.getByText("Uses a cloud computer")).toBeTruthy();
    rerender(<ApprovalCard approval={{ ...approval, computer: true }} decided={false} onDecideApproval={vi.fn()} />);
    expect(screen.getByText("Uses a cloud computer")).toBeTruthy();
    rerender(<ApprovalCard approval={{ ...approval, computer: false, input: { ...approval.input, computer: true } }} decided={false} onDecideApproval={vi.fn()} />);
    expect(screen.queryByText("Uses a cloud computer")).toBeNull();
    rerender(<ApprovalCard approval={approval} decided={false} onDecideApproval={vi.fn()} />);
    expect(screen.queryByText("Uses a cloud computer")).toBeNull();
  });

  it("explains the paid provider action and preserves its frozen inputs", () => {
    const videoApproval = { ...approval, tool: "generate_video", input: { prompt: "A bird in flight", duration: 8 } };
    const { rerender } = render(<ApprovalCard approval={videoApproval} decided={false} onDecideApproval={vi.fn()} />);
    expect(screen.getByText(/This spends money on that provider account/)).toBeTruthy();
    expect(screen.getByText(/A bird in flight/).textContent).toContain('"duration": 8');
    expect(screen.queryByText(/isolated sandbox/)).toBeNull();
    rerender(<ApprovalCard approval={videoApproval} decided decision onDecideApproval={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toBe("Approved — paid video generation permitted");
  });

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

  it.each([[true, "Approved — sandbox starting"], [false, "Denied. This decision is final."]] as const)("explains settled decision %s", (decision, message) => {
    render(<ApprovalCard approval={approval} decided decision={decision} onDecideApproval={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toBe(message);
    for (const button of screen.getAllByRole("button")) expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
