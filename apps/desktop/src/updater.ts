/**
 * Auto-update loop (T65). electron's autoUpdater is injected so this file
 * stays electron-free and testable. Only packaged builds check; unsigned
 * mac builds can't self-update, and every failure is reported as a fixed note,
 * never thrown and never carrying the error value.
 */

export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export interface UpdaterDeps {
  isPackaged: boolean;
  checkForUpdatesAndNotify: () => Promise<unknown> | unknown;
  /** Fixed failure note; the thrown value never leaves this module. */
  onError?: (reason: "check-failed") => void;
  intervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export interface Updater {
  stop(): void;
  isRunning(): boolean;
}

export function startUpdater(deps: UpdaterDeps): Updater {
  const onError = deps.onError ?? (() => {});
  if (!deps.isPackaged) {
    return { stop: () => {}, isRunning: () => false };
  }
  const setI = deps.setIntervalFn ?? setInterval;
  const clearI = deps.clearIntervalFn ?? clearInterval;
  let running = true;

  const check = () => {
    try {
      // autoUpdater errors surface via its own "error" event and rejected
      // promises on some versions; both collapse to one fixed note.
      Promise.resolve(deps.checkForUpdatesAndNotify()).catch(() => onError("check-failed"));
    } catch {
      onError("check-failed");
    }
  };

  check();
  const timer = setI(check, deps.intervalMs ?? UPDATE_INTERVAL_MS);

  return {
    stop() {
      running = false;
      clearI(timer);
    },
    isRunning: () => running,
  };
}
