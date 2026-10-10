import { expect, it, vi } from "vitest";
import { startUpdater, UPDATE_INTERVAL_MS } from "../src/updater.js";

function timers() {
  const intervals: Array<{ fn: () => void; ms: number }> = [];
  const cleared: unknown[] = [];
  return {
    intervals,
    cleared,
    setIntervalFn: ((fn: () => void, ms: number) => { intervals.push({ fn, ms }); return intervals.length; }) as unknown as typeof setInterval,
    clearIntervalFn: ((h: unknown) => { cleared.push(h); }) as unknown as typeof clearInterval,
  };
}

it("unpackaged is a no-op", () => {
  const t = timers();
  const check = vi.fn();
  const u = startUpdater({ isPackaged: false, checkForUpdatesAndNotify: check, ...t });
  expect(check).not.toHaveBeenCalled();
  expect(t.intervals).toHaveLength(0);
  expect(u.isRunning()).toBe(false);
  u.stop();
});

it("packaged checks immediately and on every interval", () => {
  const t = timers();
  const check = vi.fn(async () => undefined);
  const u = startUpdater({ isPackaged: true, checkForUpdatesAndNotify: check, ...t });
  expect(check).toHaveBeenCalledTimes(1);
  expect(t.intervals).toEqual([{ fn: expect.any(Function), ms: UPDATE_INTERVAL_MS }]);
  t.intervals[0]!.fn();
  t.intervals[0]!.fn();
  expect(check).toHaveBeenCalledTimes(3);
  expect(u.isRunning()).toBe(true);
});

it("a synchronous throw is logged, not thrown", () => {
  const log = vi.fn();
  const boom = new Error("sync");
  expect(() =>
    startUpdater({ isPackaged: true, checkForUpdatesAndNotify: () => { throw boom; }, log, ...timers() }),
  ).not.toThrow();
  expect(log).toHaveBeenCalledWith("update check failed:", boom);
});

it("a rejected promise is logged, not thrown", async () => {
  const log = vi.fn();
  const boom = new Error("async");
  startUpdater({ isPackaged: true, checkForUpdatesAndNotify: () => Promise.reject(boom), log, ...timers() });
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith("update check failed:", boom));
});

it("stop() clears the interval", () => {
  const t = timers();
  const u = startUpdater({ isPackaged: true, checkForUpdatesAndNotify: vi.fn(), ...t });
  u.stop();
  expect(t.cleared).toEqual([1]);
  expect(u.isRunning()).toBe(false);
});
