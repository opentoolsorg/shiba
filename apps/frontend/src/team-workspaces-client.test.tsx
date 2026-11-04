// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TeamWorkspaceSummary } from "@shiba/shared";
import {
  teamWorkspaceHeaders,
  teamWorkspaceInvitationUrl,
  teamWorkspaceRequest,
  useTeamWorkspaceDirectory,
} from "./team-workspaces-client";

const id = `ws_${"a".repeat(24)}`;
const workspace = (userId = "a@example.com"): TeamWorkspaceSummary => ({
  workspaceId: id,
  name: "Team A",
  version: 1,
  createdAt: 1,
  membership: { workspaceId: id, userId, role: "owner", version: 1, joinedAt: 1 },
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("team workspace client", () => {
  it("places the invitation secret only in the URL fragment", () => {
    const url = new URL(
      teamWorkspaceInvitationUrl("raw+token/with?query", "https://shiba.example"),
    );
    expect(url.pathname).toBe("/app/");
    expect(url.search).toBe("?view=team&invite=1");
    expect(decodeURIComponent(url.hash.slice("#invite=".length))).toBe("raw+token/with?query");
    expect(teamWorkspaceHeaders()).toEqual({});
    expect(teamWorkspaceHeaders(id)).toEqual({ "X-Shiba-Workspace": id });
  });
  it("preserves a server refusal without logging or persisting its body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: "Member change denied, stale, or would remove the last owner." },
          { status: 409 },
        ),
      ),
    );
    await expect(teamWorkspaceRequest("/api/workspaces")).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("last owner"),
    });
    expect(localStorage.length).toBe(0);
  });
  it("selects only server-listed memberships and restores selection for that actor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ workspaces: [workspace()] })),
    );
    const first = renderHook(() =>
      useTeamWorkspaceDirectory({ actorId: "a@example.com", enabled: true }),
    );
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    act(() => first.result.current.selectWorkspace("ws_unknown"));
    expect(first.result.current.selectedWorkspaceId).toBe("");
    act(() => first.result.current.selectWorkspace(id));
    expect(first.result.current.selectedWorkspaceId).toBe(id);
    first.unmount();
    const second = renderHook(() =>
      useTeamWorkspaceDirectory({ actorId: "a@example.com", enabled: true }),
    );
    await waitFor(() => expect(second.result.current.selectedWorkspaceId).toBe(id));
  });
  it("synchronously hides old actor data and ignores an old late response", async () => {
    let resolveOld!: (response: Response) => void;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce(Response.json({ workspaces: [] }));
    vi.stubGlobal("fetch", fetcher);
    const hook = renderHook(
      ({ actorId }) => useTeamWorkspaceDirectory({ actorId, enabled: true }),
      { initialProps: { actorId: "a@example.com" } },
    );
    hook.rerender({ actorId: "b@example.com" });
    expect(hook.result.current.workspaces).toEqual([]);
    expect(hook.result.current.selectedWorkspaceId).toBe("");
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    await act(async () => {
      resolveOld(Response.json({ workspaces: [workspace()] }));
    });
    expect(hook.result.current.workspaces).toEqual([]);
    const oldSignal = fetcher.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(oldSignal.aborted).toBe(true);
  });
  it("clears a revoked selection and never lends it to another actor", async () => {
    let items = [workspace()];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ workspaces: items })),
    );
    const hook = renderHook(
      ({ actorId }) => useTeamWorkspaceDirectory({ actorId, enabled: true }),
      { initialProps: { actorId: "a@example.com" } },
    );
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    act(() => hook.result.current.selectWorkspace(id));
    items = [];
    await act(async () => hook.result.current.refresh());
    expect(hook.result.current.selectedWorkspaceId).toBe(id);
    expect(hook.result.current.error).toContain("removed");
    act(() => hook.result.current.selectWorkspace(""));
    expect(hook.result.current.selectedWorkspaceId).toBe("");
    expect(hook.result.current.error).toBeNull();
    hook.rerender({ actorId: "b@example.com" });
    expect(hook.result.current.selectedWorkspaceId).toBe("");
  });
  it("hides all data when disabled and reports failed refreshes without cached authority", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ workspaces: [workspace()] }))
      .mockResolvedValueOnce(Response.json({ error: "Session expired" }, { status: 401 }));
    vi.stubGlobal("fetch", fetcher);
    const hook = renderHook(
      ({ enabled }) => useTeamWorkspaceDirectory({ actorId: "a@example.com", enabled }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(hook.result.current.workspaces).toHaveLength(1));
    await act(async () => hook.result.current.refresh());
    expect(hook.result.current.workspaces).toEqual([]);
    expect(hook.result.current.error).toBe("Session expired");
    hook.rerender({ enabled: false });
    expect(hook.result.current.workspaces).toEqual([]);
    expect(hook.result.current.error).toBeNull();
  });
});
