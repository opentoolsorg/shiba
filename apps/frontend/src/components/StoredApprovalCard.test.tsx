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
  it.each([{ computer: true }, { payload: { computer: true } }])("names the frozen cloud computer opt-in: %j", (fields) => {
    const { rerender } = render(<StoredApprovalCard approval={{ ...approval, ...fields }} decided={false} onDecide={vi.fn()} />);
    expect(screen.getByText("Uses a cloud computer")).toBeTruthy();
    rerender(<StoredApprovalCard approval={approval} decided={false} onDecide={vi.fn()} />);
    expect(screen.queryByText("Uses a cloud computer")).toBeNull();
  });

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

  it("renders frozen publication metadata and routes decisions only through onDecide", () => {
    const frozen: StoredApproval = { ...approval, kind: "pr_publish", payload: { repoUrl: "https://github.com/o/r", baseBranch: "main", runId: "run-1", sha256: "abc123", bytes: 42, fileCount: 2 } };
    const onDecide = vi.fn();
    render(<StoredApprovalCard approval={frozen} decided={false} onDecide={onDecide} />);
    for (const field of ["https://github.com/o/r", "main", "run-1", "abc123", "42", "2"]) expect(screen.getByText(field)).toBeTruthy();
    expect(screen.queryByText(/proposed branch|PR title/i)).toBeNull();
    expect(screen.getByText(/nothing is published/)).toBeTruthy();
    expect(screen.queryByText(/start the run/)).toBeNull();
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

  it("shows the frozen route, effort included, so the approver sees what will run", () => {
    render(
      <StoredApprovalCard
        approval={{
          ...approval,
          route: {
            purpose: "coding",
            connectionId: null,
            modelId: "openai/gpt-5",
            harness: "codex",
            policyVersion: 0,
            reasoningEffort: "high",
          },
        }}
        decided={false}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByText("codex · openai/gpt-5 · effort high · via deployment default")).toBeTruthy();
  });

  it("renders Env: DATABASE_URL for envNames: ['DATABASE_URL'] and never renders a value", () => {
    const secret = "postgres://user:secret-password@host/db";
    render(
      <StoredApprovalCard
        approval={{
          ...approval,
          envNames: ["DATABASE_URL"],
        }}
        decided={false}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByText("DATABASE_URL")).toBeTruthy();
    expect(screen.getByText("Env:").parentElement?.textContent).toContain("Env: DATABASE_URL");
    expect(screen.queryByText(secret)).toBeNull();
  });

  it("renders the Setup line when runSetup: true and omits it otherwise", () => {
    const { rerender } = render(
      <StoredApprovalCard
        approval={{
          ...approval,
          runSetup: true,
        }}
        decided={false}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByText("runs .shiba/setup.json initialize")).toBeTruthy();
    expect(screen.getByText("Setup:").parentElement?.textContent).toContain(
      "Setup: runs .shiba/setup.json initialize",
    );

    rerender(
      <StoredApprovalCard
        approval={{
          ...approval,
          runSetup: false,
        }}
        decided={false}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.queryByText("Setup:")).toBeNull();
    expect(screen.queryByText(/runs \.shiba\/setup\.json initialize/)).toBeNull();
  });

  it("shows a pending run approval as the current stage with execution not started", () => {
    render(<StoredApprovalCard approval={approval} decided={false} onDecide={vi.fn()} />);
    const items = within(screen.getByRole("list", { name: "Request progress" })).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(["Task briefRecorded", "→ReviewWaiting for you", "→ExecutionNot started", "→ResultsAfter execution"]);
    expect(items[1]?.getAttribute("aria-current")).toBe("step");
    expect(screen.getByText("Waiting for your approval")).toBeTruthy();
  });

  it("reflects a decision taken here, and hides the rail for other kinds or hosts that show their own", () => {
    const { rerender } = render(<StoredApprovalCard approval={approval} decided decision={false} onDecide={vi.fn()} />);
    expect(screen.getByText("Rejected", { selector: "li *" })).toBeTruthy();
    expect(screen.getByText("Will not run")).toBeTruthy();
    rerender(<StoredApprovalCard approval={{ ...approval, kind: "pr_publish" }} decided={false} onDecide={vi.fn()} />);
    expect(screen.queryByRole("list", { name: "Request progress" })).toBeNull();
    rerender(<StoredApprovalCard approval={approval} decided={false} onDecide={vi.fn()} showStages={false} />);
    expect(screen.queryByRole("list", { name: "Request progress" })).toBeNull();
  });
});
