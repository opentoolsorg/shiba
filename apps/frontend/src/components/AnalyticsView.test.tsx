// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AnalyticsView } from "./AnalyticsView";

vi.mock("../live-status", () => ({ useUsageReport: () => ({ state: { kind: "data", data: { days: [], budgetUsd: null } }, reload: vi.fn() }) }));
afterEach(cleanup);

it("shows honest empty analytics and keeps new task navigation", () => {
  const onNavigate = vi.fn();
  render(<AnalyticsView runs={[]} sessionId="test" sessionApiAvailable onNavigate={onNavigate} />);
  expect(screen.getAllByText("0 runs").length).toBeGreaterThan(0);
  expect(screen.getAllByText("No runs yet")).toHaveLength(5);
  expect(screen.getByText("No token usage reported yet")).toBeTruthy();
  expect(screen.getByText("Runs by harness").closest("details")?.open).toBe(true);
  fireEvent.click(screen.getAllByRole("button", { name: "New task" })[0]!);
  expect(onNavigate).toHaveBeenCalledWith("tasks");
});
