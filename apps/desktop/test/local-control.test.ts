import { describe, expect, it, vi } from "vitest";
import { createLocalControlBoundary } from "../src/local-control.js";

const browser = { kind: "browser" as const, origin: "http://127.0.0.1:3000" };

function pendingAction() {
  let finish!: () => void;
  const settled = new Promise<void>((resolve) => { finish = resolve; });
  return { settled, finish };
}

describe("local control boundary", () => {
  it("requires trusted consent for the exact browser origin", () => {
    const control = createLocalControlBoundary();
    expect(control.canControl(browser)).toBe(false);
    control.approve(browser);
    expect(control.canControl(browser)).toBe(true);
    expect(control.canControl({ ...browser, origin: "http://127.0.0.1:3001" })).toBe(false);
  });

  it("revokes approval on target changes and stop", () => {
    const control = createLocalControlBoundary();
    control.approve(browser);
    const changed = control.targetChanged({ ...browser, origin: "https://example.org" });
    expect(changed).toEqual({ phase: "stopped", revision: 2, reason: "target-changed" });
    expect(control.canControl(browser)).toBe(false);

    control.approve(browser);
    expect(control.stop()).toMatchObject({ phase: "stopped", reason: "user-stopped" });
    expect(control.canControl(browser)).toBe(false);
  });

  it("refuses new actions and hand-back while takeover drains a dispatched action", async () => {
    const control = createLocalControlBoundary();
    control.approve(browser);
    expect(control.canControl(browser)).toBe(true);
    const action = pendingAction();
    const takeover = control.takeOver(action.settled);
    const pending = control.getState();
    expect(pending).toMatchObject({ phase: "approved", mode: "taking-over" });
    expect(control.handBack()).toBe(pending);
    expect(control.canControl(browser)).toBe(false);
    action.finish();
    await expect(takeover).resolves.toMatchObject({ phase: "approved", mode: "takeover" });
    expect(control.canControl(browser)).toBe(false);
    expect(control.handBack()).toMatchObject({ phase: "approved", mode: "control" });
    expect(control.canControl(browser)).toBe(true);
  });

  it("does not let a completed drain take over a replacement approval", async () => {
    const control = createLocalControlBoundary();
    control.approve(browser);
    const action = pendingAction();
    const takeover = control.takeOver(action.settled);
    expect(control.stop()).toMatchObject({ phase: "stopped" });
    const replacement = control.approve(browser);
    action.finish();
    await expect(takeover).resolves.toEqual(replacement);
    expect(control.getState()).toEqual(replacement);
    expect(control.canControl(browser)).toBe(true);
  });

  it("notifies local listeners when the authority boundary changes", async () => {
    const control = createLocalControlBoundary();
    const listener = vi.fn();
    const unsubscribe = control.subscribe(listener);
    control.approve(browser);
    control.stop();
    unsubscribe();
    await control.takeOver(Promise.resolve());
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
