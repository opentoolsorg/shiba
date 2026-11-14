// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationModeSwitch } from "./ConversationModeSwitch";

afterEach(() => cleanup());

describe("ConversationModeSwitch", () => {
  it("exposes selected Chat and Work tabs and changes mode explicitly", () => {
    const onChange = vi.fn();
    render(<ConversationModeSwitch value="chat" onChange={onChange} />);
    expect(screen.getByRole("tab", { name: "Chat" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Work" }).getAttribute("aria-selected")).toBe("false");
    fireEvent.click(screen.getByRole("tab", { name: "Work" }));
    expect(onChange).toHaveBeenCalledWith("work");
    expect(screen.getByText("CONVERSATION · NO TASK TOOLS")).toBeTruthy();
  });

  it("keeps human review visible in Work mode and can return to Chat", () => {
    const onChange = vi.fn();
    render(<ConversationModeSwitch value="work" onChange={onChange} />);
    expect(screen.getByRole("tab", { name: "Work" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText(/Submitting work requests human approval before execution/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));
    expect(onChange).toHaveBeenCalledWith("chat");
  });

  it("locks mode switching while the current reply is streaming", () => {
    const onChange = vi.fn();
    render(<ConversationModeSwitch value="chat" onChange={onChange} disabled />);
    expect((screen.getByRole("tab", { name: "Work" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: "Work" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
