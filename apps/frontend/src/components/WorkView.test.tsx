// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WorkView } from "./WorkView";
import type { RetainedRun, StoredApproval } from "../types";

afterEach(() => cleanup());

const mockRuns: RetainedRun[] = [
  {
    runId: "run-1",
    task: "Retry webhook handler",
    repoUrl: "https://github.com/acme/api",
    status: "running",
    sandboxId: "sb-1",
    baseBranch: "main",
    publishPullRequest: false,
    generation: 1,
    createdAt: Date.now() - 100_000,
    updatedAt: Date.now() - 50_000,
  },
  {
    runId: "run-2",
    task: "Fix flaky checkout test",
    repoUrl: "https://github.com/acme/web",
    status: "completed",
    sandboxId: "sb-2",
    baseBranch: "main",
    publishPullRequest: true,
    pullUrl: "https://github.com/acme/web/pull/1",
    generation: 1,
    createdAt: Date.now() - 200_000,
    updatedAt: Date.now() - 120_000,
  },
  {
    runId: "run-3",
    task: "Bump Node to 22",
    repoUrl: "https://github.com/acme/infra",
    status: "completed",
    sandboxId: "sb-3",
    baseBranch: "main",
    publishPullRequest: false,
    generation: 1,
    createdAt: Date.now() - 300_000,
    updatedAt: Date.now() - 250_000,
  },
];

const mockApprovals: StoredApproval[] = [
  {
    threadKey: "th-1",
    approvalId: "app-1",
    task: "Add pagination to audit log API",
    repoUrl: "https://github.com/acme/api",
    status: "pending",
    createdAt: Date.now() - 30_000,
    payload: {},
  },
];

