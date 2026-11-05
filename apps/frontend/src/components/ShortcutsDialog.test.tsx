// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ShortcutsDialog, singleKeyShortcutsEnabled } from "./ShortcutsDialog";

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

  it("lists the implemented rail, work and chat shortcuts without upcoming markers", () => {
    render(<ShortcutsDialog open onClose={vi.fn()} />);
    expect(screen.getByText("⌥1–7")).toBeTruthy();
    expect(screen.getByText("⌘,")).toBeTruthy();
    expect(screen.getByText("C")).toBeTruthy();
    expect(screen.getByText("/")).toBeTruthy();
    expect(screen.queryByText(/upcoming/i)).toBeNull();
    expect(screen.getByText(/Single-key shortcuts/)).toBeTruthy();
  });

  it("renders nothing while closed", () => {
    const { container } = render(<ShortcutsDialog open={false} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("single-key shortcut setting", () => {
  it("persists turning single-key shortcuts off", () => {
    localStorage.removeItem("shiba:single-key-shortcuts");
    render(<ShortcutsDialog open onClose={() => {}} />);
    const toggle = screen.getByRole("checkbox", { name: "Enable single-key shortcuts" }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(singleKeyShortcutsEnabled()).toBe(false);
  });
});

describe("ShortcutsDialog focus", () => {
  it("does not pull focus back to Close when the onClose identity changes", () => {
    const { rerender } = render(<ShortcutsDialog open onClose={() => {}} />);
    const toggle = screen.getByRole("checkbox", { name: "Enable single-key shortcuts" });
    toggle.focus();
    rerender(<ShortcutsDialog open onClose={() => {}} />);
    expect(document.activeElement).toBe(toggle);
  });
});
