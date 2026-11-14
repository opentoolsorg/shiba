// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommandMenu } from "./command-menu";

describe("CommandPalette", () => {
  it("calls onQueryChange when typing", () => {
    const onQueryChange = vi.fn();
    render(
      <CommandMenu
        open
        onClose={() => {}}
        onQueryChange={onQueryChange}
        commands={[{ id: "new-task", label: "New task", run: () => {} }]}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("Type a command or search…"), { target: { value: "readme" } });
    expect(onQueryChange).toHaveBeenCalled();
  });
});