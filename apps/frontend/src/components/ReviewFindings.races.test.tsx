// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { FindingTriage, ReviewRound } from "@shiba/shared";
import { ReviewFindings } from "./ReviewFindings";

const round: ReviewRound = {
  roundId: "review-round",
  codingRunId: "run-1",
  reviewRunId: "review-1",
  pull: { owner: "o", repo: "r", number: 1, headSha: "abc", url: "https://github.com/o/r/pull/1" },
  status: "posted",
  findings: ["First issue", "Second issue"].map((title, index) => ({
    id: `f${index + 1}`,
    path: "src/a.ts",
    line: index + 1,
    category: "bug",
    severity: "high",
    confidence: "confirmed",
    title,
    failureScenario: "An actual failure",
    triage: "open",
  })),
  summary: "Current review",
};

type PendingPatch = { resolve: (response: Response) => void; reject: (error: Error) => void };

function stubReview() {
  const patches: PendingPatch[] = [];
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      return new Promise<Response>((resolve, reject) => patches.push({ resolve, reject }));
    }
    return Response.json({ round: { ...round, summary: url.includes("session=new") ? "New session review" : "Current review" } });
  });
  vi.stubGlobal("fetch", request);
  return { patches, request };
}

function pendingPatch(patches: PendingPatch[], index: number): PendingPatch {
  const patch = patches[index];
  if (!patch) throw new Error(`Expected pending triage request ${index}`);
  return patch;
}

function triage(index: number): string {
  return (screen.getByRole("combobox", { name: `Triage for ${index === 0 ? "First" : "Second"} issue` }) as HTMLSelectElement).value;
}

function change(index: number, value: FindingTriage) {
  fireEvent.change(screen.getByRole("combobox", { name: `Triage for ${index === 0 ? "First" : "Second"} issue` }), { target: { value } });
}

function saved(finding: number, value: FindingTriage): Response {
  // A full-round response may contain stale values for the other finding.
  return Response.json({ round: { ...round, findings: round.findings?.map((item, index) => index === finding ? { ...item, triage: value } : item) } });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ReviewFindings concurrent triage", () => {
  it.each([false, true])("rolls back both independent failures (reverse completion: %s)", async (reverse) => {
    const { patches } = stubReview();
    render(<ReviewFindings threadId="run-1" sessionId="old" />);
    await screen.findByText("Current review");
    change(0, "resolved");
    change(1, "irrelevant");
    expect([triage(0), triage(1)]).toEqual(["resolved", "irrelevant"]);
    const first = reverse ? 1 : 0;
    await act(async () => pendingPatch(patches, first).resolve(new Response(null, { status: 503 })));
    expect(triage(first)).toBe("open");
    expect(triage(1 - first)).toBe(first === 0 ? "irrelevant" : "resolved");
    await act(async () => pendingPatch(patches, 1 - first).reject(new Error("Network unavailable")));
    expect([triage(0), triage(1)]).toEqual(["open", "open"]);
  });

  it.each([0, 1])("keeps finding %s's saved state when the other finding fails", async (successful) => {
    const { patches } = stubReview();
    render(<ReviewFindings threadId="run-1" />);
    await screen.findByText("Current review");
    change(0, "resolved");
    change(1, "irrelevant");
    await act(async () => pendingPatch(patches, successful).resolve(saved(successful, "resolved")));
    expect(triage(successful)).toBe("resolved");
    expect(triage(1 - successful)).toBe(successful === 0 ? "irrelevant" : "resolved");
    await act(async () => pendingPatch(patches, 1 - successful).resolve(new Response(null, { status: 503 })));
    expect(triage(successful)).toBe("resolved");
    expect(triage(1 - successful)).toBe("open");
  });

  it("keeps the latest same-finding success when an older success arrives afterward", async () => {
    const { patches } = stubReview();
    render(<ReviewFindings threadId="run-1" />);
    await screen.findByText("Current review");
    change(0, "resolved");
    change(0, "irrelevant");
    await act(async () => pendingPatch(patches, 1).resolve(saved(0, "irrelevant")));
    await act(async () => pendingPatch(patches, 0).resolve(saved(0, "resolved")));
    expect(triage(0)).toBe("irrelevant");
  });

  it.each([false, true])("falls back to an earlier same-finding success (reverse completion: %s)", async (reverse) => {
    const { patches } = stubReview();
    render(<ReviewFindings threadId="run-1" />);
    await screen.findByText("Current review");
    change(0, "resolved");
    change(0, "irrelevant");
    if (reverse) {
      await act(async () => pendingPatch(patches, 1).resolve(new Response(null, { status: 503 })));
      expect(triage(0)).toBe("resolved");
      await act(async () => pendingPatch(patches, 0).resolve(saved(0, "resolved")));
    } else {
      await act(async () => pendingPatch(patches, 0).resolve(saved(0, "resolved")));
      expect(triage(0)).toBe("irrelevant");
      await act(async () => pendingPatch(patches, 1).resolve(new Response(null, { status: 503 })));
    }
    expect(triage(0)).toBe("resolved");
  });

  it.each([false, true])("restores the original value when same-finding edits fail (reverse completion: %s)", async (reverse) => {
    const { patches } = stubReview();
    render(<ReviewFindings threadId="run-1" />);
    await screen.findByText("Current review");
    change(0, "resolved");
    change(0, "irrelevant");
    const first = reverse ? 1 : 0;
    await act(async () => pendingPatch(patches, first).resolve(new Response(null, { status: 503 })));
    expect(triage(0)).toBe(reverse ? "resolved" : "irrelevant");
    await act(async () => pendingPatch(patches, 1 - first).reject(new Error("Disconnected")));
    expect(triage(0)).toBe("open");
  });

  it.each([false, true])("ignores stale mutations after navigation (return to original session: %s)", async (returnToOriginal) => {
    const { patches } = stubReview();
    const { rerender } = render(<ReviewFindings threadId="run-1" sessionId="old" />);
    await screen.findByText("Current review");
    change(0, "resolved");
    change(1, "resolved");
    rerender(<ReviewFindings threadId="run-1" sessionId="new" />);
    await screen.findByText("New session review");
    if (returnToOriginal) {
      rerender(<ReviewFindings threadId="run-1" sessionId="old" />);
      await screen.findByText("Current review");
    }
    const expectedSummary = returnToOriginal ? "Current review" : "New session review";
    change(0, "irrelevant");
    await act(async () => {
      pendingPatch(patches, 0).resolve(saved(0, "resolved"));
      pendingPatch(patches, 1).reject(new Error("Old session failed"));
    });
    expect(screen.getByText(expectedSummary)).toBeTruthy();
    expect([triage(0), triage(1)]).toEqual(["irrelevant", "open"]);
    await act(async () => pendingPatch(patches, 2).resolve(saved(0, "irrelevant")));
    expect(screen.getByText(expectedSummary)).toBeTruthy();
    expect([triage(0), triage(1)]).toEqual(["irrelevant", "open"]);
  });
});
