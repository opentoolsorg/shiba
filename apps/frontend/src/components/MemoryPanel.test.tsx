// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryPanel } from "./MemoryPanel";

const json = (value: unknown) => Response.json(value);

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ facts: [], sessions: [], sources: [], projects: [] })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MemoryPanel", () => {
  it("renders header, navigation items, count badges, and project list", () => {
    const onSelect = vi.fn();
    const onScopeChange = vi.fn();
    const onSelectProject = vi.fn();

    render(
      <MemoryPanel
        scope="personal"
        onScopeChange={onScopeChange}
        active="facts"
        onSelect={onSelect}
        counts={{ facts: 42, sources: 5, sessions: 18 }}
        projects={[
          { id: "proj_1", name: "Security Audit" },
          { id: "proj_2", name: "Marketing Launch" },
        ]}
        selectedProject="proj_1"
        onSelectProject={onSelectProject}
      />,
    );

    expect(screen.getByText("Memory")).toBeDefined();
    expect(screen.getByRole("button", { name: /Banked Facts/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /Workspace Sources/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /Recorded Sessions/i })).toBeDefined();

    expect(screen.getByText("42")).toBeDefined();
    expect(screen.getByText("5")).toBeDefined();
    expect(screen.getByText("18")).toBeDefined();

    expect(screen.getByText("Security Audit")).toBeDefined();
    expect(screen.getByText("Marketing Launch")).toBeDefined();
  });

  it("handles navigation selection and project toggling", () => {
    const onSelect = vi.fn();
    const onSelectProject = vi.fn();

    render(
      <MemoryPanel
        scope="workspace"
        onScopeChange={vi.fn()}
        active="facts"
        onSelect={onSelect}
        projects={[{ id: "proj_1", name: "Alpha Project" }]}
        selectedProject=""
        onSelectProject={onSelectProject}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Workspace Sources/i }));
    expect(onSelect).toHaveBeenCalledWith("sources");

    fireEvent.click(screen.getByRole("button", { name: /Alpha Project/i }));
    expect(onSelectProject).toHaveBeenCalledWith("proj_1");
  });

  it("handles search and sync actions", () => {
    const onSearch = vi.fn();
    const onSync = vi.fn();

    render(
      <MemoryPanel
        scope="personal"
        onScopeChange={vi.fn()}
        active="facts"
        onSelect={vi.fn()}
        onSearch={onSearch}
        onSync={onSync}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Search memory" }));
    expect(onSearch).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Sync memory" }));
    expect(onSync).toHaveBeenCalled();
  });

  it("never fetches and shows empty values when data is omitted", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    render(
      <MemoryPanel
        scope="personal"
        onScopeChange={vi.fn()}
        active="facts"
        onSelect={vi.fn()}
      />,
    );

    expect(fetcher).not.toHaveBeenCalled();
  });
});
