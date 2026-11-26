// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationPrefsSection } from "./NotificationPrefsSection";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("NotificationPrefsSection", () => {
  it("states that preferences never grant approval and links to the inbox and approvals", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ prefs: { mentions: true, threadReplies: true, agentApprovals: false } })));
    const onNavigate = vi.fn();
    render(<NotificationPrefsSection onNavigate={onNavigate} />);
    expect(await screen.findByText("Agent approvals")).toBeTruthy();
    const note = screen.getByRole("note", { name: "Preferences do not grant approval" });
    expect(note.textContent).toMatch(/does not approve a run or publish a pull request/);
    fireEvent.click(screen.getByRole("button", { name: "Open notification inbox →" }));
    expect(onNavigate).toHaveBeenLastCalledWith("collaboration");
    fireEvent.click(screen.getByRole("button", { name: "Review approvals →" }));
    expect(onNavigate).toHaveBeenLastCalledWith("approvals");
  });

  it("keeps the callout visible and omits links without navigation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    render(<NotificationPrefsSection />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("note", { name: "Preferences do not grant approval" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Review approvals →" })).toBeNull();
  });
});
