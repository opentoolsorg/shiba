import { describe, expect, it, vi } from "vitest";
import { createLocalControlBoundary } from "../src/local-control.js";

const browser = { kind: "browser" as const, origin: "http://127.0.0.1:3000" };

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

  it("pauses control during takeover and resumes only on hand-back", () => {
    const control = createLocalControlBoundary();
    control.approve(browser);
    expect(control.canControl(browser)).toBe(true);
    expect(control.takeOver()).toMatchObject({ phase: "approved", mode: "takeover" });
    expect(control.canControl(browser)).toBe(false);
    expect(control.handBack()).toMatchObject({ phase: "approved", mode: "control" });
    expect(control.canControl(browser)).toBe(true);
  });

  it("notifies local listeners when the authority boundary changes", () => {
    const control = createLocalControlBoundary();
    const listener = vi.fn();
    const unsubscribe = control.subscribe(listener);
    control.approve(browser);
    control.stop();
    unsubscribe();
    control.takeOver();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
