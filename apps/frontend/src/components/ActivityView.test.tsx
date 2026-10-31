// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpineWire } from "../live-status";

const state: { current: SpineWire } = { current: {
  events: [{ seq: 1, at: 1, commandId: "c1", kind: "side_effect.failed", payload: { error: "xoxb-superlongtoken123" } }],
  outbox: [{ id: "fx-1", effectKind: "slack.post", target: "team", status: "failed", attempts: 3, requestedAt: 1, lastError: "xoxb-superlongtoken123" }],
  executionBudget: {
    accounting: "harness_reported",
    spentUsd: 3,
    reportedRuns: 1,
    unreportedRuns: 2,
    dailyLimitUsd: 3,
    limitReached: true,
    activeRuns: 5,
    maxConcurrentRuns: 5,
    dispatchAvailable: false,
  },
} };

vi.mock("../live-status", () => ({
  useSpine: () => ({ state: { kind: "data", data: state.current }, reload: vi.fn(), inFlight: false }),
}));
vi.mock("../polling", () => ({
  documentVisibilityPause: () => ({ isPaused: () => true, subscribe: () => () => undefined }),
}));

import { ActivityView } from "./ActivityView";

afterEach(cleanup);

describe("ActivityView execution controls", () => {
  it("shows an enforced dispatch boundary and distinguishes unknown usage", () => {
    render(<ActivityView sessionId="default" sessionApiAvailable={false} />);
    expect(screen.getByText("$3.0000 / $3.00 daily reported cost")).toBeTruthy();
    expect(screen.getByText("daily cap reached")).toBeTruthy();
    expect(screen.getByText("1 run reported cost · 2 runs have no cost report")).toBeTruthy();
    expect(screen.getByText(/does not stop active tasks/)).toBeTruthy();
    expect(screen.getByText(/outcome remains unknown/)).toBeTruthy();
    expect(screen.getByText("5 / 5 active tasks")).toBeTruthy();
    expect(screen.getAllByText("[redacted]")).toHaveLength(2);
    expect(screen.getByText("×3")).toBeTruthy();
    expect(screen.queryByText("xoxb-superlongtoken123")).toBeNull();
  });


import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ActivityView } from "./ActivityView";

const { reload, useSpine } = vi.hoisted(() => ({ reload: vi.fn(), useSpine: vi.fn() }));
vi.mock("../live-status", () => ({ useSpine }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("shows quiet empty groups and retains refresh", () => {
  useSpine.mockReturnValue({ state: { kind: "data", data: { events: [], outbox: [] } }, reload, inFlight: true });
  render(<ActivityView sessionId="test" sessionApiAvailable />);
  expect(screen.getByText("No events yet")).toBeTruthy();
  expect(screen.getByText("No pending deliveries")).toBeTruthy();
  expect(screen.getByText("Event log").closest("details")?.open).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(reload).toHaveBeenCalledOnce();
});

it("does not claim deliveries are empty when the request fails", () => {
  useSpine.mockReturnValue({ state: { kind: "error", message: "Unavailable" }, reload, inFlight: true });
  render(<ActivityView sessionId="test" sessionApiAvailable />);
  expect(screen.getByText("Deliveries unavailable")).toBeTruthy();
  expect(screen.queryByText("No pending deliveries")).toBeNull();

});
