// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectsView } from "./ProjectsView";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function api(projects: Array<{ id: string; name: string }>) {
  const mock = vi.fn(async () => Response.json({ projects }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("ProjectsView", () => {
  it("explains the empty state only after the list has loaded", async () => {
    api([]);
    render(<ProjectsView />);
    expect(screen.queryByText("No projects yet")).toBeNull();
    expect(await screen.findByText("No projects yet")).toBeTruthy();
  });

  it("lists projects without the empty state", async () => {
    api([{ id: "p1", name: "Release preparation" }]);
    render(<ProjectsView />);
    expect(await screen.findByText("Release preparation")).toBeTruthy();
    expect(screen.queryByText("No projects yet")).toBeNull();
  });

  it("links to files and notes only when navigation is wired", async () => {
    api([]);
    const onNavigate = vi.fn();
    const { unmount } = render(<ProjectsView />);
    await screen.findByText("No projects yet");
    expect(screen.queryByRole("button", { name: "Browse files" })).toBeNull();
    unmount();

    render(<ProjectsView onNavigate={onNavigate} />);
    fireEvent.click(await screen.findByRole("button", { name: "Browse files" }));
    fireEvent.click(screen.getByRole("button", { name: "Open notes" }));
    expect(onNavigate.mock.calls).toEqual([["files"], ["notes"]]);
  });
});
