import { describe, expect, it, vi } from "vitest";
import { createQuitHandler } from "../src/quit.js";

describe("desktop quit cleanup", () => {
  it("blocks repeated quit attempts until cleanup completes, then allows Electron to flush storage", async () => {
    let finish!: () => void;
    const stop = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const cleanup = vi.fn(), quit = vi.fn(), confirm = vi.fn(() => true);
    const onBeforeQuit = createQuitHandler({ confirm, stop, cleanup, quit, onError: vi.fn() });
    const first = { preventDefault: vi.fn() }, repeated = { preventDefault: vi.fn() };
    onBeforeQuit(first);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    onBeforeQuit(repeated);
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(repeated.preventDefault).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(cleanup).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    expect(cleanup).toHaveBeenCalledOnce();
    const final = { preventDefault: vi.fn() };
    onBeforeQuit(final);
    expect(final.preventDefault).not.toHaveBeenCalled();
  });

  it("does not start cleanup after Cancel and can quit on a later attempt", async () => {
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const stop = vi.fn(async () => {}), quit = vi.fn();
    const onBeforeQuit = createQuitHandler({ confirm, stop, quit, cleanup: vi.fn(), onError: vi.fn() });
    onBeforeQuit({ preventDefault: vi.fn() });
    expect(stop).not.toHaveBeenCalled();
    onBeforeQuit({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    expect(stop).toHaveBeenCalledOnce();
  });

  it("records a failed stop and still completes normal shutdown", async () => {
    const failure = new Error("daemon stop failed");
    const cleanup = vi.fn(), quit = vi.fn(), onError = vi.fn();
    const onBeforeQuit = createQuitHandler({ confirm: () => true, stop: () => Promise.reject(failure), cleanup, quit, onError });
    onBeforeQuit({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    expect(cleanup).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);
  });
});
