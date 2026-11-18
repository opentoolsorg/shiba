import { describe, expect, it } from "vitest";
import { createIpcBounds, IPC_BUSY_ERROR, MAX_CONCURRENT_IPC } from "../src/ipc-guard.js";

const deferred = () => {
  let resolve: (value: string) => void = () => {};
  const promise = new Promise<string>((r) => { resolve = r; });
  return { promise, resolve };
};

describe("ipc bounds", () => {
  it("caps concurrent work and answers busy instead of queueing forever", async () => {
    const bounds = createIpcBounds(2);
    const a = deferred();
    const b = deferred();
    const running = [bounds.run(() => a.promise, () => "busy"), bounds.run(() => b.promise, () => "busy")];
    expect(bounds.active()).toBe(2);
    expect(await bounds.run(async () => "ran", () => "busy")).toBe("busy");
    a.resolve("a");
    b.resolve("b");
    expect(await Promise.all(running)).toEqual(["a", "b"]);
    expect(bounds.active()).toBe(0);
    expect(await bounds.run(async () => "ran", () => "busy")).toBe("ran");
  });

  it("releases capacity when work throws", async () => {
    const bounds = createIpcBounds(1);
    await expect(bounds.run(async () => { throw new Error("boom"); }, () => "busy")).rejects.toThrow("boom");
    expect(bounds.active()).toBe(0);
  });

  it("holds a label until the owner leaves it", () => {
    const bounds = createIpcBounds();
    expect(bounds.tryEnter("login")).toBe(true);
    expect(bounds.tryEnter("login")).toBe(false);
    bounds.leave("login");
    expect(bounds.tryEnter("login")).toBe(true);
  });

  it("defaults to a small ceiling", () => {
    expect(MAX_CONCURRENT_IPC).toBe(8);
    expect(IPC_BUSY_ERROR).toMatch(/^Too many pending/);
  });
});
