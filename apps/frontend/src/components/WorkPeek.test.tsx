// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RetainedRun, StoredApproval } from "../types";
import type { PendingApproval } from "../ui-helpers";
import { WorkPeek } from "./WorkPeek";
import { WorkView } from "./WorkView";

vi.mock("./RunLivePanel", () => ({
  RunLivePanel: ({ runId, sessionId }: { runId: string; sessionId?: string }) => (
    <p>
      Live run {runId}, session {sessionId}
    </p>
  ),
}));

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/work/");
});

const run: RetainedRun = {
  runId: "run-one",
  task: "Inspect persisted evidence",
  status: "completed",
  generation: 1,
  repoUrl: "https://github.com/acme/service",
  sandboxId: "sandbox-one",
  baseBranch: "main",
  publishPullRequest: true,
  createdAt: 1794560000000,
  updatedAt: 1794561000000,
  hasDiff: true,
  pullUrl: "https://github.com/acme/service/pull/42",
};
const approval: StoredApproval = {
  approvalId: "gate-one",
  threadKey: "thread-one",
  task: "Review this exact input",
  status: "pending",
  createdAt: 1794560000000,
  repoUrl: "https://github.com/acme/service",
  payload: {
    repoUrl: "https://github.com/acme/service",
    task: "Frozen objective",
    testCommand: ["pnpm", "test:unit"],
    publishPullRequest: false,
  },
};
const pending: PendingApproval = {
  approvalId: "chat-gate",
  messageId: "message-one",
  toolCallId: "call-one",
  tool: "delegate_coding_task",
  input: {
    repoUrl: "https://github.com/acme/service",
    task: "Frozen chat objective",
    testCommand: ["pnpm", "test:unit"],
  },
};

function openRun() {
  const trigger = screen.getByRole("button", { name: /^Inspect persisted evidence/ });
  trigger.focus();
  fireEvent.click(trigger);
  return trigger;
}

