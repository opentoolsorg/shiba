// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routineCron, routineSourceFromRun } from "../routines";
import { RepeatRoutineDialog } from "./RoutinesView";
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
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ automations: [{ id: "weekly", name: "Weekly summary", prompt: "Summary", enabled: true, nextRunAt: Date.UTC(2026, 10, 23, 9), triggers: [{ kind: "schedule", cron: "0 9 * * 1", timezone: "UTC" }], occurrences: [{ outcome: "approval-pending" }] }] }));
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
