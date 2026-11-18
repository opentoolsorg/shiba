// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatSuggestions, chatSuggestionsUrl } from "./ChatSuggestions";

const respond = (body: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => body }) as Response);

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("ChatSuggestions", () => {
  it("fetches the thread's suggestions and fills the composer on pick", async () => {
    const fetchMock = respond({ suggestions: ["Plan my week", "Draft a launch email"] });
    vi.stubGlobal("fetch", fetchMock);
    const onPick = vi.fn();
    render(<ChatSuggestions agentName="web-session:user/1" refreshKey="empty" onPick={onPick} />);
    fireEvent.click(await screen.findByRole("button", { name: "Plan my week" }));
    expect(onPick).toHaveBeenCalledWith("Plan my week");
    expect(fetchMock).toHaveBeenCalledWith("/agents/coding-orchestrator/web-session%3Auser%2F1/chat-suggestions", expect.objectContaining({ credentials: "include" }));
    expect(screen.getByRole("group", { name: "Suggested prompts" })).toBeTruthy();
  });

  it("refetches after a new assistant reply but not when only visibility changes", async () => {
    const fetchMock = respond({ suggestions: ["Explain this"] });
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<ChatSuggestions agentName="user" refreshKey="a1" onPick={() => {}} />);
    await screen.findByRole("button", { name: "Explain this" });
    rerender(<ChatSuggestions agentName="user" refreshKey="a1" hidden onPick={() => {}} />);
    expect(screen.queryByRole("group")).toBeNull();
    rerender(<ChatSuggestions agentName="user" refreshKey="a1" onPick={() => {}} />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rerender(<ChatSuggestions agentName="user" refreshKey="a2" onPick={() => {}} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it.each([
    ["an empty list", respond({ suggestions: [] })],
    ["an error status", respond({ error: "nope" }, false)],
    ["a network failure", vi.fn(async () => { throw new TypeError("offline"); })],
  ])("renders nothing for %s", async (_label, fetchMock) => {
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<ChatSuggestions agentName="user" refreshKey="empty" onPick={() => {}} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.innerHTML).toBe("");
  });

  it("builds the session agent path", () => {
    expect(chatSuggestionsUrl("abc")).toBe("/agents/coding-orchestrator/abc/chat-suggestions");
  });
});