describe("WorkView", () => {
  it("derives published PRs from pullUrl, excludes archived runs and separates unsuccessful runs", () => {
    const base = mockRuns[2]!;
    render(<WorkView runs={[
      { ...base, runId: "requested", task: "Requested only", publishPullRequest: true },
      { ...base, runId: "published", task: "Published", publishPullRequest: false, pullUrl: "https://github.com/acme/infra/pull/2" },
      { ...base, runId: "archived", task: "Archived", archivedAt: 1 },
      ...(["error", "aborted", "cancelled", "unknown"] as const).map((status) => ({ ...base, runId: status, task: `Unsuccessful ${status}`, status })),
    ]} sessions={[{ id: "archived", title: "Archived session", status: "completed", repoName: "infra", updatedAt: 1 }]} />);
    expect(within(screen.getByRole("region", { name: "PR open - 1" })).getByText("Published")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Done - 1" })).getByText("Requested only")).toBeTruthy();
    const attention = screen.getByRole("region", { name: "Needs attention - 4" });
    expect(within(attention).getAllByRole("button")).toHaveLength(4);
    expect(screen.queryByText("Archived")).toBeNull();
    expect(screen.queryByText("Archived session")).toBeNull();
    expect(screen.getByText("1 open")).toBeTruthy();
  });

  it("passes approval kind from every view without inventing repository metadata", () => {
    const onSelectTask = vi.fn();
    render(<WorkView pendingApprovals={[{ approvalId: "chat", messageId: "msg", toolCallId: "tool", tool: "shell", input: {} }]} onSelectTask={onSelectTask} />);
    for (const mode of ["List", "Board", "Timeline"]) {
      fireEvent.click(screen.getByRole("button", { name: mode }));
      fireEvent.click(screen.getByRole("button", { name: /Approve tool: shell/ }));
      expect(onSelectTask).toHaveBeenLastCalledWith("chat", "approval");
    }
    expect(screen.queryByText("repository")).toBeNull();
  });
  it("renders breadcrumb and counts open tasks", () => {
    render(<WorkView runs={mockRuns} storedApprovals={mockApprovals} />);
    expect(screen.getByText("Personal")).toBeTruthy();
    expect(screen.getByText("Work")).toBeTruthy();
    expect(screen.getByText(/3 open/)).toBeTruthy();
    const running = screen.getByRole("region", { name: "Running - 1" });
    expect(running.querySelector("summary")?.textContent).toBe("Running1 item");
    const done = screen.getByRole("region", { name: "Done - 1" });
    expect(done.querySelector("summary")?.textContent).toBe("Done1 item");
    const attention = screen.getByRole("region", { name: "Needs attention - 0" });
    expect(attention.querySelector("summary")?.textContent).toBe("Needs attention0 items");
  });

  it("switches between List, Board, and Timeline views", () => {
    render(<WorkView runs={mockRuns} storedApprovals={mockApprovals} />);

    // Default is List
    expect(screen.getByRole("region", { name: "List view" })).toBeTruthy();
    expect(screen.getByText("Retry webhook handler")).toBeTruthy();

    // Switch to Board
    fireEvent.click(screen.getByRole("button", { name: /Board/ }));
    expect(screen.getByRole("region", { name: "Board view" })).toBeTruthy();
    expect(screen.getByText("Bump Node to 22")).toBeTruthy();

    // Switch to Timeline
    fireEvent.click(screen.getByRole("button", { name: /Timeline/ }));
    expect(screen.getByRole("region", { name: "Timeline view" })).toBeTruthy();

    // Switch back to List
    fireEvent.click(screen.getByRole("button", { name: /List/ }));
    expect(screen.getByRole("region", { name: "List view" })).toBeTruthy();
  });

  it("calls onQuickAddTask when submitting quick-add row", async () => {
    const onQuickAddTask = vi.fn().mockResolvedValue(true);
    render(<WorkView runs={mockRuns} onQuickAddTask={onQuickAddTask} />);

    const input = screen.getByRole("textbox", { name: "Draft a task and press Enter" });
    fireEvent.change(input, { target: { value: "Investigate latency spikes" } });
    fireEvent.submit(input.closest("form")!);

    expect(onQuickAddTask).toHaveBeenCalledWith("Investigate latency spikes");
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(""));
  });

  it("retains failed quick-add text, blocks rapid resubmission, and clears only after a successful retry", async () => {
    let finish!: (success: boolean) => void;
    const onQuickAddTask = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    render(<WorkView onQuickAddTask={onQuickAddTask} />);
    const input = screen.getByRole("textbox", { name: "Draft a task and press Enter" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Keep this draft" } });
    const form = input.closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(onQuickAddTask).toHaveBeenCalledOnce();
    expect(input.disabled).toBe(true);
    expect(input.value).toBe("Keep this draft");
    await act(async () => finish(false));
    expect(input.value).toBe("Keep this draft");
    expect(input.disabled).toBe(false);
    fireEvent.submit(form);
    expect(onQuickAddTask).toHaveBeenCalledTimes(2);
    await act(async () => finish(true));
    expect(input.value).toBe("");
  });

  it("keeps a rejected quick-add draft and reports the failure", async () => {
    render(<WorkView onQuickAddTask={vi.fn().mockRejectedValue(new Error("Offline"))} />);
    const input = screen.getByRole("textbox", { name: "Draft a task and press Enter" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Keep this offline draft" } });
    fireEvent.submit(input.closest("form")!);
    expect((await screen.findByRole("alert")).textContent).toContain("Your draft has been kept");
    expect(input.value).toBe("Keep this offline draft");
    expect(input.disabled).toBe(false);
  });

  it("filters tasks when search input is used", () => {
    render(<WorkView runs={mockRuns} storedApprovals={mockApprovals} />);

    const searchButton = screen.getByRole("button", { name: "Search tasks" });
    searchButton.focus();
    fireEvent.click(searchButton);
    const searchInput = screen.getByRole("searchbox", { name: "Filter tasks" });
    expect(document.activeElement).toBe(searchInput);
    fireEvent.change(searchInput, { target: { value: "webhook" } });

    expect(screen.getByText("Retry webhook handler")).toBeTruthy();
    expect(screen.queryByText("Bump Node to 22")).toBeNull();
    const boardButton = screen.getByRole("button", { name: "Board" });
    boardButton.focus();
    fireEvent.click(boardButton);
    expect(document.activeElement).toBe(boardButton);

    fireEvent.click(screen.getByRole("button", { name: "Close search" }));
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.getByText("Bump Node to 22")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Search tasks" }));
    expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: "Filter tasks" }));
  });

  it("calls onReviewApproval when clicking Review in Needs approval", () => {
    const onReviewApproval = vi.fn();
    render(<WorkView storedApprovals={mockApprovals} onReviewApproval={onReviewApproval} />);

    const reviewBtn = screen.getByRole("button", { name: "Review" });
    fireEvent.click(reviewBtn);
    expect(onReviewApproval).toHaveBeenCalledWith("app-1");
  });
});
