// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminSettings } from "./Admin";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const route = (workspaces: unknown[], tables: unknown[]) => async (input: RequestInfo | URL) =>
  String(input).endsWith("/workspaces") ? Response.json({ workspaces }) : Response.json({ tables });

describe("AdminSettings", () => {
  it("shows workspaces and table sizes under column headers with a team link", async () => {
    vi.stubGlobal("fetch", vi.fn(route(
      [{ workspaceId: "ws_1", name: "Acme", memberCount: 3, lastActivity: null }],
      [{ table: "tasks", rows: 12 }],
    )));
    const onOpenTeam = vi.fn();
    render(<AdminSettings onOpenTeam={onOpenTeam} />);
    expect(await screen.findByText("Acme")).toBeTruthy();
    expect(screen.getByText("3 members")).toBeTruthy();
    expect(screen.getByText("tasks")).toBeTruthy();
    for (const header of ["Name", "Members", "Table", "Rows"]) expect(screen.getByText(header)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Manage team →" }));
    expect(onOpenTeam).toHaveBeenCalledOnce();
  });

  it("says nothing was reported instead of showing zero rows when lists are empty", async () => {
    vi.stubGlobal("fetch", vi.fn(route([], [])));
    render(<AdminSettings />);
    expect(await screen.findByText("No workspaces reported.")).toBeTruthy();
    expect(screen.getByText("No tables reported.")).toBeTruthy();
  });

  it("explains that admin access is required and offers a retry when unauthorized", async () => {
    const fetcher = vi.fn(async () => Response.json({ error: "Forbidden" }, { status: 403 }));
    vi.stubGlobal("fetch", fetcher);
    render(<AdminSettings />);
    expect((await screen.findByRole("alert")).textContent).toContain("Administrator access is required");
    expect(screen.queryByText("No workspaces reported.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
  });
});
