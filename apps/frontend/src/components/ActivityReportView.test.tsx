// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ActivityReportView } from "./ActivityReportView";

const { useActivityReport } = vi.hoisted(() => ({ useActivityReport: vi.fn() }));
vi.mock("../live-status", () => ({ useActivityReport }));
afterEach(cleanup);

it("keeps runtime and custom date filters on the activity report", () => {
  const metric = { now: null, last: null };
  useActivityReport.mockReturnValue({ state: { kind: "data", data: {
    projects: [], members: [], metrics: { contribution: metric, issuesDetected: metric, prsContributed: metric, prsMerged: metric, feedbackLoops: metric, agentHours: metric }, contribution: [], pullRequests: { total: [], byMember: [] },
  } }, reload: vi.fn() });
  render(<ActivityReportView sessionId="test" sessionApiAvailable />);
  expect(screen.getByText("No pull requests in this period")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Local" }));
  expect(useActivityReport.mock.lastCall?.[2]).toMatchObject({ days: 30, runtime: "local" });
  fireEvent.click(screen.getByRole("button", { name: "Custom" }));
  fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-10-01" } });
  fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-10-03" } });
  expect(useActivityReport.mock.lastCall?.[2]).toMatchObject({ runtime: "local", from: Date.parse("2026-10-01"), to: Date.parse("2026-10-04") });
});
