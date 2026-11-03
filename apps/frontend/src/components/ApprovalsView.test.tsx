// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ApprovalsView } from "./ApprovalsView";
import type { StoredApproval } from "../types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ entries: [] }) })),
  );
});

const pending: StoredApproval = {
  approvalId: "ap-1",
  kind: "run",
  status: "pending",
  repoUrl: "https://github.com/acme/shop",
  task: "Ship the receipt fix",
  createdAt: Date.now(),
  threadKey: "t1",
};

function renderApprovals(extra?: Partial<Parameters<typeof ApprovalsView>[0]>) {
  const onRefresh = vi.fn();
  render(
    <ApprovalsView
      pendingApprovals={[]}
      decisions={{}}
      onDecideApproval={vi.fn()}
      storedApprovals={[]}
      storedDecisions={{}}
      decidedStoredApprovals={[]}
      storedApprovalsError={null}
      onDecideStoredApproval={vi.fn()}
      onRefresh={onRefresh}
      {...extra}
    />,
  );
  return { onRefresh };
}

describe("ApprovalsView", () => {
  it("does not claim the queue is empty when loading failed", () => {
    renderApprovals({ storedApprovalsError: "backend down" });
    expect(screen.getByRole("alert").textContent).toContain("backend down");
    expect(screen.queryByText("Nothing needs you")).toBeNull();
  });
  it("shows an empty waiting state without marketing copy", () => {
    renderApprovals();
    expect(screen.getByRole("heading", { name: "Approvals" })).toBeTruthy();
    expect(screen.getByText("Nothing needs you")).toBeTruthy();
    expect(screen.getByText("0 open")).toBeTruthy();
    expect(screen.queryByText(/Zero-Trust/)).toBeNull();
    expect(screen.queryByText(/Decision Center/)).toBeNull();
  });

  it("counts a stored approval and retries a queue error", () => {
    const { onRefresh } = renderApprovals({
      storedApprovals: [pending],
      storedApprovalsError: "backend down",
    });
    expect(screen.getByText("1 open")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("backend down");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRefresh).toHaveBeenCalled();
  });

  it("searches pending approvals without changing the open count", () => {
    renderApprovals({ storedApprovals: [pending] });
    fireEvent.click(screen.getByRole("button", { name: "Search approvals" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search approvals" }), { target: { value: "missing repository" } });
    expect(screen.getByText("No matching approvals")).toBeTruthy();
    expect(screen.getByText("1 open")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close approval search" }));
    expect(screen.getByText("Ship the receipt fix")).toBeTruthy();
  });

  it("does not count locally resolved approvals as open", () => {
    renderApprovals({ storedApprovals: [pending], storedDecisions: { "ap-1": false } });
    expect(screen.getByText("0 open")).toBeTruthy();
    expect(screen.getByText("Rejected — nothing ran").getAttribute("role")).toBe("status");
  });

  it("filters decided rows", () => {
    const decided: StoredApproval = {
      ...pending,
      approvalId: "ap-done",
      status: "rejected",
    };
    renderApprovals({ decidedStoredApprovals: [decided] });
    expect(screen.getByText("Ship the receipt fix")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "approved" }));
    expect(screen.getByText(/No decided actions match/)).toBeTruthy();
  });
});
