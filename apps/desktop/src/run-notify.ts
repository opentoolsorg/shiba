/**
 * Run-finished notification (T64). Pure mapping + a thin dispatcher — the
 * Notification and window come from main.ts. The title never says
 * "completed": harness.verify and PR publish still run on the Worker after
 * the daemon settles (§11.7), so "finished" is the only honest word.
 */

import type { DaemonStatusMessage } from "@shiba/shared";
import { repoSlug } from "./approvals-poller.js";

export const RUN_FINISHED_TITLE = "Local run finished";
// posted:false = the Worker never accepted the result, so "finished" would overclaim.
export const RUN_UNREPORTED_TITLE = "Local run couldn't report its result";
export const ACTIVITY_PATH = "/app/?tab=activity";

export interface RunNotification {
  title: string;
  body: string;
  /** App-internal path the click loads — never a ?run= link (§11.7). */
  path: typeof ACTIVITY_PATH;
}

export function runFinishedNotification(message: DaemonStatusMessage): RunNotification | null {
  if (message.state !== "settled") return null;
  return {
    title: message.posted ? RUN_FINISHED_TITLE : RUN_UNREPORTED_TITLE,
    body: repoSlug(message.repoUrl),
    path: ACTIVITY_PATH,
  };
}

export interface RunNotifyDeps {
  origin: string;
  showWindow: () => void;
  loadURL: (url: string) => Promise<unknown> | unknown;
  notify: (n: { title: string; body: string }, onClick: () => void) => void;
}

/** Wire to the supervisor's daemon-message stream in main.ts. */
export function handleDaemonMessage(message: DaemonStatusMessage, deps: RunNotifyDeps): void {
  const n = runFinishedNotification(message);
  if (n === null) return;
  deps.notify(n, () => {
    deps.showWindow();
    void deps.loadURL(deps.origin + n.path);
  });
}
