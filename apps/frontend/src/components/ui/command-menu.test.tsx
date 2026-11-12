// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandMenu } from "./command-menu";

afterEach(cleanup);

describe("CommandMenu modal", () => {
  it("opens a modal with focus and restores its trigger after dismissal", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const onClose = vi.fn();
    const { rerender } = render(<CommandMenu open onClose={onClose} commands={[]} />);
    const dialog = screen.getByRole("dialog", { name: "Command menu" });
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("combobox"));
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledOnce();
    rerender(<CommandMenu open={false} onClose={onClose} commands={[]} />);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("provides an explicit close action", () => {
    const onClose = vi.fn();
    render(<CommandMenu open onClose={onClose} commands={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Close command menu" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
