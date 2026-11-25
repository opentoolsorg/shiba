// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkQuickAdd } from "./WorkQuickAdd";

afterEach(() => {
  cleanup();
});

const getInput = () =>
  screen.getByRole("textbox", { name: "Add a task and press Enter" }) as HTMLInputElement;

describe("WorkQuickAdd", () => {
  it("renders the dashed add bar with the spec placeholder", () => {
    render(<WorkQuickAdd onSubmit={vi.fn()} />);
    const input = getInput();
    expect(input.getAttribute("placeholder")).toBe("Add a task and press Enter");
    expect(input.closest("label")?.className).toContain("border-dashed");
  });

  it("submits trimmed text on Enter, clears the input and keeps focus", () => {
    const onSubmit = vi.fn();
    render(<WorkQuickAdd onSubmit={onSubmit} />);

    const input = getInput();
    input.focus();
    fireEvent.change(input, { target: { value: "  Fix header alignment  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("Fix header alignment");
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
  });

  it("ignores Enter when the input is empty or whitespace-only", () => {
    const onSubmit = vi.fn();
    render(<WorkQuickAdd onSubmit={onSubmit} />);

    const input = getInput();
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(input.value).toBe("   ");
  });

  it("blurs on Escape and keeps the draft without submitting", () => {
    const onSubmit = vi.fn();
    render(<WorkQuickAdd onSubmit={onSubmit} />);

    const input = getInput();
    input.focus();
    fireEvent.change(input, { target: { value: "Draft task" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(input);
    expect(input.value).toBe("Draft task");
  });

  it("disables the input when disabled is true and ignores Enter", () => {
    const onSubmit = vi.fn();
    render(<WorkQuickAdd onSubmit={onSubmit} disabled />);

    const input = getInput();
    expect(input.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "Should not submit" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("accepts custom placeholder and aria-label", () => {
    render(
      <WorkQuickAdd
        onSubmit={vi.fn()}
        placeholder="Custom placeholder"
        aria-label="Custom task input"
      />,
    );

    const input = screen.getByRole("textbox", { name: "Custom task input" });
    expect(input.getAttribute("placeholder")).toBe("Custom placeholder");
  });

  it("shows a pending state while the async submit runs, keeps focus, then clears on success", async () => {
    let finish!: (ok: boolean) => void;
    const onSubmit = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    render(<WorkQuickAdd onSubmit={onSubmit} />);

    const input = getInput();
    input.focus();
    fireEvent.change(input, { target: { value: "Ship it" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(input.readOnly).toBe(true);
    expect(input.closest("form")?.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Adding task")).toBeTruthy();
    expect(document.activeElement).toBe(input);

    await act(async () => finish(true));
    expect(input.value).toBe("");
    expect(input.readOnly).toBe(false);
    expect(input.closest("form")?.getAttribute("aria-busy")).toBe("false");
    expect(document.activeElement).toBe(input);
  });

  it("keeps the draft and blocks double submit when the async submit resolves false", async () => {
    let finish!: (ok: boolean) => void;
    const onSubmit = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    render(<WorkQuickAdd onSubmit={onSubmit} />);
    const input = getInput();
    fireEvent.change(input, { target: { value: "Keep me" } });
    fireEvent.submit(input.closest("form")!);
    fireEvent.submit(input.closest("form")!);
    expect(onSubmit).toHaveBeenCalledOnce();
    await act(async () => finish(false));
    expect(input.value).toBe("Keep me");
    expect(input.readOnly).toBe(false);
  });

  it("shows an alert and keeps the draft when the async submit rejects, clearing it on edit", async () => {
    render(<WorkQuickAdd onSubmit={vi.fn().mockRejectedValue(new Error("offline"))} />);
    const input = getInput();
    fireEvent.change(input, { target: { value: "Draft" } });
    fireEvent.submit(input.closest("form")!);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not create the task. Your draft has been kept. Try again.",
    );
    expect(input.value).toBe("Draft");
    expect(input.getAttribute("aria-invalid")).toBe("true");

    fireEvent.change(input, { target: { value: "Draft 2" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("sends only the filled-in supported fields as a create patch", () => {
    const onSubmit = vi.fn();
    const fields = { owners: [{ id: "agent:coder", name: "Coder" }], tasks: [{ id: "task_a", title: "Write spec" }] };
    render(<WorkQuickAdd onSubmit={onSubmit} fields={fields} />);
    fireEvent.click(screen.getByRole("button", { name: "Add details" }));
    fireEvent.change(screen.getByLabelText("Assignee"), { target: { value: "agent:coder" } });
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-12-01" } });
    fireEvent.change(screen.getByLabelText("Depends on"), { target: { value: "task_a" } });
    fireEvent.change(getInput(), { target: { value: "Ship it" } });
    fireEvent.keyDown(getInput(), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("Ship it", {
      ownerId: "agent:coder",
      startDate: "2026-12-01",
      waitingOn: ["task_a"],
    });
    expect((screen.getByLabelText("Assignee") as HTMLSelectElement).value).toBe("");
  });

  it("submits the title alone when no detail is filled in, and hides details without fields", () => {
    const onSubmit = vi.fn();
    const { rerender } = render(<WorkQuickAdd onSubmit={onSubmit} />);
    expect(screen.queryByRole("button", { name: "Add details" })).toBeNull();
    rerender(<WorkQuickAdd onSubmit={onSubmit} fields={{ owners: [], tasks: [] }} />);
    fireEvent.change(getInput(), { target: { value: "Just a title" } });
    fireEvent.keyDown(getInput(), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("Just a title");
  });
});
