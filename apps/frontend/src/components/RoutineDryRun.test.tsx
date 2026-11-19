// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RoutineRecord } from "../routines";
import { RoutinesList } from "./RoutinesView";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([true, false])("previews without dispatching anything (enabled: %s)", async (enabled) => {
  const fetchMock = vi.fn(async () => Response.json({ runs: [] }));
  vi.stubGlobal("fetch", fetchMock);
  const changed = vi.fn();
  const routine: RoutineRecord = {
    id: "weekly",
    name: "Weekly report",
    prompt: "Push changes and post a report to Slack.",
    enabled,
    triggers: [
      { kind: "schedule", cron: "0 9 * * 1", runWhen: "Only when there are new reports." },
      { kind: "webhook", runWhen: "Only when requested by Finance." },
    ],
    lastSkip: { at: 1, reason: "Previous routine run is still waiting for approval." },
  };
  render(<RoutinesList routines={[routine]} onChanged={changed} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(screen.getByText("Last skip: Previous routine run is still waiting for approval.")).toBeTruthy();
  const summary = screen.getByText("Test run (preview only)", { selector: "summary" });
  expect(summary.closest("details")?.open).toBe(false);
  fireEvent.click(summary);
  expect(summary.closest("details")?.open).toBe(true);
  expect(screen.getByText(/Nothing was queued or executed/)).toBeTruthy();
  expect(screen.getByText(/Schedule: Only when there are new reports.*not evaluated/i)).toBeTruthy();
  expect(screen.getByText(/Webhook: Only when requested by Finance.*not evaluated/i)).toBeTruthy();
  expect(screen.getByText(/Scheduled runs skip if a previous run is still waiting/)).toBeTruthy();
  expect(Boolean(screen.queryByText("The routine is paused."))).toBe(!enabled);
  expect(screen.getByText("Last run: Not run yet")).toBeTruthy();
  expect(screen.queryByText("Completed")).toBeNull();
  expect(fetchMock.mock.calls).toEqual([["/api/automations/weekly"]]);
  expect(changed).not.toHaveBeenCalled();
});

it("does not claim the pending-run gate applies when it is disabled", () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ runs: [] })));
  render(<RoutinesList routines={[{
    id: "monthly", name: "Monthly report", prompt: "Review the report.", enabled: true,
    skipWhilePending: false, triggers: [{ kind: "schedule", cron: "0 9 1 * *" }],
  }]} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByText("Test run (preview only)", { selector: "summary" }));
  expect(screen.queryByText(/Scheduled runs skip/)).toBeNull();
  expect(screen.getByText(/Live trigger and safety checks still apply/)).toBeTruthy();
});
