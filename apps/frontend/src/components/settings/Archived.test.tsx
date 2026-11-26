// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArchivedSettings } from "./Archived";

const workspaceId = `ws_${"a".repeat(24)}`;
const task = { resourceKind: "task", resourceId: "t1", title: "Old task", archivedAt: 1, restoreSupported: true };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ArchivedSettings", () => {
  it("lists archived resources under Resource and Action headers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ items: [task] })));
    render(<ArchivedSettings workspaceId={workspaceId} />);
    await waitFor(() => {
      expect(screen.getByText("Old task")).toBeTruthy();
    });
    expect(screen.getByText("Resource")).toBeTruthy();
    expect(screen.getByText("Action")).toBeTruthy();
  });

  it("keeps the row and offers a retry when a restore fails", async () => {
    let archived = true;
    let restores = 0;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        restores += 1;
        if (restores === 1) return new Response("{}", { status: 500 });
        archived = false;
        return Response.json({});
      }
      return Response.json({ items: archived ? [task] : [] });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<ArchivedSettings workspaceId={workspaceId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Restore failed");
    expect(screen.getByText("Old task")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText("Old task")).toBeNull());
    expect(restores).toBe(2);
    expect(screen.getByText(/Nothing archived yet/)).toBeTruthy();
  });

  it("asks for a team workspace when none is selected", () => {
    render(<ArchivedSettings />);
    expect(screen.getByText("Select a team workspace to view archived resources.")).toBeTruthy();
  });
});
