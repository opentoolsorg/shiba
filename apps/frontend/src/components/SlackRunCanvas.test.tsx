// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackRunCanvas } from "./SlackRunCanvas";

const livePanel = vi.hoisted(() => vi.fn());
vi.mock("./RunLivePanel", () => ({
  RunLivePanel: (props: unknown) => {
    livePanel(props);
    return <section aria-label="Live run workspace">Protected run stream</section>;
  },
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  livePanel.mockClear();
});

const origin = "slack:T1:C1:123.456";
const approvalId = "appr-1";
const params = new URLSearchParams({ origin, approval: approvalId });
const search = `?${params}`;
const pending = {
  state: "pending",
  approval: { approvalId, task: "Frozen Slack task", workspaceLabel: "Workspace report-1", status: "pending" },
};
const running = {
  state: "run",
  run: { runId: `agent-tool:${approvalId}`, status: "running", task: "Approved Slack task", workspaceLabel: "Workspace report-1" },
  room: { runId: `agent-tool:${approvalId}`, sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
};

describe("SlackRunCanvas", () => {
  it("shows only the exact pending task without execution or approval controls", async () => {
    const request = vi.fn(async () => Response.json(pending));
    vi.stubGlobal("fetch", request);
    render(<SlackRunCanvas search={search} />);
    await screen.findByText("Frozen Slack task");
    expect(screen.getByText("Workspace report-1")).toBeTruthy();
    expect(screen.getByText("Awaiting approval in Slack. Execution has not started.")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(livePanel).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledExactlyOnceWith(`/api/slack-canvas?${params}`, expect.objectContaining({
      credentials: "same-origin", cache: "no-store", signal: expect.any(AbortSignal),
    }));
  });

  it("moves the same locator from a pending approval to its protected exact run stream", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValueOnce(Response.json(pending)).mockImplementation(async () => Response.json(running));
    vi.stubGlobal("fetch", request);
    render(<SlackRunCanvas search={search} />);
    await act(async () => {});
    expect(screen.getByText("Frozen Slack task")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.queryByText("Frozen Slack task")).toBeNull();
    expect(screen.getByText("Approved Slack task")).toBeTruthy();
    expect(livePanel).toHaveBeenLastCalledWith({
      runId: running.run.runId,
      sessionId: running.room.sessionId,
      roomUrl: `/api/slack-canvas/websocket?${params}`,
    });
    expect(request.mock.calls.every(([url, init]) => url === `/api/slack-canvas?${params}` && !init.method)).toBe(true);
  });

  it.each([401, 403, 404])("removes the stream when the next protected read returns %s", async (status) => {
    vi.useFakeTimers();
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json(running))
      .mockResolvedValueOnce(Response.json({ error: "This run is not available to this account." }, { status }));
    vi.stubGlobal("fetch", request);
    render(<SlackRunCanvas search={search} />);
    await act(async () => {});
    expect(screen.getByLabelText("Live run workspace")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.queryByLabelText("Live run workspace")).toBeNull();
    expect(screen.queryByText("Approved Slack task")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("This run is not available to this account.");
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("discards late content from a previous locator after navigation", async () => {
    let finishOld: (response: Response) => void = () => {};
    const request = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishOld = resolve; }))
      .mockImplementation(async () => Response.json({ ...pending, approval: { ...pending.approval, approvalId: "appr-2", task: "Current task only" } }));
    vi.stubGlobal("fetch", request);
    const { rerender } = render(<SlackRunCanvas search={search} />);
    const next = new URLSearchParams({ origin, approval: "appr-2" });
    rerender(<SlackRunCanvas search={`?${next}`} />);
    await screen.findByText("Current task only");
    await act(async () => { finishOld(Response.json(running)); });
    expect(screen.queryByText("Approved Slack task")).toBeNull();
    expect(screen.getByText("Current task only")).toBeTruthy();
    expect(livePanel).not.toHaveBeenCalled();
  });

  it("rejects a mismatched run response and never opens a generic session room", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...running, run: { ...running.run, runId: "other-run" } })));
    render(<SlackRunCanvas search={search} />);
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("invalid response");
    expect(livePanel).not.toHaveBeenCalled();
  });

  it("retries only the protected read when access has failed", async () => {
    const request = vi.fn().mockResolvedValueOnce(Response.json({ error: "Sign in to view this run." }, { status: 401 }))
      .mockResolvedValueOnce(Response.json(pending));
    vi.stubGlobal("fetch", request);
    render(<SlackRunCanvas search={search} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await screen.findByText("Frozen Slack task");
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every(([url, init]) => url === `/api/slack-canvas?${params}` && !init.method)).toBe(true);
  });

  it.each(["", "?origin=slack%3AT1%3AC1%3A123.456", "?origin=a&origin=b&approval=x", "?origin=a&approval=x&approval=y"])("fails closed without a single complete locator: %s", (invalid) => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    render(<SlackRunCanvas search={invalid} />);
    expect(screen.getByRole("alert").textContent).toContain("run link is invalid");
    expect(request).not.toHaveBeenCalled();
    expect(livePanel).not.toHaveBeenCalled();
  });

  it("aborts the protected read and stops polling when unmounted", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(pending));
    vi.stubGlobal("fetch", request);
    const { unmount } = render(<SlackRunCanvas search={search} />);
    await act(async () => {});
    const init = request.mock.calls[0]?.[1] as RequestInit | undefined;
    unmount();
    expect(init?.signal?.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(request).toHaveBeenCalledOnce();
  });

  it("only renders a safe GitHub pull request link", async () => {
    const request = vi.fn(async () => Response.json({ ...running, run: { ...running.run, status: "completed", pullUrl: "javascript:alert(1)" } }));
    vi.stubGlobal("fetch", request);
    render(<SlackRunCanvas search={search} />);
    await waitFor(() => expect(livePanel).toHaveBeenCalled());
    expect(screen.queryByRole("link", { name: "View pull request" })).toBeNull();
  });
});
