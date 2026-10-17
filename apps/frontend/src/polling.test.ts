import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCompletionDrivenPoll,
  type PollPauseSource,
} from "./polling";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakePause(initial = false) {
  let paused = initial;
  const listeners = new Set<() => void>();
  const source: PollPauseSource = {
    isPaused: () => paused,
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
  };
  return {
    source,
    setPaused(next: boolean) {
      paused = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

async function settle() {
  // Let promise chains queued by the poller resolve before asserting.
  await Promise.resolve();
  await Promise.resolve();
}

describe("createCompletionDrivenPoll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the first load immediately", () => {
    const load = vi.fn();
    const poll = createCompletionDrivenPoll({ intervalMs: 10_000, load });
    expect(load).toHaveBeenCalledTimes(1);
    poll.stop();
  });

  it("arms the next tick only after the previous load settles", async () => {
    const gate = deferred();
    const load = vi
      .fn()
      .mockReturnValueOnce(gate.promise)
      .mockReturnValue(undefined);
    const poll = createCompletionDrivenPoll({ intervalMs: 10_000, load });
    expect(load).toHaveBeenCalledTimes(1);

    // Interval elapsed mid-flight: still a single inflight load.
    vi.advanceTimersByTime(30_000);
    expect(load).toHaveBeenCalledTimes(1);

    gate.resolve();
    await settle();
    vi.advanceTimersByTime(10_000);
    expect(load).toHaveBeenCalledTimes(2);
    poll.stop();
  });

  it("keeps polling on a completion cadence, not a fixed interval", async () => {
    const load = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 4_000));
    });
    const poll = createCompletionDrivenPoll({ intervalMs: 10_000, load });
    await vi.advanceTimersByTimeAsync(4_000); // first load settles
    await vi.advanceTimersByTimeAsync(10_000); // wait interval
    expect(load).toHaveBeenCalledTimes(2);
    poll.stop();
  });

  it("schedules the next load even when a load rejects", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);
    const poll = createCompletionDrivenPoll({ intervalMs: 10_000, load });
    await settle();
    vi.advanceTimersByTime(10_000);
    expect(load).toHaveBeenCalledTimes(2);
    poll.stop();
  });

  it("does not poll while paused and refreshes immediately on resume", async () => {
    const pause = fakePause(false);
    const load = vi.fn();
    const poll = createCompletionDrivenPoll({
      intervalMs: 10_000,
      load,
      pause: pause.source,
    });
    expect(load).toHaveBeenCalledTimes(1);
    await settle();

    pause.setPaused(true);
    vi.advanceTimersByTime(60_000);
    expect(load).toHaveBeenCalledTimes(1); // hidden tab: no ticks

    pause.setPaused(false);
    expect(load).toHaveBeenCalledTimes(2); // resume = immediate refresh
    await settle();
    vi.advanceTimersByTime(10_000);
    expect(load).toHaveBeenCalledTimes(3);
    poll.stop();
  });

  it("pausing mid-wait cancels the pending tick instead of firing it hidden", async () => {
    const pause = fakePause(false);
    const load = vi.fn();
    const poll = createCompletionDrivenPoll({
      intervalMs: 10_000,
      load,
      pause: pause.source,
    });
    await settle();
    vi.advanceTimersByTime(5_000);
    pause.setPaused(true);
    vi.advanceTimersByTime(60_000);
    expect(load).toHaveBeenCalledTimes(1);
    poll.stop();
  });

  it("starting while paused waits for the first resume", async () => {
    const pause = fakePause(true);
    const load = vi.fn();
    const poll = createCompletionDrivenPoll({
      intervalMs: 10_000,
      load,
      pause: pause.source,
    });
    vi.advanceTimersByTime(60_000);
    expect(load).not.toHaveBeenCalled();
    pause.setPaused(false);
    expect(load).toHaveBeenCalledTimes(1);
    poll.stop();
  });

  it("stop() prevents any further loads, including after resume", async () => {
    const pause = fakePause(false);
    const load = vi.fn();
    const poll = createCompletionDrivenPoll({
      intervalMs: 10_000,
      load,
      pause: pause.source,
    });
    await settle();
    poll.stop();
    vi.advanceTimersByTime(60_000);
    pause.setPaused(true);
    pause.setPaused(false);
    vi.advanceTimersByTime(60_000);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