describe("Work inspector", () => {
  it("keeps the first server render independent of browser-only deep-link state", () => {
    window.history.replaceState(null, "", "/work/?view=board&task=run-one&taskKind=run&tab=diff");
    const html = renderToString(<WorkView runs={[run]} />);
    expect(html).toContain('aria-label="List view"');
    expect(html).not.toContain("<dialog");
  });

  it("separates ready threads and queued runs from active and completed work", () => {
    render(
      <WorkView
        runs={[{ ...run, status: "pending" }]}
        sessions={[
          {
            id: "thread-ready",
            title: "Ready thread",
            repoName: "web chat",
            status: "ready",
            updatedAt: run.updatedAt,
          },
        ]}
      />,
    );
    expect(
      within(screen.getByRole("region", { name: "Queued - 1" })).getByText(run.task),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Ready - 1" })).getByText("Ready thread"),
    ).toBeTruthy();
    expect(screen.getByRole("region", { name: "Running - 0" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Completed - 0" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    expect(screen.getByTestId("board-column-queued").textContent).toContain(run.task);
    expect(screen.getByTestId("board-column-todo").textContent).toContain("Ready thread");
    expect(screen.queryByRole("combobox")).toBeNull();
  });
  it("opens over the board, remembers layout and restores focus after Escape", () => {
    window.history.replaceState(
      { key: "router-entry" },
      "",
      "/work/?view=board&workspace=personal#anchor",
    );
    const onSelectTask = vi.fn();
    render(<WorkView runs={[run]} onSelectTask={onSelectTask} />);
    const trigger = openRun();
    const modal = screen.getByRole("dialog", { name: /Work inspector/ });
    expect(modal.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(within(modal).getByRole("button", { name: "Close task" }));
    expect(onSelectTask).not.toHaveBeenCalled();
    expect(new URLSearchParams(window.location.search).get("taskKind")).toBe("run");
    expect(window.history.state).toEqual({ key: "router-entry" });
    fireEvent.click(within(modal).getByRole("tab", { name: "Diff" }));
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("diff");
    expect(screen.getByText(/A diff is retained/)).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(window.location.search).toBe("?view=board&workspace=personal");
    expect(window.location.hash).toBe("#anchor");
    expect(document.body.style.overflow).toBe("");
  });

  it("restores deep links and follows browser history for selection and tabs", () => {
    window.history.replaceState(
      null,
      "",
      "/work/?view=timeline&task=run-one&taskKind=run&tab=output",
    );
    render(<WorkView runs={[run]} />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Output" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("link", { name: "Open pull request" }).getAttribute("href")).toBe(
      run.pullUrl,
    );
    expect(screen.getByText(/do not establish test results or merge status/)).toBeTruthy();
    act(() => {
      window.history.replaceState(null, "", "/work/?view=list&task=run-one&taskKind=run&tab=diff");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByRole("region", { name: "List view" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Diff" }).getAttribute("aria-selected")).toBe("true");
    act(() => {
      window.history.replaceState(null, "", "/work/?view=board");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("region", { name: "Board view" })).toBeTruthy();
  });

  it("keeps keyboard focus within the inspector and supports arrow tab navigation", () => {
    render(<WorkView runs={[run]} onSelectTask={vi.fn()} />);
    openRun();
    const modal = screen.getByRole("dialog");
    const close = within(modal).getByRole("button", { name: "Close task" });
    const last = within(modal).getByRole("button", { name: "Open full thread" });
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    const steps = within(modal).getByRole("tab", { name: "Steps" });
    steps.focus();
    fireEvent.keyDown(steps, { key: "ArrowRight" });
    expect(document.activeElement).toBe(within(modal).getByRole("tab", { name: "Approval" }));
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("approval");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "End" });
    expect(document.activeElement).toBe(within(modal).getByRole("tab", { name: "Output" }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Home" });
    expect(document.activeElement).toBe(steps);
    const globalShortcut = vi.fn();
    window.addEventListener("keydown", globalShortcut);
    fireEvent.keyDown(steps, { key: "j" });
    expect(globalShortcut).not.toHaveBeenCalled();
    window.removeEventListener("keydown", globalShortcut);
  });

  it("passes the original frozen stored approval object to the existing handler", () => {
    const onDecide = vi.fn();
    render(<WorkView storedApprovals={[approval]} onDecideStoredApproval={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: /^Review this exact input/ }));
    const modal = screen.getByRole("dialog");
    expect(onDecide).not.toHaveBeenCalled();
    expect(within(modal).getByText(/Frozen objective/)).toBeTruthy();
    fireEvent.click(within(modal).getByRole("button", { name: /^Approve/ }));
    expect(onDecide).toHaveBeenCalledExactlyOnceWith(approval, true);
    expect(onDecide.mock.calls[0]?.[0]).toBe(approval);
  });

  it("uses the existing chat approval card and decision state without editing its input", () => {
    const onDecide = vi.fn();
    const { rerender } = render(
      <WorkView pendingApprovals={[pending]} onDecideApproval={onDecide} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Approve tool:/ }));
    expect(screen.getByText(/Frozen chat objective/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onDecide).toHaveBeenCalledExactlyOnceWith("chat-gate", false);
    rerender(
      <WorkView
        pendingApprovals={[pending]}
        onDecideApproval={onDecide}
        approvalDecisions={{ "chat-gate": false }}
      />,
    );
    expect((screen.getByRole("button", { name: "Rejected" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(pending.input).toEqual({
      repoUrl: "https://github.com/acme/service",
      task: "Frozen chat objective",
      testCommand: ["pnpm", "test:unit"],
    });
  });

  it("uses task kind to disambiguate equal ids and never substitutes another approval", () => {
    window.history.replaceState(null, "", "/work/?task=run-one&taskKind=run&tab=approval");
    render(
      <WorkView
        runs={[run]}
        storedApprovals={[{ ...approval, approvalId: "run-one" }]}
        onDecideStoredApproval={vi.fn()}
      />,
    );
    const modal = screen.getByRole("dialog");
    expect(within(modal).getByRole("heading", { name: run.task })).toBeTruthy();
    expect(within(modal).queryByText(/Frozen objective/)).toBeNull();
    expect(within(modal).queryByRole("button", { name: /^Approve/ })).toBeNull();
  });

  it("shows only recorded milestones and scopes the reused live panel explicitly", () => {
    const recorded = {
      ...run,
      signals: [
        { kind: "clone.complete" as const, at: run.createdAt, detail: "Repository cloned" },
      ],
    };
    render(<WorkView runs={[recorded]} peekSessionId="session-exact" />);
    openRun();
    expect(screen.getByRole("list", { name: "Recorded run steps" }).textContent).toContain(
      "clone.complete",
    );
    expect(screen.queryByText(/tests passed/i)).toBeNull();
    expect(screen.queryByText(/merged/i)).toBeNull();
    expect(screen.getByText("Live run run-one, session session-exact")).toBeTruthy();
  });

  it("renders a captured diff and marks expected uncaptured deliverables honestly", () => {
    const diff =
      "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n";
    const { rerender } = render(
      <WorkView runs={[{ ...run, diff, expectedDeliverables: ["report.json"] }]} />,
    );
    openRun();
    fireEvent.click(screen.getByRole("tab", { name: "Diff" }));
    expect(screen.getByRole("tabpanel").textContent).toContain("file.txt");
    fireEvent.click(screen.getByRole("tab", { name: "Output" }));
    expect(screen.getByText("Not captured")).toBeTruthy();
    rerender(
      <WorkView runs={[{ ...run, status: "running", expectedDeliverables: ["report.json"] }]} />,
    );
    expect(screen.getByText("Awaiting captured file")).toBeTruthy();
  });

  it("clears a selected task when workspace scope changes", () => {
    const { rerender } = render(<WorkView runs={[run]} />);
    openRun();
    rerender(<WorkView workspaceId="workspace-one" runs={[run]} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(new URLSearchParams(window.location.search).has("task")).toBe(false);
    rerender(<WorkView runs={[run]} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps existing app feedback visible inside the modal and clears a resolved selection", () => {
    const { rerender } = render(
      <WorkView
        storedApprovals={[approval]}
        peekNotice="The approval could not be recorded. Try again."
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Review this exact input/ }));
    expect(within(screen.getByRole("dialog")).getByRole("status").textContent).toContain(
      "could not be recorded",
    );
    rerender(<WorkView storedApprovals={[]} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(new URLSearchParams(window.location.search).has("task")).toBe(false);
  });

  it("offers a dismissible empty state for an unavailable deep-linked item", () => {
    window.history.replaceState(null, "", "/work/?task=unavailable&taskKind=run&tab=diff");
    render(<WorkView />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "not in the currently loaded work list",
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(window.location.search).toBe("");
  });

  it("hands typed search changes to the router adapter", () => {
    const onSearchChange = vi.fn();
    render(<WorkView runs={[run]} onSearchChange={onSearchChange} />);
    openRun();
    expect(onSearchChange).toHaveBeenLastCalledWith({
      view: "list",
      task: run.runId,
      taskKind: "run",
      tab: "steps",
    });
    expect(window.location.search).toBe("");
  });

  it("restores focus to the Work surface if a history change removes the opening card", () => {
    render(<WorkView runs={[run]} />);
    const trigger = openRun();
    act(() => {
      window.history.replaceState(null, "", "/work/?view=board&task=run-one&taskKind=run");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(trigger.isConnected).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Close task" }));
    expect(document.activeElement?.hasAttribute("data-work-surface")).toBe(true);
  });

  it("keeps caller-rendered thread content and handlers intact", () => {
    const task = {
      id: run.runId,
      kind: "run" as const,
      title: run.task,
      repo: "acme/service",
      group: "done" as const,
      stateLabel: "Completed",
      updatedAt: run.updatedAt,
    };
    const renderContent = vi.fn(() => <p>Existing thread steps</p>);
    const onClose = vi.fn();
    render(
      <WorkPeek
        task={task}
        run={run}
        tab="steps"
        onTabChange={vi.fn()}
        onClose={onClose}
        renderContent={renderContent}
      />,
    );
    expect(renderContent).toHaveBeenCalledWith(task, "steps");
    expect(screen.getByText("Existing thread steps")).toBeTruthy();
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { bubbles: true, cancelable: true }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
