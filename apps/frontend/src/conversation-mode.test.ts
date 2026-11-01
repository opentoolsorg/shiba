import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConversationMode, readRememberedSessionId, resolveRememberedSessionId, writeConversationMode, writeRememberedSessionId } from "./conversation-mode";

describe("conversation mode preference", () => {
  beforeEach(() => vi.stubGlobal("localStorage", { getItem: vi.fn(), setItem: vi.fn() }));
  afterEach(() => vi.unstubAllGlobals());

  it("defaults each thread to Chat and stores Work independently per thread", () => {
    const storage = localStorage as unknown as { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn> };
    storage.getItem.mockImplementation((key: string) => key.endsWith(":thread-a") ? "work" : null);
    expect(readConversationMode("thread-a")).toBe("work");
    expect(readConversationMode("thread-b")).toBe("chat");
    writeConversationMode("thread-b", "work");
    expect(storage.setItem).toHaveBeenCalledWith("shiba:conversation-mode:thread-b", "work");
  });

  it("fails back to Chat for corrupt values or unavailable storage", () => {
    const storage = localStorage as unknown as { getItem: ReturnType<typeof vi.fn> };
    storage.getItem.mockReturnValue("unknown");
    expect(readConversationMode("thread-a")).toBe("chat");
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); } });
    expect(readConversationMode("thread-a")).toBe("chat");
  });

  it("restores a remembered thread only when the current session list contains it", () => {
    const storage = localStorage as unknown as { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn> };
    const values = new Map<string, string>();
    storage.getItem.mockImplementation((key: string) => values.get(key) ?? null);
    storage.setItem.mockImplementation((key: string, value: string) => values.set(key, value));
    writeRememberedSessionId("thread-a");
    expect(readRememberedSessionId()).toBe("thread-a");
    expect(resolveRememberedSessionId("thread-a", [{ id: "thread-a" }])).toBe("thread-a");
    expect(resolveRememberedSessionId("thread-a", [{ id: "another-user-thread" }])).toBe("default");
    expect(resolveRememberedSessionId(null, [])).toBe("default");
  });
});
