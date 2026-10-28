// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReviewFindings } from "./ReviewFindings";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const sampleRound = {
  roundId: "rnd-1",
  codingRunId: "run-1",
  reviewRunId: "rev-1",
  pull: { owner: "o", repo: "r", number: 1, headSha: "abc", url: "https://github.com/o/r/pull/1" },
  status: "posted" as const,
  findings: [
    {
      id: "f1",
      path: "src/a.ts",
      line: 10,
      category: "bug" as const,
      severity: "high" as const,
      confidence: "confirmed" as const,
      title: "Null deref",
      failureScenario: "crashes",
      triage: "open" as const,
    },
  ],
  summary: "One issue",
};

describe("ReviewFindings", () => {
  it("routes both review reads and persisted triage to the named session", async () => {
    const request = vi.fn(async () => Response.json({ round: sampleRound }));
    vi.stubGlobal("fetch", request);
    render(<ReviewFindings threadId="run:1" sessionId="session/a&b" reviewAfterPublish />);
    await screen.findByText("Null deref");
    expect(request).toHaveBeenCalledWith("/api/v1/threads/run%3A1/pr/review?session=session%2Fa%26b");
    fireEvent.change(screen.getByRole("combobox", { name: "Triage for Null deref" }), { target: { value: "resolved" } });
    await waitFor(() => expect(request).toHaveBeenCalledWith(
      "/api/v1/threads/run%3A1/pr/review/findings/f1/triage?session=session%2Fa%26b",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ triage: "resolved" }) }),
    ));
  });

  it.each([undefined, "default", "named-session"])("keeps review retry and refresh in session %s", async (sessionId) => {
    const request = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST"
      ? Response.json({ ok: true })
      : Response.json({ round: { ...sampleRound, status: "failed", error: "retry me" } }));
    vi.stubGlobal("fetch", request);
    render(<ReviewFindings threadId="run-1" sessionId={sessionId} reviewAfterPublish />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry review" }));
    const query = sessionId === "named-session" ? "?session=named-session" : "";
    await waitFor(() => expect(request).toHaveBeenCalledWith(
      `/api/v1/threads/run-1/pr/review/retry${query}`,
      expect.objectContaining({ method: "POST" }),
    ));
    await waitFor(() => expect(request.mock.calls.filter(([url, init]) => !init?.method && url === `/api/v1/threads/run-1/pr/review${query}`)).toHaveLength(2));
  });

  it("discards an old session's review response after navigation", async () => {
    let finishOld!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishOld = resolve; }))
      .mockImplementation(async () => Response.json({ round: { ...sampleRound, summary: "Current session review" } })));
    const { rerender } = render(<ReviewFindings threadId="run-1" sessionId="old" reviewAfterPublish />);
    rerender(<ReviewFindings threadId="run-1" sessionId="new" reviewAfterPublish />);
    await screen.findByText("Current session review");
    await act(async () => { finishOld(Response.json({ round: { ...sampleRound, summary: "Private old session review" } })); });
    expect(screen.queryByText("Private old session review")).toBeNull();
    expect(screen.getByText("Current session review")).toBeTruthy();
  });

  it.each([200, 503])("ignores stale triage %s after switching sessions", async (status) => {
    let finishPatch!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return new Promise<Response>((resolve) => { finishPatch = resolve; });
      return Response.json({ round: { ...sampleRound, summary: url.includes("session=new") ? "Current review" : "Old review" } });
    }));
    const { rerender } = render(<ReviewFindings threadId="run-1" sessionId="old" reviewAfterPublish />);
    await screen.findByText("Old review");
    fireEvent.change(screen.getByRole("combobox", { name: "Triage for Null deref" }), { target: { value: "resolved" } });
    rerender(<ReviewFindings threadId="run-1" sessionId="new" reviewAfterPublish />);
    await screen.findByText("Current review");
    await act(async () => { finishPatch(Response.json({ round: { ...sampleRound, summary: "Old review" } }, { status })); });
    expect(screen.queryByText("Old review")).toBeNull();
    expect(screen.getByText("Current review")).toBeTruthy();
  });

  it("surfaces review retry transport failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") throw new Error("Retry network unavailable");
      return Response.json({ round: { ...sampleRound, status: "failed" } });
    }));
    render(<ReviewFindings threadId="run-1" sessionId="named" reviewAfterPublish />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry review" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Retry network unavailable"));
  });

  it("renders nothing when review was not requested and round is absent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ round: null })));
    const { container } = render(<ReviewFindings threadId="run-1" />);
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it("shows waiting copy when reviewAfterPublish is set but round is null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ round: null })));
    render(<ReviewFindings threadId="run-1" reviewAfterPublish />);
    await waitFor(() => {
      expect(screen.getByTestId("review-findings").getAttribute("data-state")).toBe("waiting");
    });
    expect(screen.getByText(/No round yet/i)).toBeTruthy();
  });

  it("lists findings when a round is returned", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ round: sampleRound })));
    render(<ReviewFindings threadId="run-1" reviewAfterPublish />);
    await waitFor(() => {
      expect(screen.getByTestId("review-findings").getAttribute("data-state")).toBe("ready");
    });
    expect(screen.getByText("Null deref")).toBeTruthy();
  });

  it("shows failed round with retry control", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          round: { ...sampleRound, status: "failed", error: "github_401", findings: [] },
        }),
      ),
    );
    render(<ReviewFindings threadId="run-1" reviewAfterPublish />);
    await waitFor(() => {
      expect(screen.getByTestId("review-findings").getAttribute("data-round-status")).toBe("failed");
    });
    expect(screen.getByTestId("review-retry")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("github_401");
  });

  it("marks a finding resolved before the triage request returns", async () => {
    let resolvePatch: (response: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          return new Promise<Response>((resolve) => {
            resolvePatch = resolve;
          });
        }
        return Response.json({ round: sampleRound });
      }),
    );
    render(<ReviewFindings threadId="run-1" reviewAfterPublish />);
    await waitFor(() => {
      expect(screen.getByText("Null deref")).toBeTruthy();
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Triage for Null deref" }), {
      target: { value: "resolved" },
    });
    expect(screen.getByTestId("review-findings").querySelector("[data-triage]")?.getAttribute("data-triage")).toBe(
      "resolved",
    );
    resolvePatch(Response.json({ round: sampleRound }));
    await waitFor(() => {
      expect(screen.getByTestId("review-findings").querySelector("[data-triage]")?.getAttribute("data-triage")).toBe(
        "open",
      );
    });
  });
});
