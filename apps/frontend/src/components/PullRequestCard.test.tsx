// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { PullRequestCard } from "./PullRequestCard";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PullRequestCard", () => {
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
