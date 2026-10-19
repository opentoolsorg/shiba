// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ShortcutsDialog } from "./ShortcutsDialog";

afterEach(() => cleanup());

describe("ShortcutsDialog", () => {
  it("lists the shortcuts the shell handles and closes", () => {
    const onClose = vi.fn();
    render(<ShortcutsDialog open onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(dialog).toBeTruthy();
    expect(screen.getByText("Next thread")).toBeTruthy();
    expect(screen.getByText("J")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close shortcuts" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("renders nothing while closed", () => {
    const { container } = render(<ShortcutsDialog open={false} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});
