/**
 * Completion-driven poll scheduler shared by the dashboard's interval
 * polls. Replaces setInterval: the next tick is armed only after the
 * previous load settles, so a slow request can never overlap itself, and
 * a hidden tab pauses the cadence entirely — resuming fires one
 * immediate refresh instead of a stacked backlog.
 */
export interface PollPauseSource {
  /** True while the poll should hold (e.g. document hidden). */
  isPaused(): boolean;
  /** Subscribe to pause-state changes; returns an unsubscribe. */
  subscribe(onChange: () => void): () => void;
}

export interface CompletionDrivenPollOptions {
  /** Delay between one load settling and the next load starting. */
  intervalMs: number;
  /**
   * One poll unit. May return a promise; while it is unsettled no new
   * load starts. Errors are swallowed here — the caller's load owns its
   * own error surface (the poller only guarantees cadence).
   */
  load: () => Promise<unknown> | void;
  pause?: PollPauseSource;
}

export interface CompletionDrivenPoll {
  stop(): void;
}

/** Hidden-tab pause source; inert outside a DOM environment. */
export function documentVisibilityPause(): PollPauseSource {
  return {
    isPaused: () =>
      typeof document !== "undefined" && document.visibilityState === "hidden",
    subscribe: (onChange) => {
      if (typeof document === "undefined") return () => {};
      document.addEventListener("visibilitychange", onChange);
      return () => document.removeEventListener("visibilitychange", onChange);
    },
  };
}

export function createCompletionDrivenPoll(
  options: CompletionDrivenPollOptions,
): CompletionDrivenPoll {
  const { intervalMs, load, pause } = options;
  let stopped = false;
  let inFlight = false;
  // Set while the only thing between us and the next load is a visible tab.
  let waitingOnResume = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const scheduleNext = () => {
    if (stopped || inFlight) return;
    if (pause?.isPaused()) {
      // Hold the next load until the tab is visible again; resume then
      // refreshes immediately rather than replaying missed intervals.
      waitingOnResume = true;
      return;
    }
    timer = setTimeout(run, intervalMs);
  };

  const run = () => {
    if (stopped || inFlight) return;
    timer = undefined;
    inFlight = true;
    let pending: Promise<unknown> | void;
    try {
      pending = load();
    } catch {
      // A synchronous throw is the caller's bug surface, not a poll
      // failure — the cadence still recovers on the next tick.
      inFlight = false;
      scheduleNext();
      return;
    }
    Promise.resolve(pending)
      .catch(() => {})
      .finally(() => {
        inFlight = false;
        scheduleNext();
      });
  };

  const onPauseChange = () => {
    if (stopped || !pause) return;
    if (pause.isPaused()) {
      if (timer !== undefined) clearTimer();
      if (!inFlight) waitingOnResume = true;
      return;
    }
    if (waitingOnResume) {
      waitingOnResume = false;
      if (!inFlight) run();
    }
  };

  const unsubscribe = pause?.subscribe(onPauseChange) ?? (() => {});
  if (pause?.isPaused()) {
    waitingOnResume = true;
  } else {
    run();
  }

  return {
    stop() {
      stopped = true;
      clearTimer();
      unsubscribe();
    },
  };
}
