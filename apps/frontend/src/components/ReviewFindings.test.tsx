// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ReviewFindings } from "./ReviewFindings";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
});
