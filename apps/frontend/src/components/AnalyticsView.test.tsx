// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AnalyticsView } from "./AnalyticsView";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type BudgetPolicy = {
  dailyLimitUsd: number | null;
  monthlyLimitUsd: number | null;
  perRunLimitUsd: number | null;
  onExceed: "stop" | "ask";
  updatedAt: number;
  updatedBy: string;
};

function budgetPeriod(limitUsd: number | null) {
  return {
    llmUsd: 0,
    computeUsd: 0,
    totalUsd: 0,
    limitUsd,
    remainingUsd: null,
    reached: false,
    startsAt: 0,
    resetsAt: 0,
  };
}

function usageReport(policy: BudgetPolicy) {
  return {
    generatedAt: 1000,
    timezone: "UTC",
    budgetUsd: null,
    budget: {
      policy,
      today: budgetPeriod(policy.dailyLimitUsd),
      month: budgetPeriod(policy.monthlyLimitUsd),
      blocked: false,
      blockedPeriods: [],
    },
    days: [],
  };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

it("shows honest empty analytics and keeps new task navigation", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ days: [], budgetUsd: null })));
  const onNavigate = vi.fn();
  render(<AnalyticsView runs={[]} sessionId="test" sessionApiAvailable onNavigate={onNavigate} />);
  expect(await screen.findByText("No token usage reported yet")).toBeTruthy();
  expect(screen.getAllByText("0 runs").length).toBeGreaterThan(0);
  expect(screen.getAllByText("No runs yet")).toHaveLength(5);
  expect(screen.getByText("Runs by harness").closest("details")?.open).toBe(true);
  fireEvent.click(screen.getAllByRole("button", { name: "New task" })[0]!);
  expect(onNavigate).toHaveBeenCalledWith("tasks");
});

it("refreshes spending limits for the selected session after save", async () => {
  const sessionId = "named-session";
  const oldPolicy: BudgetPolicy = {
    dailyLimitUsd: null,
    monthlyLimitUsd: null,
    perRunLimitUsd: null,
    onExceed: "stop",
    updatedAt: 1,
    updatedBy: "test",
  };
  const newPolicy: BudgetPolicy = {
    dailyLimitUsd: 1,
    monthlyLimitUsd: 2,
    perRunLimitUsd: 0.5,
    onExceed: "ask",
    updatedAt: 2,
    updatedBy: "dashboard",
  };
  let saved = false;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (init?.method === "PUT") {
      if (url !== `/api/usage/budget?session=${sessionId}`) throw new Error(`unexpected PUT ${url}`);
      saved = true;
      return Response.json({ policy: newPolicy });
    }
    if (url !== `/api/usage?session=${sessionId}`) throw new Error(`unexpected GET ${url}`);
    return Response.json(usageReport(saved ? newPolicy : oldPolicy));
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<AnalyticsView runs={[]} sessionId={sessionId} sessionApiAvailable />);
  expect((await screen.findAllByText("$0.00 of no limit")).length).toBe(2);

  fireEvent.click(screen.getByRole("button", { name: "Change" }));
  fireEvent.change(screen.getByLabelText("Most to spend per day ($)"), { target: { value: "1" } });
  fireEvent.change(screen.getByLabelText("Most to spend per month ($)"), { target: { value: "2" } });
  fireEvent.change(screen.getByLabelText("Most for one run ($)"), { target: { value: "0.5" } });
  fireEvent.click(screen.getByLabelText("Pause it and ask me first"));
  fireEvent.click(screen.getByRole("button", { name: "Save limits" }));

  expect(await screen.findByText("Limits saved.")).toBeTruthy();
  expect(await screen.findByText("A single run may not cost more than $0.50.")).toBeTruthy();
  expect(screen.getByText("$0.00 of $1.00")).toBeTruthy();
  expect(screen.getByText("$0.00 of $2.00")).toBeTruthy();
  expect(screen.queryByText("$0.00 of no limit")).toBeNull();
  expect(fetchMock).toHaveBeenCalledWith(
    `/api/usage/budget?session=${sessionId}`,
    expect.objectContaining({ method: "PUT" }),
  );
});
