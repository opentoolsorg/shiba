// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";
import { jumpKeyLabel } from "./jump-keys";
import type { PaletteBot } from "./usePaletteBots";

const workspaceId = "ws_aaaaaaaaaaaaaaaaaaaaaaaa";
const bots: PaletteBot[] = [{
  agentId: "fixer", actorId: "agent:fixer", name: "Talia", avatar: null, pinnedSlot: 1,
  preview: "Opened PR 12", previewAt: 2, roomId: "room_1", threadRootId: null, state: "working", unread: 2,
}];
const settings = [{ id: "status", label: "Status" }, { id: "account", label: "Account" }];
let searches: Array<{ resolve: (body: unknown) => void }>;

beforeEach(() => {
  searches = [];
  localStorage.clear();
  vi.stubGlobal("WebSocket", class { close() {} send() {} addEventListener() {} removeEventListener() {} });
  vi.stubGlobal("fetch", (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/palette/bots")) return Promise.resolve(Response.json({ bots }));
    if (url.includes("/api/needs-you")) return Promise.resolve(Response.json({ approvals: [], questions: [], mentions: [], handoffs: [], blocked: [] }));
    if (url.includes("/api/search")) {
      return new Promise((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        searches.push({ resolve: (body) => resolve(Response.json(body)) });
      });
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function renderPalette(onOpenBot = vi.fn()) {
  render(
    <CommandPalette
      open workspaceId={workspaceId} roomThreadOpen={false} needsYouCount={1} settings={settings}
      onClose={() => {}} onNewTask={() => {}} onNewChannel={() => {}} onOpenBot={onOpenBot}
      onOpenChat={() => {}} onOpenTask={() => {}} onOpenSettings={() => {}} onOpenNeedsYou={() => {}}
      onToggleTheme={() => {}} onOpenShortcuts={() => {}} onInsertAgentMention={() => {}}
      onSearchAll={() => {}} onMessageAbout={() => {}}
    />,
  );
  return onOpenBot;
}

describe("CommandPalette", () => {
  it("renders groups in order and selects the first row", async () => {
    renderPalette();
    const first = await screen.findByRole("option", { name: "Talia, working, 2 unread, last message: Opened PR 12" });
    expect(first.getAttribute("aria-selected")).toBe("true");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "ta" } });
    await vi.waitFor(() => expect(searches.length).toBe(1));
    searches[0]?.resolve({ chats: [{ roomId: "room_q", threadRootId: null, messageId: "m1", title: "qa", snippet: "target note", updatedAt: Date.now() }], tasks: [{ taskId: "task_1", title: "target task", snippet: "body", updatedAt: Date.now(), status: "in-progress" }] });
    expect(await screen.findByRole("heading", { name: "Tasks" })).toBeTruthy();
    expect(screen.getAllByRole("heading").map((node) => node.textContent)).toEqual(["Bots", "Chats & threads", "Tasks", "Settings", "Actions"]);
    expect(screen.getByRole("combobox")).toBeTruthy();
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Bots" })).toBeTruthy();
  });

  it("filters static items while keeping server rows", async () => {
    renderPalette();
    await screen.findByRole("option", { name: /Talia/ });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "short" } });
    await vi.waitFor(() => expect(searches.length).toBe(1));
    searches[0]?.resolve({ chats: [{ roomId: "room_q", threadRootId: null, messageId: null, title: "Quarterly", snippet: "plan", updatedAt: Date.now() }], tasks: [] });
    expect(await screen.findByText(/Quarterly/)).toBeTruthy();
    expect(screen.getByText("Keyboard shortcuts")).toBeTruthy();
    expect(screen.queryByText("New task…")).toBeNull();
  });

  it("drops a stale search response", async () => {
    renderPalette();
    await screen.findByRole("option", { name: /Talia/ });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "ab" } });
    await vi.waitFor(() => expect(searches.length).toBe(1));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "abc" } });
    await vi.waitFor(() => expect(searches.length).toBe(2));
    searches[1]?.resolve({ chats: [{ roomId: "room_2", threadRootId: null, messageId: "m2", title: "Second", snippet: "later", updatedAt: Date.now() }], tasks: [] });
    searches[0]?.resolve({ chats: [{ roomId: "room_1", threadRootId: null, messageId: "m1", title: "First", snippet: "early", updatedAt: Date.now() }], tasks: [] });
    expect(await screen.findByText(/Second/)).toBeTruthy();
    expect(screen.queryByText(/First/)).toBeNull();
  });

  it("shows skeleton rows only after 150ms", async () => {
    vi.useFakeTimers();
    renderPalette();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "zz" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(120); });
    expect(screen.queryByTestId("palette-skeleton")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(149); });
    expect(screen.queryByTestId("palette-skeleton")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByTestId("palette-skeleton")).toBeTruthy();
  });

  it("labels jump keys per platform", () => {
    expect(jumpKeyLabel(1, "mac", true)).toBe("⌘1");
    expect(jumpKeyLabel(2, "other", true)).toBe("Ctrl+2");
    expect(jumpKeyLabel(3, "mac", false)).toBe("⌃3");
    expect(jumpKeyLabel(4, "other", false)).toBe("Alt+Shift+4");
  });

  it("opens on enter and focuses the composer on meta enter", async () => {
    const onOpenBot = renderPalette();
    const option = await screen.findByRole("option", { name: /Talia/ });
    fireEvent.keyDown(option, { key: "Enter", metaKey: true });
    fireEvent.click(option);
    expect(onOpenBot).toHaveBeenCalledWith(expect.objectContaining({ agentId: "fixer" }), true);
    fireEvent.click(option);
    expect(onOpenBot).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: "fixer" }), false);
  });

  it("stores recent ids only", async () => {
    const onOpenBot = renderPalette();
    fireEvent.click(await screen.findByRole("option", { name: /Talia/ }));
    const stored = localStorage.getItem(`shiba:palette:recents:${workspaceId}`);
    expect(stored).toBe(JSON.stringify(["bot:fixer"]));
    expect(stored).not.toContain("Opened");
    expect(onOpenBot).toHaveBeenCalled();
  });
});
