import { useEffect, useRef, useState } from "react";
import type { TeamWorkItem } from "./team-work-items";
import { teamWorkspaceHeaders, teamWorkspaceRequest, TeamWorkspaceRequestError } from "./team-workspaces-client";

interface State { key: string; tasks: TeamWorkItem[]; loading: boolean; error: string | null; truncated: boolean }

/** Shared work is fetched independently from the user's private run registry. */
export function useTeamWorkItems(actorId: string | null, workspaceId: string, enabled: boolean) {
  const key = enabled && actorId && workspaceId ? JSON.stringify([actorId, workspaceId]) : "";
  const current = useRef(key); current.current = key;
  const [state, setState] = useState<State>({ key: "", tasks: [], loading: false, error: null, truncated: false });
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    let denied = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      if (current.current !== key || controller.signal.aborted) return;
      try {
        const body = await teamWorkspaceRequest<{ workspaceId: string; tasks: TeamWorkItem[]; truncated: boolean }>(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/work`,
          { signal: controller.signal, headers: teamWorkspaceHeaders(workspaceId) },
        );
        if (body.workspaceId !== workspaceId || !Array.isArray(body.tasks)) throw new Error("Invalid shared work response.");
        if (current.current === key && !controller.signal.aborted) setState({ key, tasks: body.tasks.filter(item => item.workspaceId === workspaceId), loading: false, error: null, truncated: body.truncated === true });
      } catch (error) {
        if (error instanceof TeamWorkspaceRequestError && [401, 403, 404].includes(error.status)) denied = true;
        if (current.current === key && !controller.signal.aborted) setState({ key, tasks: [], loading: false, error: error instanceof Error ? error.message : "Shared work is unavailable.", truncated: false });
      } finally {
        if (!denied && current.current === key && !controller.signal.aborted) timer = setTimeout(() => { void load(); }, 5000);
      }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [key, workspaceId]);
  return state.key === key && key ? state : { tasks: [], loading: Boolean(key), error: null, truncated: false };
}
