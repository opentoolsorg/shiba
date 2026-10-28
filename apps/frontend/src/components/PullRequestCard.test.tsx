// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PullRequestCard } from "./PullRequestCard";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PullRequestCard", () => {
  const pull = { url: "https://github.com/o/r/pull/1", state: "open", title: "Scoped pull request", checks: [] };

  it.each([undefined, "default", "session/a&b"])("routes PR status and merge approval in session %s", async (sessionId) => {
    const request = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST"
      ? Response.json({ ok: true }) : Response.json({ pullRequestStatus: pull }));
    vi.stubGlobal("fetch", request);
    render(<PullRequestCard threadId="run:1" sessionId={sessionId} />);
    await screen.findByRole("link", { name: "Scoped pull request" });
    const query = sessionId === "session/a&b" ? "?session=session%2Fa%26b" : "";
    expect(request).toHaveBeenCalledWith(`/api/v1/threads/run%3A1/pr/status${query}`);
    fireEvent.click(screen.getByRole("button", { name: "Request merge (approval-gated)" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith(`/api/v1/threads/run%3A1/pr/merge${query}`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ mergeMethod: "squash" }) })));
  });

  it("discards an old session's pull request response", async () => {
    let finishOld!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishOld = resolve; }))
      .mockImplementation(async () => Response.json({ pullRequestStatus: { ...pull, title: "Current PR" } })));
    const { rerender } = render(<PullRequestCard threadId="run-1" sessionId="old" />);
    rerender(<PullRequestCard threadId="run-1" sessionId="new" />);
    await screen.findByRole("link", { name: "Current PR" });
    await act(async () => { finishOld(Response.json({ pullRequestStatus: { ...pull, title: "Old private PR" } })); });
    expect(screen.queryByRole("link", { name: "Old private PR" })).toBeNull();
    expect(screen.getByRole("link", { name: "Current PR" })).toBeTruthy();
  });

  it("does not apply a late merge error to another session", async () => {
    let finishMerge!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return new Promise<Response>((resolve) => { finishMerge = resolve; });
      return Response.json({ pullRequestStatus: { ...pull, title: url.includes("session=new") ? "Current PR" : "Old PR" } });
    }));
    const { rerender } = render(<PullRequestCard threadId="run-1" sessionId="old" />);
    await screen.findByRole("link", { name: "Old PR" });
    fireEvent.click(screen.getByRole("button", { name: "Request merge (approval-gated)" }));
    rerender(<PullRequestCard threadId="run-1" sessionId="new" />);
    await screen.findByRole("link", { name: "Current PR" });
    await act(async () => { finishMerge(Response.json({ error: "Old merge failure" }, { status: 503 })); });
    expect(screen.queryByText(/Old merge failure/)).toBeNull();
    expect(screen.getByRole("link", { name: "Current PR" })).toBeTruthy();
  });

  it("shows loading then a linked PR", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          pullRequestStatus: {
            url: "https://github.com/o/r/pull/1",
            state: "open",
            title: "Fix flake",
            checks: [],
          },
        }),
      ),
    );
    render(<PullRequestCard threadId="run-1" />);
    expect(screen.getByTestId("pr-card").getAttribute("data-state")).toBe("loading");
    await waitFor(() => {
      expect(screen.getByTestId("pr-card").getAttribute("data-state")).toBe("ready");
    });
    expect(screen.getByRole("link", { name: "Fix flake" }).getAttribute("href")).toBe(
      "https://github.com/o/r/pull/1",
    );
  });

  it("shows waiting copy when publish was requested but no URL yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "pull_request_not_found" }), { status: 404 })),
    );
    render(<PullRequestCard threadId="run-1" publishRequested />);
    await waitFor(() => {
      expect(screen.getByTestId("pr-card").getAttribute("data-state")).toBe("waiting");
    });
    expect(screen.getByText(/Opening pull request/i)).toBeTruthy();
  });

  it("falls back to the run-record pull URL on 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 404 })),
    );
    render(
      <PullRequestCard
        threadId="run-1"
        fallbackPullUrl="https://github.com/o/r/pull/9"
        publishRequested
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("pr-card").getAttribute("data-state")).toBe("ready");
    });
    expect(screen.getByRole("link", { name: /github.com\/o\/r\/pull\/9/ })).toBeTruthy();
  });

  it("surfaces fetch errors with retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    render(<PullRequestCard threadId="run-1" publishRequested />);
    await waitFor(() => {
      expect(screen.getByTestId("pr-card").getAttribute("data-state")).toBe("error");
    });
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
