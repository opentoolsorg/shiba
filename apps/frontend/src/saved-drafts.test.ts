import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composerDraftScope, readDraft, readDraftReference, writeDraft } from "./saved";

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
  it("isolates identical session names across authenticated owners and leaves legacy cache unclaimed", () => {
    writeDraft("default", "Legacy unscoped text");
    writeDraft(composerDraftScope("owner-a", "default"), "Private A brief", { draftTaskId: "draft_00000000-0000-4000-8000-000000000001", version: 1 });
    expect(readDraft(composerDraftScope("owner-b", "default"))).toBe("");
    expect(readDraftReference(composerDraftScope("owner-b", "default"))).toBeNull();
    expect(readDraft(composerDraftScope("owner-a", "default"))).toBe("Private A brief");
  });
  it("retains a strict first-task reference with its session text, then drops it on replacement", () => {
    const reference = { draftTaskId: "draft_00000000-0000-4000-8000-000000000001", version: 3 };
    writeDraft("a", "Canonical brief", reference);
    expect(readDraftReference("a")).toEqual(reference);
    expect(readDraftReference("b")).toBeNull();
    writeDraft("a", "An edited ordinary task");
    expect(readDraftReference("a")).toBeNull();
    writeDraft("a", "brief", { draftTaskId: "untrusted-id", version: 1 });
    expect(readDraftReference("a")).toBeNull();
  });
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
