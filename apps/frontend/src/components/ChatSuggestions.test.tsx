// @vitest-environment happy-dom
import { useState, type JSX } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatSuggestions, chatSuggestionsUrl, focusComposerDraft } from "./ChatSuggestions";
import { ChatMessageComposer } from "./ChatMessageComposer";

const respond = (body: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => body }) as Response);

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function Harness({ agentName = "user", refreshKey = "empty", submitted }: { agentName?: string; refreshKey?: string; submitted: (prompt: string) => void }): JSX.Element {
  const [draft, setDraft] = useState("");
  return (
    <>
      <ChatSuggestions agentName={agentName} refreshKey={refreshKey} hidden={draft.trim() !== ""} onPick={(prompt) => focusComposerDraft(setDraft, prompt)} />
      <ChatMessageComposer
        value={draft}
        onChange={setDraft}
        onSubmit={(event) => { event.preventDefault(); submitted(draft); }}
        onStop={() => {}}
        onRetry={() => {}}
        busy={false}
        streaming={false}
        failed={false}
      />
    </>
  );
}

describe("ChatSuggestions", () => {
  it("asks the thread with a same-origin POST and fills the composer without sending", async () => {
    const fetchMock = respond({ suggestions: ["Plan my week", "Draft a launch email"] });
    vi.stubGlobal("fetch", fetchMock);
    const submitted = vi.fn();
    const { container } = render(<Harness submitted={submitted} />);
    fireEvent.click(await screen.findByRole("button", { name: "Plan my week" }));

    const textarea = container.querySelector<HTMLTextAreaElement>("[data-testid='chat-composer'] textarea")!;
    expect(textarea.value).toBe("Plan my week");
    await waitFor(() => expect(document.activeElement).toBe(textarea));
    expect(textarea.selectionStart).toBe("Plan my week".length);
    expect(submitted).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Suggested prompts")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/agents/coding-orchestrator/user/chat-suggestions", expect.objectContaining({
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
    }));
  });

  it("refetches after a new assistant reply but not when only visibility changes", async () => {
    const fetchMock = respond({ suggestions: ["Explain this"] });
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<ChatSuggestions agentName="user" refreshKey="a1" onPick={() => {}} />);
    await screen.findByRole("button", { name: "Explain this" });
    rerender(<ChatSuggestions agentName="user" refreshKey="a1" hidden onPick={() => {}} />);
    expect(screen.queryByLabelText("Suggested prompts")).toBeNull();
    rerender(<ChatSuggestions agentName="user" refreshKey="a1" onPick={() => {}} />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rerender(<ChatSuggestions agentName="user" refreshKey="a2" onPick={() => {}} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it.each([
    ["an empty list", respond({ suggestions: [] })],
    ["an error status", respond({ error: "nope" }, false)],
    ["a rate-limited empty list", respond({ suggestions: [] })],
    ["a network failure", vi.fn(async () => { throw new TypeError("offline"); })],
  ])("renders nothing and leaves the composer usable for %s", async (_label, fetchMock) => {
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<Harness submitted={() => {}} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByLabelText("Suggested prompts")).toBeNull();
    expect(container.querySelector("[data-testid='chat-composer'] textarea")).not.toBeNull();
  });

  it("does not ask while a draft hides the suggestions, then asks once the composer is cleared", async () => {
    const fetchMock = respond({ suggestions: ["Explain this"] });
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<ChatSuggestions agentName="user" refreshKey="empty" hidden onPick={() => {}} />);
    rerender(<ChatSuggestions agentName="other" refreshKey="empty" hidden onPick={() => {}} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    rerender(<ChatSuggestions agentName="other" refreshKey="empty" onPick={() => {}} />);
    await screen.findByRole("button", { name: "Explain this" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps one request for a reply when a draft is typed and cleared while it is pending", async () => {
    let answer: (response: Response) => void = () => {};
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<ChatSuggestions agentName="user" refreshKey="a1" onPick={() => {}} />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rerender(<ChatSuggestions agentName="user" refreshKey="a1" hidden onPick={() => {}} />);
    rerender(<ChatSuggestions agentName="user" refreshKey="a1" onPick={() => {}} />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    answer({ ok: true, json: async () => ({ suggestions: ["Explain this"] }) } as Response);
    await screen.findByRole("button", { name: "Explain this" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("waits out a live stream or recovery before asking, then asks once", async () => {
    const fetchMock = respond({ suggestions: ["Explain this"] });
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<ChatSuggestions agentName="user" refreshKey="a1" busy onPick={() => {}} />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Suggested prompts")).toBeNull();
    rerender(<ChatSuggestions agentName="user" refreshKey="a1" busy={false} onPick={() => {}} />);
    await screen.findByRole("button", { name: "Explain this" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Suggested prompts")).toBeTruthy();
  });

  it("builds the session agent path", () => {
    expect(chatSuggestionsUrl("web:user/abc")).toBe("/agents/coding-orchestrator/web%3Auser%2Fabc/chat-suggestions");
  });
});
