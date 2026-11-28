// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectsView } from "./ProjectsView";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const project = {
  id: "p1",
  workspaceId: "ws",
  name: "Release preparation",
  createdAt: 1,
  fileCount: 0,
  noteCount: 0,
};
const file = {
  id: "f1",
  workspaceId: "ws",
  scope: "personal",
  folderId: null,
  name: "brief.md",
  mime: "text/markdown",
  size: 10,
  sha256: "abc",
  projectId: null,
  version: 1,
  createdBy: "owner",
  createdAt: 1,
  updatedAt: 1,
  ingestion: { state: "done" },
};
const note = {
  id: "n1",
  workspaceId: "ws",
  scope: "personal",
  title: "Launch notes",
  projectId: null,
  version: 1,
  createdBy: "owner",
  createdAt: 1,
  updatedAt: 1,
  ingestion: { state: "done" },
};

function api(projects: Array<typeof project> = [project]) {
  const membershipCalls: Array<{ resourceKind: string; resourceId: string; assign: boolean }> = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/membership")) {
      membershipCalls.push(
        JSON.parse(String(init?.body)) as {
          resourceKind: string;
          resourceId: string;
          assign: boolean;
        },
      );
      return Response.json({ project, files: [{ ...file, projectId: project.id }], notes: [] });
    }
    if (url === "/api/projects") return Response.json({ projects });
    if (url.startsWith("/api/projects/")) return Response.json({ project, files: [], notes: [] });
    if (url.startsWith("/api/files"))
      return Response.json({ files: url.includes("personal") ? [file] : [] });
    if (url.startsWith("/api/notes"))
      return Response.json({ notes: url.includes("personal") ? [note] : [] });
    return Response.json({ error: "Not found." }, { status: 404 });
  });
  vi.stubGlobal("fetch", mock);
  return { mock, membershipCalls };
}

describe("ProjectsView", () => {
  it("explains the empty state only after the list has loaded", async () => {
    api([]);
    render(<ProjectsView />);
    expect(screen.queryByText("No projects yet")).toBeNull();
    expect(await screen.findByText("No projects yet")).toBeTruthy();
  });

  it("lists projects and their counts without the empty state", async () => {
    api();
    render(<ProjectsView />);
    expect(await screen.findByText("Release preparation")).toBeTruthy();
    expect(await screen.findByLabelText("Project detail")).toBeTruthy();
    expect(screen.queryByText("No projects yet")).toBeNull();
  });

  it("adds an available file to the selected project", async () => {
    const { membershipCalls } = api();
    render(<ProjectsView />);
    fireEvent.change(await screen.findByLabelText("Choose file to add"), {
      target: { value: "f1" },
    });
    const addFile = screen.getAllByRole("button", { name: "Add" }).at(0);
    expect(addFile).toBeTruthy();
    fireEvent.click(addFile as HTMLElement);
    await waitFor(() =>
      expect(membershipCalls).toEqual([{ resourceKind: "file", resourceId: "f1", assign: true }]),
    );
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
