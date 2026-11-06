// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TeamWorkspaceSummary } from "@shiba/shared";
import { readRoomLink, roomLinkUrl, useRoomLinkRoute } from "./room-links";

const actor = "member@example.test";
const workspaceId = `ws_${"a".repeat(24)}`;
const roomId = `room_${"b".repeat(24)}`;
const link = { workspaceId, roomId };
const workspace: TeamWorkspaceSummary = { workspaceId, name: "Team", version: 1, createdAt: 1,
  membership: { workspaceId, userId: actor, role: "member", version: 1, joinedAt: 1 } };
const directory = () => ({ verified: true, loading: false, error: null as string | null,
  selectedWorkspaceId: "", workspaces: [workspace], selectWorkspace: vi.fn() });
afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); });
function openLink() { window.history.replaceState(null, "", roomLinkUrl(link, window.location.origin)); }

describe("canonical workspace room links", () => {
  it("round trips a root conversation route without invite tokens or access grants", () => {
    const url = new URL(roomLinkUrl(link, "https://shiba.example/app/?invite=secret#invite=secret"));
    expect(url.pathname).toBe("/threads/");
    expect(url.hash).toBe("");
    expect([...url.searchParams.keys()]).toEqual(["workspace", "room"]);
    expect(readRoomLink(url.search)).toEqual(link);
    expect(() => roomLinkUrl({ ...link, workspaceId: "personal" }, url.origin)).toThrow();
  });
  it.each(["?room=x", `?workspace=${workspaceId}`, `?workspace=personal&room=${roomId}`,
    `?workspace=${workspaceId}&room=${roomId}&room=${roomId}`, `?workspace=${workspaceId}&room=../private`])("blocks malformed selectors rather than treating them as personal: %s", (search) => {
    expect(readRoomLink(search)).toBe("invalid");
  });
  it("ignores unrelated view parameters", () => expect(readRoomLink("?view=work")).toBeNull());
  it("blocks a loaded room when browser navigation selects malformed room selectors", () => {
    openLink();
    const value = { ...directory(), selectedWorkspaceId: workspaceId };
    const { result } = renderHook(() => useRoomLinkRoute(actor, value));
    expect(result.current.ready).toBe(true);
    expect(result.current.roomId).toBe(roomId);

    window.history.pushState(null, "", `/threads/?workspace=${workspaceId}&room=invalid`);
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));

    expect(result.current.ready).toBe(false);
    expect(result.current.roomId).toBeUndefined();
    expect(window.location.search).toBe(`?workspace=${workspaceId}&room=invalid`);
  });
  it("waits for verified membership before selecting, then waits for the selected workspace before exposing the room", async () => {
    openLink(); const initial = { ...directory(), verified: false, loading: true };
    const { result, rerender } = renderHook(({ value }) => useRoomLinkRoute(actor, value), { initialProps: { value: initial } });
    expect(result.current.ready).toBe(false);
    expect(result.current.roomId).toBeUndefined();
    expect(initial.selectWorkspace).not.toHaveBeenCalled();
    const verified = { ...initial, verified: true, loading: false };
    rerender({ value: verified });
    await waitFor(() => expect(initial.selectWorkspace).toHaveBeenCalledWith(workspaceId));
    expect(result.current.ready).toBe(false);
    rerender({ value: { ...verified, selectedWorkspaceId: workspaceId } });
    expect(result.current.ready).toBe(true);
    expect(result.current.roomId).toBe(roomId);
  });
  it.each(["missing", "other-actor", "error", "revoked"])("does not select or expose data for %s membership", (condition) => {
    openLink(); const value = directory();
    if (condition === "missing" || condition === "revoked") value.workspaces = [];
    if (condition === "other-actor") value.workspaces = [{ ...workspace, membership: { ...workspace.membership, userId: "other@example.test" } }];
    if (condition === "error") value.error = "Directory unavailable";
    if (condition === "revoked") value.selectedWorkspaceId = workspaceId;
    const { result } = renderHook(() => useRoomLinkRoute(actor, value));
    expect(result.current.ready).toBe(false);
    expect(result.current.roomId).toBeUndefined();
    expect(value.selectWorkspace).not.toHaveBeenCalled();
  });
  it("keeps an already verified room mounted during directory refresh but blocks a different actor", () => {
    openLink(); const value = { ...directory(), selectedWorkspaceId: workspaceId };
    const { result, rerender } = renderHook(({ actorId, value }) => useRoomLinkRoute(actorId, value), { initialProps: { actorId: actor, value } });
    rerender({ actorId: actor, value: { ...value, loading: true } });
    expect(result.current.ready).toBe(true);
    expect(result.current.roomId).toBe(roomId);
    rerender({ actorId: "other@example.test", value });
    expect(result.current.ready).toBe(false);
    expect(result.current.roomId).toBeUndefined();
  });
  it("offers explicit recovery rather than pending when a different remembered workspace was revoked", () => {
    openLink(); const value = { ...directory(), verified: false, selectedWorkspaceId: `ws_${"d".repeat(24)}`,
      error: "Access to the selected workspace was removed." };
    const { result } = renderHook(() => useRoomLinkRoute(actor, value));
    expect(result.current.ready).toBe(false);
    expect(result.current.pending).toBe(false);
    expect(result.current.roomId).toBeUndefined();
    expect(value.selectWorkspace).not.toHaveBeenCalled();
    act(() => result.current.clear());
    expect(window.location.search).toBe("");
    expect(result.current.roomId).toBeUndefined();
  });
  it("does not resurrect an old linked room after explicitly switching workspace and a popstate", () => {
    openLink(); const value = { ...directory(), selectedWorkspaceId: workspaceId };
    const { result, rerender } = renderHook(({ value }) => useRoomLinkRoute(actor, value), { initialProps: { value } });
    act(() => result.current.clear());
    const nextWorkspace = `ws_${"d".repeat(24)}`;
    rerender({ value: { ...value, selectedWorkspaceId: nextWorkspace } });
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(result.current.ready).toBe(true);
    expect(result.current.roomId).toBeUndefined();
    expect(window.location.search).toBe("");
    expect(value.selectWorkspace).not.toHaveBeenCalled();
  });
  it("rechecks membership after revocation and requires an explicit personal switch", () => {
    openLink(); const value = { ...directory(), selectedWorkspaceId: workspaceId };
    const { result, rerender } = renderHook(({ value }) => useRoomLinkRoute(actor, value), { initialProps: { value } });
    expect(result.current.ready).toBe(true);
    rerender({ value: { ...value, workspaces: [] } });
    expect(result.current.ready).toBe(false);
    act(() => result.current.clear());
    expect(result.current.ready).toBe(true);
    expect(window.location.search).toBe("");
  });
  it("handles same-view back/forward and explicit workspace switching", () => {
    openLink(); const value = { ...directory(), selectedWorkspaceId: workspaceId };
    const { result } = renderHook(() => useRoomLinkRoute(actor, value));
    const nextRoom = `room_${"c".repeat(24)}`;
    act(() => { window.history.replaceState(null, "", roomLinkUrl({ ...link, roomId: nextRoom }, window.location.origin)); window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(result.current.roomId).toBe(nextRoom);
    act(() => result.current.clear());
    expect(result.current.roomId).toBeUndefined();
    expect(window.location.search).toBe("");
  });
});
