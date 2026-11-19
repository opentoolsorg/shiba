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

it("a synchronous throw becomes a fixed note, with no error text", () => {
  const onError = vi.fn();
  const boom = new Error("sync secret");
  expect(() =>
    startUpdater({ isPackaged: true, checkForUpdatesAndNotify: () => { throw boom; }, onError, ...timers() }),
  ).not.toThrow();
  // The note is a constant: the thrown value never leaves the module.
  expect(onError).toHaveBeenCalledWith("check-failed");
  expect(JSON.stringify(onError.mock.calls)).not.toContain("sync secret");
});

it("a rejected promise becomes the same fixed note", async () => {
  const onError = vi.fn();
  startUpdater({ isPackaged: true, checkForUpdatesAndNotify: () => Promise.reject(new Error("async secret")), onError, ...timers() });
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("check-failed"));
  expect(JSON.stringify(onError.mock.calls)).not.toContain("async secret");
});

it("stop() clears the interval", () => {
  const t = timers();
  const u = startUpdater({ isPackaged: true, checkForUpdatesAndNotify: vi.fn(), ...t });
  u.stop();
  expect(t.cleared).toEqual([1]);
  expect(u.isRunning()).toBe(false);
});
