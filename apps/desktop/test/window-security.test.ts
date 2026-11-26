import { describe, expect, it, vi } from "vitest";
import { guardWebContents, type GuardedContents } from "../src/window-security.js";

const ORIGIN = "https://shiba.example.com";
const SETUP = "file:///opt/shiba/setup.html";

type Listener = (event: unknown) => void;

function fakeContents() {
  const listeners = new Map<string, Listener[]>();
  const openHandlers: ((details: { url: string }) => { action: "deny" })[] = [];
  const contents: GuardedContents = {
    on: ((event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return contents;
    }) as GuardedContents["on"],
    setWindowOpenHandler: (handler) => {
      openHandlers.push(handler);
      return contents;
    },
  };
  const emit = (event: string, payload: unknown) => {
    const prevented = { value: false };
    const target = payload as Record<string, unknown>;
    for (const listener of listeners.get(event) ?? []) {
      listener({ ...target, preventDefault: () => { prevented.value = true; } });
    }
    return prevented.value;
  };
  const open = (url: string) => openHandlers[0]?.({ url });
  return { contents, emit, open, listeners };
}

function guard(options: { allowFileUrl?: string; allowFileUrls?: readonly string[] } = {}) {
  const opened: string[] = [];
  const decisions: string[] = [];
  const contents = fakeContents();
  guardWebContents(
    contents.contents,
    {
      configuredOrigin: () => ORIGIN,
      authHosts: () => ["accounts.google.com"],
      openExternal: (url) => opened.push(url),
      onDecision: (decision) => decisions.push(decision),
    },
    options,
  );
  return { ...contents, opened, decisions };
}

describe("window policy", () => {
  it("allows the configured origin and refuses everything that is not https", () => {
    const g = guard();
    expect(g.emit("will-navigate", { url: `${ORIGIN}/app/?tab=diff` })).toBe(false);
    expect(g.emit("will-navigate", { url: "http://shiba.example.com/app/" })).toBe(true);
    expect(g.emit("will-navigate", { url: "file:///etc/passwd" })).toBe(true);
    expect(g.emit("will-redirect", { url: "https://user:pw@example.org/" })).toBe(true);
    expect(g.opened).toEqual([]);
  });

  it("hands a plain external https link to the OS browser", () => {
    const g = guard();
    expect(g.emit("will-navigate", { url: "https://example.org/docs?x=1#top" })).toBe(true);
    expect(g.opened).toEqual(["https://example.org/docs?x=1#top"]);
  });

  it("keeps hosted sign-in hops in the window", () => {
    const g = guard();
    expect(g.emit("will-navigate", { url: "https://accounts.google.com/o/oauth2/auth" })).toBe(false);
    expect(g.opened).toEqual([]);
  });

  it("allows only the bundled setup page as a file: load", () => {
    const g = guard({ allowFileUrl: SETUP });
    expect(g.emit("will-navigate", { url: SETUP })).toBe(false);
    expect(g.emit("will-navigate", { url: "file:///tmp/other.html" })).toBe(true);
  });

  it("allows each explicitly bundled local page without allowing other file URLs", () => {
    const localBrowser = "file:///opt/shiba/local-browser.html";
    const g = guard({ allowFileUrls: [SETUP, localBrowser] });
    expect(g.emit("will-navigate", { url: SETUP })).toBe(false);
    expect(g.emit("will-navigate", { url: localBrowser })).toBe(false);
    expect(g.emit("will-navigate", { url: "file:///tmp/untrusted.html" })).toBe(true);
  });

  it("pins subframes to the app origin and ignores the main frame", () => {
    const g = guard();
    expect(g.emit("will-frame-navigate", { url: `${ORIGIN}/artifact?id=1`, isMainFrame: false })).toBe(false);
    expect(g.emit("will-frame-navigate", { url: "https://evil.example/", isMainFrame: false })).toBe(true);
    expect(g.emit("will-frame-navigate", { url: "https://example.org/", isMainFrame: true })).toBe(false);
  });

  it("denies every popup and never opens a non-https one", () => {
    const g = guard();
    expect(g.open("https://example.org/pr")).toEqual({ action: "deny" });
    expect(g.open(`${ORIGIN}/app/`)).toEqual({ action: "deny" });
    expect(g.open("javascript:alert(1)")).toEqual({ action: "deny" });
    expect(g.open("https://user:pw@example.org/")).toEqual({ action: "deny" });
    expect(g.opened).toEqual(["https://example.org/pr"]);
  });

  it("applies the frame policy to subframe redirects, never the main-frame one", () => {
    const g = guard();
    // A child frame redirected to a sign-in host is refused, not handed to the OS.
    expect(
      g.emit("will-redirect", { url: "https://accounts.google.com/o/oauth2/auth", isMainFrame: false }),
    ).toBe(true);
    expect(g.opened).toEqual([]);
    // A same-origin child redirect continues.
    expect(
      g.emit("will-redirect", { url: `${ORIGIN}/artifact?id=2`, isMainFrame: false }),
    ).toBe(false);
    // A main-frame redirect keeps the normal policy and the OS handoff.
    expect(g.emit("will-redirect", { url: "https://example.org/moved", isMainFrame: true })).toBe(true);
    expect(g.opened).toEqual(["https://example.org/moved"]);
  });

  it("hands an allowed sign-in popup to the OS browser instead of dropping it", () => {
    const g = guard();
    expect(g.open("https://accounts.google.com/o/oauth2/auth?client_id=x")).toEqual({ action: "deny" });
    expect(g.opened).toEqual(["https://accounts.google.com/o/oauth2/auth?client_id=x"]);
  });

  it("refuses webview attachment", () => {
    const g = guard();
    expect(g.emit("will-attach-webview", {})).toBe(true);
  });

  it("records a denial for each refusal", () => {
    const g = guard();
    g.emit("will-navigate", { url: "http://example.org/" });
    g.open("http://example.org/");
    expect(g.decisions).toEqual(["deny", "deny"]);
    expect(vi.isMockFunction(g.contents.on)).toBe(false);
  });
});
