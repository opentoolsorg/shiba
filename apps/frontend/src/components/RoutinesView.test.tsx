// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routineCron, routineSourceFromRun } from "../routines";
import { RepeatRoutineDialog, RoutinesList } from "./RoutinesView";
import { WorkView } from "./WorkView";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

describe("routine cadence", () => {
  it.each([
    ["daily", "15 9 * * *"], ["weekdays", "15 9 * * 1-5"],
    ["weekly", "15 9 * * 3"], ["monthly", "15 9 20 * *"], ["custom", "0 12 * * 6"],
  ] as const)("builds %s cron", (preset, expected) => {
    expect(routineCron(preset, "09:15", 3, 20, "0 12 * * 6")).toBe(expected);
  });
});

it("renders Routines in Tasks, next run, last status and pause control", async () => {
  const fetchMock = vi.fn(async (url: string) => Response.json(url === "/api/automations" ? { automations: [{ id: "weekly", name: "Weekly summary", prompt: "Summary", enabled: true, nextRunAt: Date.UTC(2026, 10, 23, 9), triggers: [{ kind: "schedule", cron: "0 9 * * 1", timezone: "UTC" }], occurrences: [{ outcome: "approval-pending" }] }] } : { runs: [] }));
  vi.stubGlobal("fetch", fetchMock);
  render(<WorkView routinesEnabled />);
  fireEvent.click(screen.getByRole("tab", { name: "Routines" }));
  expect(await screen.findByText("Weekly summary")).toBeTruthy();
  expect(screen.getByText(/Every Monday 09:00/i)).toBeTruthy();
  expect(screen.getByText(/Next run:/)).toBeTruthy();
  expect(screen.getByText("Last run: Waiting for approval")).toBeTruthy();
  fireEvent.click(screen.getByRole("switch", { name: "Enable Weekly summary" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/automations/weekly", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ enabled: false }) })));
});

const routine = { id: "weekly report", name: "Weekly summary", prompt: "Summary", enabled: true,
  triggers: [{ kind: "schedule", cron: "0 9 * * 1", timezone: "UTC" }] };

it("shows failed reasons, keeps quiet answers collapsed, and retains normal results without unread counts", async () => {
  const fetchMock = vi.fn(async () => Response.json({ runs: [
    { id: "failed", status: "failed", outcome: "failed", failure_reason: "Service unavailable [redacted]", answer_summary: "Failure details", created_at: 3 },
    { id: "quiet", status: "terminal", outcome: "quiet", failure_reason: null, answer_summary: "Everything is up to date.", created_at: 2 },
    { id: "normal", status: "terminal", outcome: "normal", failure_reason: null, answer_summary: "Published weekly report.", created_at: 1 },
  ] }));
  vi.stubGlobal("fetch", fetchMock);
  const changed = vi.fn();
  render(<RoutinesList routines={[routine]} onChanged={changed} />);
  expect(await screen.findByText("Failed")).toBeTruthy();
  expect(screen.getByText("Service unavailable [redacted]")).toBeTruthy();
  expect(screen.getByText("Completed")).toBeTruthy();
  expect(screen.getByText("Published weekly report.")).toBeTruthy();
  const summary = screen.getByText("No update", { exact: false, selector: "summary" });
  const disclosure = summary.closest("details")!;
  expect(disclosure.open).toBe(false);
  fireEvent.click(summary);
  expect(disclosure.open).toBe(true);
  expect(screen.getByText("Everything is up to date.")).toBeTruthy();
  fireEvent.click(summary);
  expect(disclosure.open).toBe(false);
  expect(screen.queryByText(/unread/i)).toBeNull();
  expect(fetchMock.mock.calls).toEqual([["/api/automations/weekly%20report"]]);
  expect(changed).not.toHaveBeenCalled();
});

it("handles an empty history without changing the routine's normal controls", async () => {
  const fetchMock = vi.fn(async () => Response.json({ runs: [] }));
  vi.stubGlobal("fetch", fetchMock);
  render(<RoutinesList routines={[routine]} onChanged={() => {}} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(screen.getByText("Last run: Not run yet")).toBeTruthy();
  expect(screen.getByRole("switch", { name: "Enable Weekly summary" })).toBeTruthy();
  expect(screen.queryByRole("list")).toBeNull();
});

it.each([false, true])("shows history errors without removing the routine (network: %s)", async (network) => {
  vi.stubGlobal("fetch", vi.fn(async () => {
    if (network) throw new Error("Network unavailable");
    return Response.json({}, { status: 503 });
  }));
  render(<RoutinesList routines={[routine]} onChanged={() => {}} />);
  expect((await screen.findByRole("alert")).textContent).toContain(network ? "Network unavailable" : "Could not load recent runs (503).");
  expect(screen.getByRole("switch", { name: "Enable Weekly summary" })).toBeTruthy();
});

it("ignores stale history responses when the routine changes", async () => {
  let resolve!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn((url: string) => url.endsWith("second")
    ? Promise.resolve(Response.json({ runs: [{ id: "new", status: "failed", outcome: "failed", failure_reason: "Current failure", created_at: 1 }] }))
    : new Promise<Response>((done) => { resolve = done; })));
  const { rerender } = render(<RoutinesList routines={[routine]} onChanged={() => {}} />);
  rerender(<RoutinesList routines={[{ ...routine, id: "second" }]} onChanged={() => {}} />);
  expect(await screen.findByText("Current failure")).toBeTruthy();
  resolve(Response.json({ runs: [{ id: "old", status: "failed", outcome: "failed", failure_reason: "Stale failure", created_at: 1 }] }));
  await waitFor(() => expect(screen.queryByText("Stale failure")).toBeNull());
});

it.each([
  ["daily", "15 9 * * *"], ["weekdays", "15 9 * * 1-5"], ["weekly", "15 9 * * 3"],
  ["monthly", "15 9 20 * *"], ["custom", "0 12 * * 6"],
] as const)("submits %s with the task, employee, target, timezone and paused state", async (preset, cron) => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ automation: { id: "routine" } }, { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
  const onCreated = vi.fn();
  const source = { prompt: "qa-routine: weekly summary", customAgentId: "employee", executionTarget: { kind: "artifact-workspace" as const, workspaceName: "Reports", expectedDeliverables: ["report.md"] } };
  render(<RepeatRoutineDialog source={source} employees={[{ id: "employee", name: "Researcher" }]} onClose={() => {}} onCreated={onCreated} />);
  expect((screen.getByLabelText("Employee") as HTMLSelectElement).value).toBe("employee");
  fireEvent.change(screen.getByLabelText("Cadence"), { target: { value: preset } });
  if (preset === "custom") fireEvent.change(screen.getByLabelText(/^Cron expression/), { target: { value: "0 12 * * 6" } });
  else fireEvent.change(screen.getByLabelText("Time", { exact: true }), { target: { value: "09:15" } });
  if (preset === "weekly") fireEvent.change(screen.getByLabelText("Day", { exact: true }), { target: { value: "3" } });
  if (preset === "monthly") fireEvent.change(screen.getByLabelText("Date of month"), { target: { value: "20" } });
  fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "America/New_York" } });
  fireEvent.click(screen.getByLabelText("Enabled"));
  fireEvent.click(screen.getByRole("button", { name: "Create routine" }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
  expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual(expect.objectContaining({ ...source, name: source.prompt, enabled: false, skipWhilePending: true, triggers: [{ kind: "schedule", cron, timezone: "America/New_York" }] }));
});

it("opens Repeat from a completed task", async () => {
  const onRepeat = vi.fn();
  render(<WorkView runs={[{ runId: "run", task: "Weekly summary", repoUrl: "https://github.com/acme/repo", baseBranch: "main", publishPullRequest: false, sandboxId: "sb", status: "completed", generation: 1, createdAt: 1, updatedAt: 2 }]} onRepeatTask={onRepeat} />);
  fireEvent.click(screen.getByRole("button", { name: /Weekly summary/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Repeat this…" }));
  expect(onRepeat).toHaveBeenCalledWith(expect.objectContaining({ task: "Weekly summary" }));
});

it("retains a legacy run's branch and employee, and keeps explicit artifact targets", () => {
  const run = { task: "Summary", repoUrl: "https://github.com/acme/repo", baseBranch: "release", customAgentId: "employee" };
  expect(routineSourceFromRun(run)).toEqual({ prompt: run.task, repoUrl: run.repoUrl, customAgentId: "employee", executionTarget: { kind: "repository", repoUrl: run.repoUrl, baseBranch: "release" } });
  expect(routineSourceFromRun({ ...run, baseBranch: " " }).executionTarget).toEqual({ kind: "repository", repoUrl: run.repoUrl, baseBranch: "main" });
  const target = { kind: "artifact-workspace" as const, workspaceName: "Reports", expectedDeliverables: ["report.md"] };
  expect(routineSourceFromRun({ ...run, repoUrl: "", executionTarget: target }).executionTarget).toEqual(target);
});
