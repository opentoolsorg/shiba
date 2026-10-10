/**
 * Auto-update loop (T65). electron's autoUpdater is injected so this file
 * stays electron-free and testable. Only packaged builds check; unsigned
 * mac builds can't self-update, and every failure is logged, never thrown.
 */

export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export interface UpdaterDeps {
  isPackaged: boolean;
  checkForUpdatesAndNotify: () => Promise<unknown> | unknown;
  log?: (...args: unknown[]) => void;
  intervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export interface Updater {
  stop(): void;
  isRunning(): boolean;
}

export function startUpdater(deps: UpdaterDeps): Updater {
  const log = deps.log ?? (() => {});
  if (!deps.isPackaged) {
    return { stop: () => {}, isRunning: () => false };
  }
  const setI = deps.setIntervalFn ?? setInterval;
  const clearI = deps.clearIntervalFn ?? clearInterval;
  let running = true;

  const check = () => {
    try {
      // autoUpdater errors surface via its own "error" event and rejected
      // promises on some versions; both are swallowed into the log.
      Promise.resolve(deps.checkForUpdatesAndNotify()).catch((error) =>
        log("update check failed:", error),
      );
    } catch (error) {
      log("update check failed:", error);
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
