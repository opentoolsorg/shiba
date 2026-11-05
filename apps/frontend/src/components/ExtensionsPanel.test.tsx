// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionsPanel } from "./ExtensionsPanel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ExtensionsPanel", () => {
  it("renders panel with title, scope switch, and all navigation items", () => {
    const onScopeChange = vi.fn();
    const onSelect = vi.fn();

    render(
      <ExtensionsPanel
        scope="personal"
        onScopeChange={onScopeChange}
        active="skills"
        onSelect={onSelect}
      />
    );

    expect(screen.getByRole("heading", { name: "Extensions" })).toBeTruthy();

    const personalTab = screen.getByRole("tab", { name: "Personal" });
    const workspaceTab = screen.getByRole("tab", { name: "Workspace" });
    expect(personalTab.getAttribute("aria-selected")).toBe("true");
    expect(workspaceTab.getAttribute("aria-selected")).toBe("false");

    fireEvent.click(workspaceTab);
    expect(onScopeChange).toHaveBeenCalledWith("workspace");

    expect(screen.getByRole("button", { name: /Connectors/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Skills/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /MCPs/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Providers/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Apps/i })).toBeTruthy();

    const skillsBtn = screen.getByRole("button", { name: /Skills/i });
    expect(skillsBtn.getAttribute("aria-current")).toBe("page");

    const connectorsBtn = screen.getByRole("button", { name: /Connectors/i });
    expect(connectorsBtn.getAttribute("aria-current")).toBeNull();

    fireEvent.click(connectorsBtn);
    expect(onSelect).toHaveBeenCalledWith("integrations");
  });

  it("handles alias active states like 'integrations', 'agents', 'mcp', 'spaces'", () => {
    const onScopeChange = vi.fn();
    const onSelect = vi.fn();

    const { rerender } = render(
      <ExtensionsPanel
        scope="workspace"
        onScopeChange={onScopeChange}
        active="integrations"
        onSelect={onSelect}
      />
    );

    expect(screen.getByRole("button", { name: /Connectors/i }).getAttribute("aria-current")).toBe("page");

    rerender(
      <ExtensionsPanel
        scope="workspace"
        onScopeChange={onScopeChange}
        active="agents"
        onSelect={onSelect}
      />
    );
    expect(screen.getByRole("button", { name: /MCPs/i }).getAttribute("aria-current")).toBe("page");

    rerender(
      <ExtensionsPanel
        scope="workspace"
        onScopeChange={onScopeChange}
        active="mcp"
        onSelect={onSelect}
      />
    );
    expect(screen.getByRole("button", { name: /MCPs/i }).getAttribute("aria-current")).toBe("page");

    rerender(
      <ExtensionsPanel
        scope="workspace"
        onScopeChange={onScopeChange}
        active="spaces"
        onSelect={onSelect}
      />
    );
    expect(screen.getByRole("button", { name: /Apps/i }).getAttribute("aria-current")).toBe("page");
  });

  it("allows searching/filtering extension sections", () => {
    render(
      <ExtensionsPanel
        scope="personal"
        onScopeChange={vi.fn()}
        active="skills"
        onSelect={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Search extensions" }));
    const input = screen.getByRole("searchbox", { name: "Filter extensions" });
    expect(input).toBeTruthy();

    fireEvent.change(input, { target: { value: "skill" } });
    expect(screen.getByRole("button", { name: /Skills/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Connectors/i })).toBeNull();
  });
});
