import { useCallback, useEffect, useState } from "react";
import { isTeamWorkspaceId, type TeamWorkspaceSummary } from "@shiba/shared";

export interface RoomLink { workspaceId: string; roomId: string }
export type RoomLinkIntent = RoomLink | "invalid" | null;
const isRoomId = (value: string): boolean => /^room_[a-f0-9]{24}$/.test(value);

export function readRoomLink(search: string): RoomLinkIntent {
  const params = new URLSearchParams(search);
  if (!params.has("room") && !params.has("workspace")) return null;
  const workspaceId = params.get("workspace");
  const roomId = params.get("room") ?? "";
  if (params.getAll("workspace").length !== 1 || params.getAll("room").length !== 1 ||
    !isTeamWorkspaceId(workspaceId) || !isRoomId(roomId)) return "invalid";
  return { workspaceId, roomId };
}

export function roomLinkUrl(link: RoomLink, origin: string): string {
  if (!isTeamWorkspaceId(link.workspaceId) || !isRoomId(link.roomId)) throw new Error("Invalid room link.");
  const url = new URL("/threads/", origin);
  url.search = new URLSearchParams({ workspace: link.workspaceId, room: link.roomId }).toString();
  return url.toString();
}

interface Directory {
  verified: boolean;
  loading: boolean;
  error: string | null;
  selectedWorkspaceId: string;
  workspaces: TeamWorkspaceSummary[];
  selectWorkspace: (id: string) => void;
}

/** URL selectors never establish membership; even a verified selection still needs a room read. */
export function useRoomLinkRoute(actorId: string | null, directory: Directory) {
  const [intent, setIntent] = useState<RoomLinkIntent>(() =>
    typeof window === "undefined" ? null : readRoomLink(window.location.search));
  useEffect(() => {
    const onPop = () => setIntent(readRoomLink(window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const target = intent && intent !== "invalid" ? intent : null;
  const membership = Boolean(target && actorId && directory.verified && !directory.error &&
    directory.workspaces.some((workspace) => workspace.workspaceId === target.workspaceId &&
      workspace.membership.workspaceId === target.workspaceId && workspace.membership.userId === actorId));
  const ready = !intent || Boolean(membership && directory.selectedWorkspaceId === target?.workspaceId);
  useEffect(() => {
    if (membership && !directory.loading && target && directory.selectedWorkspaceId !== target.workspaceId) directory.selectWorkspace(target.workspaceId);
  }, [membership, target, directory.loading, directory.selectedWorkspaceId, directory.selectWorkspace]);
  const clear = useCallback(() => {
    setIntent(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("room");
    url.searchParams.delete("workspace");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, []);
  const onRoomChange = useCallback((roomId: string) => {
    if (!actorId || !directory.verified || directory.loading || directory.error || !isRoomId(roomId) ||
      !directory.workspaces.some((workspace) => workspace.workspaceId === directory.selectedWorkspaceId && workspace.membership.workspaceId === directory.selectedWorkspaceId && workspace.membership.userId === actorId)) return;
    const link = { workspaceId: directory.selectedWorkspaceId, roomId };
    setIntent((current) => current && current !== "invalid" && current.workspaceId === link.workspaceId && current.roomId === roomId ? current : link);
    const url = new URL(roomLinkUrl(link, window.location.origin));
    if (window.location.pathname + window.location.search !== url.pathname + url.search)
      window.history.replaceState(window.history.state, "", url.pathname + url.search);
  }, [actorId, directory.verified, directory.loading, directory.error, directory.workspaces, directory.selectedWorkspaceId]);
  return { ready, pending: Boolean(intent && !ready && directory.loading), roomId: ready ? target?.roomId : undefined, clear, onRoomChange };
}
