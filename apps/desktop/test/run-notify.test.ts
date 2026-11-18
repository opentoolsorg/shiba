// REVIEW3 F1 regression: real DaemonStatusMessage settled reports carry
// {type:"status", state:"settled"} — the notification must fire on state.
import { expect, it, vi } from "vitest";
import type { DaemonStatusMessage } from "@shiba/shared";
import {
  ACTIVITY_PATH,
  handleDaemonMessage,
  runFinishedNotification,
  RUN_FINISHED_BODY,
  RUN_FINISHED_TITLE,
  RUN_UNREPORTED_BODY,
  RUN_UNREPORTED_TITLE,
} from "../src/run-notify.js";

const ORIGIN = "https://shiba.example.com";

// The verbatim shape the daemon reports over parentPort (desktop-bridge.ts).
const settled = (posted: boolean): DaemonStatusMessage => ({
  type: "status",
  state: "settled",
  runId: "r1",
  status: "succeeded",
  exitCode: 0,
  repoUrl: "https://github.com/owner/repo",
  posted,
});

it("maps a real settled daemon message to the run-finished notification", () => {
  expect(runFinishedNotification(settled(true))).toEqual({
    title: RUN_FINISHED_TITLE,
    body: RUN_FINISHED_BODY,
    path: ACTIVITY_PATH,
  });
});

it("posted:false does not claim the run finished (D7)", () => {
  const n = runFinishedNotification(settled(false));
  expect(n).toEqual({ title: RUN_UNREPORTED_TITLE, body: RUN_UNREPORTED_BODY, path: ACTIVITY_PATH });
  expect(n!.title).not.toBe(RUN_FINISHED_TITLE);
});

it("carries no repository text, path, or daemon detail in a run notification", () => {
  const n = runFinishedNotification(settled(true))!;
  expect(JSON.stringify(n)).not.toContain("owner/repo");
  expect(n.body).toBe(RUN_FINISHED_BODY);
  expect(n.body).not.toMatch(/https?:\/\/|token|bearer/i);
});

it.each<DaemonStatusMessage>([
  { type: "status", state: "polling", machineId: "m1", harnesses: [] },
  { type: "status", state: "claimed", runId: "r1", harness: "claude", repoUrl: "https://github.com/o/r" },
  { type: "status", state: "heartbeat", ok: true },
])("ignores $state messages", (msg) => {
  expect(runFinishedNotification(msg)).toBeNull();
});

it("click shows the window and loads the activity tab — never a ?run= link (D1)", () => {
  const loadURL = vi.fn();
  const showWindow = vi.fn();
  let onClick: (() => void) | undefined;
  handleDaemonMessage(settled(true), {
    origin: ORIGIN,
    showWindow,
    loadURL,
    notify: (_n, cb) => {
      onClick = cb;
    },
  });
  expect(onClick).toBeDefined();
  onClick!();
  expect(showWindow).toHaveBeenCalled();
  expect(loadURL).toHaveBeenCalledWith(`${ORIGIN}${ACTIVITY_PATH}`);
});
