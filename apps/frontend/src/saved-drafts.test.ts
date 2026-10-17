import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDraft, writeDraft } from "./saved";

const KEY = "shiba-composer-drafts-v1";
let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("composer drafts", () => {
  it("round-trips a draft per scope", () => {
    writeDraft("a", "hello");
    writeDraft("b", "world");
    expect(readDraft("a")).toBe("hello");
    expect(readDraft("b")).toBe("world");
    expect(readDraft("missing")).toBe("");
  });

  it("deletes the scope on an empty or whitespace write", () => {
    writeDraft("a", "hello");
    writeDraft("a", "  ");
    expect(readDraft("a")).toBe("");
    expect(JSON.parse(store.get(KEY) ?? "{}")).not.toHaveProperty("a");
  });

  it("keeps the newest 100 scopes and evicts the oldest", () => {
    for (let i = 0; i <= 100; i++) writeDraft(`s${i}`, `t${i}`);
    expect(Object.keys(JSON.parse(store.get(KEY) ?? "{}"))).toHaveLength(100);
    expect(readDraft("s0")).toBe("");
    expect(readDraft("s100")).toBe("t100");
  });

  it("treats corrupt JSON as empty", () => {
    store.set(KEY, "{not json");
    expect(readDraft("a")).toBe("");
    writeDraft("a", "x");
    expect(readDraft("a")).toBe("x");
  });

  it("never throws when storage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("full"); },
    });
    expect(readDraft("a")).toBe("");
    expect(() => writeDraft("a", "x")).not.toThrow();
  });
});
