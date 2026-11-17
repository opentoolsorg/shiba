// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentChatHeader } from "./AgentChatHeader";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const props = { agent: { id: "scout", name: "Scout" }, participants: [], panelOpen: false, onTogglePanel: () => {}, sideQuestion: { employeeId: "scout", threadId: "thread-one" } };
function open() { fireEvent.click(screen.getByRole("button", { name: "Ask on the side" })); }
function ask(text: string) { fireEvent.change(screen.getByRole("textbox", { name: "Side question" }), { target: { value: text } }); fireEvent.click(screen.getByRole("button", { name: "Ask" })); }

describe("side-question popover", () => {
  it("keeps earlier pairs only while open and clears on thread change", async () => {
    const fetcher = vi.fn(async () => Response.json({ answer: "Testing now." }));
    vi.stubGlobal("fetch", fetcher);
    const { rerender } = render(<AgentChatHeader {...props} />);
    open();
    expect((screen.getByRole("button", { name: "Ask" }) as HTMLButtonElement).disabled).toBe(true);
    ask("Progress?");
    await screen.findByText("Testing now.");
    ask("Which tests?");
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(JSON.parse((fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)).toEqual({ question: "Which tests?", earlier: [{ question: "Progress?", answer: "Testing now." }], threadId: "thread-one" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    open();
    expect(screen.queryByText("Testing now.")).toBeNull();
    ask("Again?"); await screen.findByText("Testing now.");
    rerender(<AgentChatHeader {...props} sideQuestion={{ ...props.sideQuestion, threadId: "thread-two" }} />);
    expect(screen.queryByRole("dialog", { name: "Ask on the side" })).toBeNull();
    open(); expect(screen.queryByText("Testing now.")).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Ask on the side" })).toBeNull();
  });
  it("shows the provider's readable 409 sentence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "The chat provider is busy. Please try again shortly." }, { status: 409 })));
    render(<AgentChatHeader {...props} />); open(); ask("Progress?");
    expect((await screen.findByRole("alert")).textContent).toBe("The chat provider is busy. Please try again shortly.");
    expect((screen.getByRole("textbox", { name: "Side question" }) as HTMLInputElement).value).toBe("Progress?");
  });
});
