import { useCallback, useEffect, useRef, useState } from "react";
import { isTeamWorkspaceId, type TeamWorkspaceSummary } from "@shiba/shared";

/** An explicit selector, never an authority claim. Every route rechecks membership. */
export function teamWorkspaceHeaders(workspaceId?: string): Record<string, string> {
  return workspaceId ? { "X-Shiba-Workspace": workspaceId } : {};
}

export class TeamWorkspaceRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export async function teamWorkspaceRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers,
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: unknown };
  if (!response.ok)
    throw new TeamWorkspaceRequestError(
      typeof body.error === "string"
        ? body.error
        : `Workspace request failed (${response.status}).`,
      response.status,
    );
  return body;
}

/** Tokens stay in the fragment so neither the request URL nor its referrer contains them. */
export function teamWorkspaceInvitationUrl(token: string, origin: string): string {
  const url = new URL("/app/?view=team&invite=1", origin);
  url.hash = `invite=${encodeURIComponent(token)}`;
  return url.toString();
}

const selectionKey = (actorId: string) => `shiba:team-workspace:${encodeURIComponent(actorId)}`;
function remembered(actorId: string): string {
  try {
    const id = localStorage.getItem(selectionKey(actorId));
    return isTeamWorkspaceId(id) ? id : "";
  } catch {
    return "";
  }
}
function remember(actorId: string, id: string): void {
  try {
    if (id) localStorage.setItem(selectionKey(actorId), id);
    else localStorage.removeItem(selectionKey(actorId));
  } catch {
    /* Storage is optional. */
  }
}
const lastKey = (actorId: string) => `shiba:last-team-workspace:${encodeURIComponent(actorId)}`;
/** The last non-empty team workspace, which survives switching to the personal workspace. */
export function lastTeamWorkspace(actorId: string): string {
  try {
    const id = localStorage.getItem(lastKey(actorId));
    return isTeamWorkspaceId(id) ? id : "";
  } catch {
    return "";
  }
}
export function rememberLastTeamWorkspace(actorId: string, id: string): void {
  try {
    if (id) localStorage.setItem(lastKey(actorId), id);
  } catch {
    /* Storage is optional. */
  }
}
interface DirectoryState {
  verified: boolean;
  scope: string;
  workspaces: TeamWorkspaceSummary[];
  selectedWorkspaceId: string;
  loading: boolean;
  error: string | null;
}

export function useTeamWorkspaceDirectory({
  actorId,
  enabled,
}: {
  actorId: string | null;
  enabled: boolean;
}) {
  const scope = enabled && actorId ? actorId.trim().toLowerCase() : "";
  const current = useRef(scope);
  current.current = scope;
  const epoch = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const [state, setState] = useState<DirectoryState>({
    verified: false,
    scope: "",
    workspaces: [],
    selectedWorkspaceId: "",
    loading: false,
    error: null,
  });

  const refresh = useCallback(async () => {
    if (!scope || current.current !== scope) return;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const requestEpoch = ++epoch.current;
    const active = () =>
      !request.signal.aborted && current.current === scope && epoch.current === requestEpoch;
    // Hide old authority until the current membership has been checked again.
    setState((previous) => ({
      verified: previous.scope === scope && previous.verified && !previous.error,
      scope,
      workspaces: previous.scope === scope ? previous.workspaces : [],
      selectedWorkspaceId:
        previous.scope === scope ? previous.selectedWorkspaceId : remembered(scope),
      loading: true,
      error: null,
    }));
    try {
      const body = await teamWorkspaceRequest<{ workspaces: TeamWorkspaceSummary[] }>(
        "/api/workspaces",
        { signal: request.signal },
      );
      if (!active()) return;
      if (!Array.isArray(body.workspaces)) throw new Error("Invalid workspace directory response.");
      const workspaces = body.workspaces.filter(
        (item) =>
          isTeamWorkspaceId(item.workspaceId) &&
          item.membership?.workspaceId === item.workspaceId &&
          item.membership.userId === scope,
      );
      setState((previous) => {
        const selected =
          previous.scope === scope ? previous.selectedWorkspaceId : remembered(scope);
        const unavailable = Boolean(selected && !workspaces.some((item) => item.workspaceId === selected));
        return { verified: !unavailable, scope, workspaces, selectedWorkspaceId: selected, loading: false,
          error: unavailable ? "Access to the selected workspace was removed. Choose another workspace or explicitly open your personal workspace." : null };
      });
    } catch (cause) {
      if (active())
        setState((previous) => ({
          verified: false,
          scope,
          workspaces: [],
          selectedWorkspaceId: previous.scope === scope ? previous.selectedWorkspaceId : remembered(scope),
          loading: false,
          error: cause instanceof Error ? cause.message : "Workspace directory unavailable.",
        }));
    }
  }, [scope]);

  useEffect(() => {
    if (scope) void refresh();
    const onFocus = () => { if (scope) void refresh(); };
    window.addEventListener("focus", onFocus);
    const timer = scope ? window.setInterval(onFocus, 30_000) : undefined;
    return () => {
      controller.current?.abort();
      epoch.current++;
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [scope, refresh]);

  const selectWorkspace = useCallback(
    (id: string) => {
      if (!scope || current.current !== scope) return;
      setState((previous) => {
        if (
          previous.scope !== scope ||
          previous.loading ||
          (id && !previous.workspaces.some((item) => item.workspaceId === id))
        )
          return previous;
        remember(scope, id);
        return { ...previous, verified: true, selectedWorkspaceId: id, error: null };
      });
    },
    [scope],
  );
  const visible =
    state.scope === scope && scope
      ? state
      : { verified: false, workspaces: [], selectedWorkspaceId: "", loading: Boolean(scope), error: null };
  return {
    workspaces: visible.workspaces,
    selectedWorkspaceId: visible.selectedWorkspaceId,
    selectWorkspace,
    refresh,
    loading: visible.loading,
    verified: visible.verified,
    error: visible.error,
  };
}
