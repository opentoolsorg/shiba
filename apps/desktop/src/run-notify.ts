/**
 * Run-finished notification (T64). Pure mapping + a thin dispatcher — the
 * Notification and window come from main.ts. The title never says
 * "completed": harness.verify and PR publish still run on the Worker after
 * the daemon settles (§11.7), so "finished" is the only honest word.
 */

import type { DaemonStatusMessage } from "@shiba/shared";

export const RUN_FINISHED_TITLE = "Local run finished";
// posted:false = the Worker never accepted the result, so "finished" would overclaim.
export const RUN_UNREPORTED_TITLE = "Local run couldn't report its result";
export const ACTIVITY_PATH = "/app/?tab=activity";

/**
 * Fixed bodies: a notification is OS chrome, so it carries no repository name,
 * path, or daemon text. The page it opens is where the run itself is described.
 */
export const RUN_FINISHED_BODY = "Open Shiba to review the result.";
export const RUN_UNREPORTED_BODY = "Shiba did not accept the result. Open Shiba to see the run.";

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
    body: message.posted ? RUN_FINISHED_BODY : RUN_UNREPORTED_BODY,
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
