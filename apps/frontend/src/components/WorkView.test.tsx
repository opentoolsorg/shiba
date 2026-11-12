// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WorkView } from "./WorkView";
import type { RetainedRun, StoredApproval } from "../types";
import type { TeamWorkItem } from "../team-work-items";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

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

const sharedTask: TeamWorkItem = {
  id: "handoff-1", workspaceId: "workspace-1", roomId: "room-1", roomTitle: "Launch team",
  title: "Review the launch brief", assigneeKind: "human", assigneeActorId: "human-1", assigneeUserId: "user-1",
  assigneeName: "Alex", status: "queued", updatedAt: 100,
};

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

    const input = screen.getByRole("textbox", { name: "Add a task and press Enter" });
    fireEvent.change(input, { target: { value: "Investigate latency spikes" } });
    fireEvent.submit(input.closest("form")!);

    expect(onQuickAddTask).toHaveBeenCalledWith("Investigate latency spikes");
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(""));
  });

  it("retains failed quick-add text, blocks rapid resubmission, and clears only after a successful retry", async () => {
    let finish!: (success: boolean) => void;
    const onQuickAddTask = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    render(<WorkView onQuickAddTask={onQuickAddTask} />);
    const input = screen.getByRole("textbox", { name: "Add a task and press Enter" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Keep this draft" } });
    const form = input.closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(onQuickAddTask).toHaveBeenCalledOnce();
    expect(input.readOnly).toBe(true);
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
    const input = screen.getByRole("textbox", { name: "Add a task and press Enter" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Keep this offline draft" } });
    await act(async () => {
      fireEvent.submit(input.closest("form")!);
    });
    expect((await screen.findByRole("alert")).textContent).toContain("Your draft has been kept");
    expect(input.value).toBe("Keep this offline draft");
    expect(input.disabled).toBe(false);
  });

  it("filters tasks when search input is used", () => {
    render(<WorkView runs={mockRuns} storedApprovals={mockApprovals} />);

    const searchButton = screen.getByRole("button", { name: "Filter tasks" });
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
    fireEvent.click(screen.getByRole("button", { name: "Filter tasks" }));
    expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: "Filter tasks" }));
  });

  it("calls onReviewApproval when clicking Review in Needs approval", () => {
    const onReviewApproval = vi.fn();
    render(<WorkView storedApprovals={mockApprovals} onReviewApproval={onReviewApproval} />);

    const reviewBtn = screen.getByRole("button", { name: "Review" });
    fireEvent.click(reviewBtn);
    expect(onReviewApproval).toHaveBeenCalledWith("app-1");
  });

  it("keeps personal history separate from explicitly scoped shared work", () => {
    const { rerender } = render(<WorkView runs={mockRuns} storedApprovals={mockApprovals} sharedTasks={[sharedTask]} />);
    expect(screen.getByText("Retry webhook handler")).toBeTruthy();
    expect(screen.queryByText(sharedTask.title)).toBeNull();

    rerender(<WorkView runs={mockRuns} storedApprovals={mockApprovals} workspaceId="workspace-1" workspaceName="Launch workspace" sharedTasks={[sharedTask]} />);
    expect(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByText("Workspace")).toBeTruthy();
    expect(screen.getByText(sharedTask.title)).toBeTruthy();
    expect(screen.queryByText("Retry webhook handler")).toBeNull();
    expect(screen.queryByText("Add pagination to audit log API")).toBeNull();
    expect(screen.queryByText("Personal")).toBeNull();
  });

  it("renders centered empty state when there are zero tasks", () => {
    render(<WorkView runs={[]} storedApprovals={[]} sessions={[]} />);
    expect(screen.getByText("No tasks yet")).toBeTruthy();
    expect(screen.getByText("Add a task above to start a thread.")).toBeTruthy();
  });

  it("shows Review for pending approvals in Board and Timeline as well as List", () => {
    const onReviewApproval = vi.fn();
    render(<WorkView storedApprovals={mockApprovals} onReviewApproval={onReviewApproval} />);
    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    fireEvent.click(screen.getByRole("button", { name: /^Review/ }));
    expect(onReviewApproval).toHaveBeenLastCalledWith("app-1");
    fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
    fireEvent.click(screen.getByRole("button", { name: /^Review/ }));
    expect(onReviewApproval).toHaveBeenCalledTimes(2);
  });

  it("keeps failed runs out of Done and PR-open runs in review on the board", () => {
    const failed: RetainedRun = { ...mockRuns[2]!, runId: "run-failed", task: "Broken migration", status: "error" };
    render(<WorkView runs={[...mockRuns, failed]} />);
    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    expect(screen.getByTestId("board-column-done").textContent).not.toContain("Broken migration");
    expect(screen.getByTestId("board-column-in_review").textContent).toContain("Fix flaky checkout test");
  });

  it("keeps cancelled and PR-open labels distinct in the Timeline", () => {
    const cancelled: RetainedRun = { ...mockRuns[2]!, runId: "run-cancelled", task: "Dropped migration", status: "cancelled" };
    render(<WorkView runs={[...mockRuns, cancelled]} />);
    fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
    const timeline = screen.getByRole("region", { name: "Timeline view" });
    expect(within(timeline).getByText("Cancelled")).toBeTruthy();
    expect(within(timeline).getByText("PR open")).toBeTruthy();
    expect(within(timeline).queryByText("Error")).toBeNull();
  });

  it("groups needs-provider chats with waiting work and offers no approval review for them", () => {
    const onReviewApproval = vi.fn();
    const sessions = [{ id: "s-np", title: "Connect a provider", repoName: "", status: "needs-provider", updatedAt: 5 }];
    render(<WorkView sessions={sessions} onReviewApproval={onReviewApproval} />);
    const waiting = screen.getByRole("region", { name: /^Needs approval - 1$/ });
    expect(waiting.textContent).toContain("Connect a provider");
    expect(screen.getByRole("region", { name: /^Done - 0$/ }).textContent).not.toContain("Connect a provider");
    expect(screen.queryByRole("button", { name: /^Review/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    expect(screen.queryByRole("button", { name: /^Review/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
    expect(screen.queryByRole("button", { name: /^Review/ })).toBeNull();
  });

  it("supports controlled view and invokes onViewChange", () => {
    const onViewChange = vi.fn();
    const { rerender } = render(<WorkView view="list" onViewChange={onViewChange} runs={mockRuns} />);
    expect(screen.getByRole("region", { name: "List view" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    expect(onViewChange).toHaveBeenCalledWith("board");

    rerender(<WorkView view="organization" onViewChange={onViewChange} runs={mockRuns} />);
    expect(screen.getByRole("region", { name: "Organization view" })).toBeTruthy();
  });

  it("renders employees in organization view and handles onOpenEmployee", () => {
    const onOpenEmployee = vi.fn();
    const mockEmployees = [
      { id: "emp-1", name: "Coder Agent", role: "Software Engineer", department: "Engineering" },
    ];
    render(
      <WorkView
        view="organization"
        employees={mockEmployees}
        onOpenEmployee={onOpenEmployee}
      />
    );
    expect(screen.getByText("Coder Agent")).toBeTruthy();
    expect(screen.getByText("Software Engineer")).toBeTruthy();
    fireEvent.click(screen.getByTestId("employee-card-emp-1"));
    expect(onOpenEmployee).toHaveBeenCalledWith("emp-1");
  });

  it("handles sidebarCollapsed, onToggleSidebar, and onNewTask", () => {
    const onToggleSidebar = vi.fn();
    const onNewTask = vi.fn();
    const { rerender } = render(
      <WorkView
        sidebarCollapsed={false}
        onToggleSidebar={onToggleSidebar}
        onNewTask={onNewTask}
      />
    );

    const collapseBtn = screen.getByRole("button", { name: "Collapse sidebar" });
    fireEvent.click(collapseBtn);
    expect(onToggleSidebar).toHaveBeenCalledOnce();

    const newTaskBtn = screen.getByRole("button", { name: "New task" });
    fireEvent.click(newTaskBtn);
    expect(onNewTask).toHaveBeenCalledOnce();

    rerender(
      <WorkView
        sidebarCollapsed={true}
        onToggleSidebar={onToggleSidebar}
        onNewTask={onNewTask}
      />
    );
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeTruthy();
  });

  it("renders the left panel only with a scope handler and leaves workspace switching global", () => {
    const onScopeChange = vi.fn();
    const { rerender } = render(<WorkView runs={mockRuns} storedApprovals={mockApprovals} />);
    expect(screen.queryByRole("complementary", { name: "Work" })).toBeNull();
    rerender(<WorkView runs={mockRuns} storedApprovals={mockApprovals} onScopeChange={onScopeChange} />);
    const panel = screen.getByRole("complementary", { name: "Work" });
    expect(within(panel).queryByRole("button", { name: "Personal" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Workspace" })).toBeNull();
    expect(onScopeChange).not.toHaveBeenCalled();
    expect(within(screen.getByRole("region", { name: "Needs you" })).getByRole("button", { name: "Add pagination to audit log API" })).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Assigned to me" })).getByText("Nothing assigned to you")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Everything" })).queryByText("Bump Node to 22")).toBeNull();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Work pages" })).getByRole("button", { name: "Timeline" }));
    expect(screen.getByRole("region", { name: "Timeline view" })).toBeTruthy();
    rerender(<WorkView runs={mockRuns} onScopeChange={onScopeChange} sidebarCollapsed />);
    expect(screen.queryByRole("complementary", { name: "Work" })).toBeNull();
  });

  it("syncs the view with ?view= and adopts a deep link over the controlled default", () => {
    window.history.replaceState(null, "", "/work?view=board");
    const onViewChange = vi.fn();
    const { unmount } = render(<WorkView view="list" onViewChange={onViewChange} />);
    expect(onViewChange).toHaveBeenCalledWith("board");
    unmount();
    window.history.replaceState(null, "", "/work?view=timeline");
    render(<WorkView />);
    expect(screen.getByRole("region", { name: "Timeline view" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(window.location.search).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Organization" }));
    expect(window.location.search).toBe("?view=organization");
  });

  it("lists workspace tasks in the panel sections by exact viewer identity", () => {
    render(<WorkView workspaceId="workspace-1" currentActorId="human-1" onScopeChange={vi.fn()} sharedTasks={[
      sharedTask,
      { ...sharedTask, id: "employee", title: "Employee task", assigneeKind: "agent", assigneeActorId: "human-1" },
      { ...sharedTask, id: "owned", title: "Owned by me", assigneeActorId: "human-2", ownerId: "human-1" },
      { ...sharedTask, id: "allowed", title: "Authorized review", status: "needs-approval", approvalRequired: true, viewerCanApprove: true },
      { ...sharedTask, id: "unproved", title: "Another owner review", status: "needs-approval", approvalRequired: true, assigneeActorId: "human-2" },
      { ...sharedTask, id: "settled", title: "Already completed", status: "completed" },
    ]} />);
    const assigned = screen.getByRole("region", { name: "Assigned to me" });
    expect(within(assigned).getByRole("button", { name: sharedTask.title })).toBeTruthy();
    expect(within(assigned).getByRole("button", { name: "Owned by me" })).toBeTruthy();
    expect(within(assigned).queryByText("Employee task")).toBeNull();
    const needsYou = screen.getByRole("region", { name: "Needs you" });
    expect(within(needsYou).getByRole("button", { name: "Authorized review" })).toBeTruthy();
    expect(within(needsYou).queryByText("Another owner review")).toBeNull();
    expect(within(screen.getByRole("region", { name: "Everything" })).queryByText("Already completed")).toBeNull();
    expect(screen.getByText("5 open")).toBeTruthy();
  });

  it("opens a task in the detail panel via ?task=, highlights it and closes it", () => {
    const onUpdateTask = vi.fn();
    render(<WorkView workspaceId="workspace-1" onScopeChange={vi.fn()} sharedTasks={[sharedTask]} onUpdateTask={onUpdateTask} />);
    expect(screen.queryByRole("complementary", { name: "Task details" })).toBeNull();
    fireEvent.click(within(screen.getByRole("region", { name: "List view" })).getByRole("button", { name: new RegExp(`^${sharedTask.title}`) }));
    expect(new URLSearchParams(window.location.search).get("task")).toBe(sharedTask.id);
    expect(screen.getByLabelText("Task details")).toBeTruthy();
    expect(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByText(sharedTask.title)).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Everything" })).getByRole("button", { name: sharedTask.title }).getAttribute("aria-current")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Close task" }));
    expect(screen.queryByLabelText("Task details")).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("restores a deep-linked task and archives it", () => {
    window.history.replaceState(null, "", `/work?task=${sharedTask.id}`);
    const onArchiveTask = vi.fn();
    render(<WorkView workspaceId="workspace-1" sharedTasks={[sharedTask]} onArchiveTask={onArchiveTask} />);
    expect(screen.getByLabelText("Task details")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Archive task" }));
    expect(onArchiveTask).toHaveBeenCalledWith(sharedTask.id);
    expect(screen.queryByLabelText("Task details")).toBeNull();
  });

  it("toggles done and creates workspace tasks from the quick-add bar", async () => {
    const onUpdateTask = vi.fn();
    const onCreateTask = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ ...sharedTask, id: "new" });
    render(<WorkView workspaceId="workspace-1" sharedTasks={[sharedTask]} onUpdateTask={onUpdateTask} onCreateTask={onCreateTask} />);
    fireEvent.click(screen.getByRole("button", { name: `Mark ${sharedTask.title} done` }));
    expect(onUpdateTask).toHaveBeenCalledWith(sharedTask.id, { status: "done" });
    const input = screen.getByRole("textbox", { name: "Add a task and press Enter" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Draft the launch post" } });
    await act(async () => { fireEvent.submit(input.closest("form")!); });
    expect(onCreateTask).toHaveBeenCalledWith("Draft the launch post");
    expect(input.value).toBe("Draft the launch post");
    await act(async () => { fireEvent.submit(input.closest("form")!); });
    await waitFor(() => expect(input.value).toBe(""));
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(document.activeElement).toBe(input);
  });

  it("shows the workspace Organization view and clears cached work on an access error", () => {
    const { rerender } = render(<WorkView workspaceId="workspace-1" view="organization" employees={[{ id: "emp-1", name: "Coder Agent", role: "Software Engineer" }]} />);
    expect(screen.getByRole("region", { name: "Organization view" })).toBeTruthy();
    expect(screen.getByText("Coder Agent")).toBeTruthy();
    rerender(<WorkView workspaceId="workspace-1" sharedTasks={[sharedTask]} sharedTasksError="Workspace access is unavailable." />);
    expect(screen.getByRole("alert").textContent).toContain("Workspace access is unavailable.");
    expect(screen.queryByText(sharedTask.title)).toBeNull();
    expect(screen.getByText("0 open")).toBeTruthy();
  });
});
