// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentComposerShell, type MentionableAgent } from "./AgentComposerShell";

afterEach(cleanup);

const agents: MentionableAgent[] = [{ id: "coding-coworker", name: "Agni" }, { id: "pr-reviewer", name: "Ved" }];

function Harness({ initial = "", onSubmit = vi.fn(), list = agents, onPrepareWork }: { initial?: string; onSubmit?: () => void; list?: MentionableAgent[]; onPrepareWork?: () => void }) {
  const [value, setValue] = useState(initial);
  return (
    <AgentComposerShell
      agentName="Agni"
      agents={list}
      value={value}
      onChange={setValue}
      onSubmit={(event) => { event.preventDefault(); onSubmit(); }}
      onStop={vi.fn()}
      onRetry={vi.fn()}
      onPrepareWork={onPrepareWork}
      busy={false}
      streaming={false}
      failed={false}
    />
  );
}

const textbox = () => screen.getByRole("textbox", { name: "Message Agni" }) as HTMLTextAreaElement;

describe("AgentComposerShell", () => {
  it("shows the agent placeholder, footer, and a send button disabled while empty", () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    expect(textbox().placeholder).toBe("What do you want to get done?");
    expect(screen.getByText("Agni can make mistakes. Check important info.")).toBeTruthy();
    const send = screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(textbox(), { target: { value: "Ship it" } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("forwards the saved-draft review action without submitting or changing mention text", () => {
    const onPrepareWork = vi.fn();
    const onSubmit = vi.fn();
    render(<Harness initial="Ask @Ved to inspect the release plan" onPrepareWork={onPrepareWork} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: "Review as work" }));
    expect(onPrepareWork).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textbox().value).toBe("Ask @Ved to inspect the release plan");
  });

  it("inserts @ and replaces it with the chosen agent from the mention list", async () => {
    render(<Harness initial="Ask " />);
    textbox().setSelectionRange(4, 4);
    const mention = screen.getByRole("button", { name: "Mention" });
    fireEvent.click(mention);
    expect(textbox().value).toBe("Ask @");
    expect(mention.getAttribute("aria-expanded")).toBe("true");
    const menu = screen.getByRole("menu", { name: "Mention an agent" });
    expect(document.activeElement?.textContent).toBe("Agni");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Ved");
    await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "Ved" })); });
    expect(textbox().value).toBe("Ask @Ved ");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes the mention list on Escape and keeps the typed @", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Mention" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(textbox().value).toBe("@");
  });

  it("says so when there are no agents to mention", () => {
    render(<Harness list={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Mention" }));
    expect(screen.getByText("No agents to mention")).toBeTruthy();
  });
});
