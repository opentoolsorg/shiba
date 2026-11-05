// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkQuickAdd } from "./WorkQuickAdd";

afterEach(() => {
  cleanup();
});

describe("WorkQuickAdd", () => {
  it("submits trimmed text on Enter and clears the input", () => {
    const onSubmit = vi.fn();
    render(<WorkQuickAdd onSubmit={onSubmit} />);

    const input = screen.getByRole("textbox", { name: "Add a task and press Enter" });
    fireEvent.change(input, { target: { value: "  Fix header alignment  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("Fix header alignment");
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("ignores Enter when the input is empty or whitespace-only", () => {
    const onSubmit = vi.fn();
    render(<WorkQuickAdd onSubmit={onSubmit} />);

    const input = screen.getByRole("textbox", { name: "Add a task and press Enter" });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSubmit).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe("   ");
  });

  it("clears the input on Escape without calling onSubmit", () => {
    const onSubmit = vi.fn();
    render(<WorkQuickAdd onSubmit={onSubmit} />);

    const input = screen.getByRole("textbox", { name: "Add a task and press Enter" });
    fireEvent.change(input, { target: { value: "Draft task" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onSubmit).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("disables the input when disabled is true and ignores Enter", () => {
    const onSubmit = vi.fn();
    render(<WorkQuickAdd onSubmit={onSubmit} disabled />);

    const input = screen.getByRole("textbox", { name: "Add a task and press Enter" }) as HTMLInputElement;
    expect(input.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "Should not submit" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("accepts custom placeholder and aria-label", () => {
    const onSubmit = vi.fn();
    render(
      <WorkQuickAdd
        onSubmit={onSubmit}
        placeholder="Custom placeholder"
        aria-label="Custom task input"
      />
    );

    const input = screen.getByRole("textbox", { name: "Custom task input" });
    expect(input.getAttribute("placeholder")).toBe("Custom placeholder");
  });
});
