import { useEffect, useRef, useState } from "react";
import type { WorkspaceEvent, WorkspaceTaskPatch } from "@shiba/shared";
import { useWorkspaceEvents } from "./state/workspace-events";
import type { TeamWorkItem } from "./team-work-items";
import { teamWorkspaceHeaders, teamWorkspaceRequest, TeamWorkspaceRequestError } from "./team-workspaces-client";

interface State { key: string; tasks: TeamWorkItem[]; loading: boolean; error: string | null; truncated: boolean }

function taskPatch(event: WorkspaceEvent, workspaceId: string): WorkspaceTaskPatch | null {
  if (event.workspaceId !== workspaceId || !["task.created", "task.updated"].includes(event.kind)) return null;
  const patch = event.payload?.task as WorkspaceTaskPatch | undefined;
  if (!patch || patch.id !== event.entityId || patch.workspaceId !== workspaceId || typeof patch.title !== "string" ||
    !["backlog", "todo", "in-progress", "in-review", "done", "cancelled"].includes(patch.status) ||
    !Number.isFinite(patch.updatedAt) || !Number.isSafeInteger(patch.version)) return null;
  return patch;
}

/** Merge board metadata without replacing already-fetched task details. */
function patchTeamWorkItems(items: TeamWorkItem[], patch: WorkspaceTaskPatch): TeamWorkItem[] {
  const previous = items.find((item) => item.id === patch.id);
  if (previous && previous.updatedAt > patch.updatedAt) return items;
  if (patch.archived) return items.filter((item) => item.id !== patch.id);
  const next: TeamWorkItem = {
    ...previous, id: patch.id, workspaceId: patch.workspaceId, roomId: previous?.roomId ?? "", roomTitle: previous?.roomTitle ?? "",
    title: patch.title, status: patch.status, priority: patch.priority, blocked: patch.blocked,
    archived: patch.archived, updatedAt: patch.updatedAt,
    ownerId: patch.ownerId ?? undefined, reviewerId: patch.reviewerId ?? undefined,
    startDate: patch.startDate ?? undefined, endDate: patch.endDate ?? undefined, parentId: patch.parentId ?? undefined,
    assigneeActorId: patch.ownerId ?? undefined,
    assigneeKind: patch.ownerId?.startsWith("agent:") ? "agent" : "human",
    assigneeUserId: patch.ownerId?.startsWith("human:") ? patch.ownerId.slice(6) : undefined,
    viewerCanApprove: false,
  };
  return [...items.filter((item) => item.id !== patch.id), next].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

/** Shared work is fetched independently from the user's private run registry. */
export function useTeamWorkItems(
  actorId: string | null,
  workspaceId: string,
  enabled: boolean,
  liveEventsConnected = false,
) {
  const key = enabled && actorId && workspaceId ? JSON.stringify([actorId, workspaceId]) : "";
  const current = useRef(key); current.current = key;
  const [state, setState] = useState<State>({ key: "", tasks: [], loading: false, error: null, truncated: false });
  const loadRef = useRef<() => Promise<void>>(async () => {});
  const accessDenied = useRef(false);
  const buffered = useRef({ key, patches: new Map<string, WorkspaceTaskPatch>() });
  if (buffered.current.key !== key) { buffered.current = { key, patches: new Map() }; accessDenied.current = false; }
  const connected = useWorkspaceEvents({
    workspaceId, enabled: Boolean(key),
    onReconnect: () => { void loadRef.current(); },
    onEvent: (event) => {
      const patch = taskPatch(event, workspaceId);
      if (!key || !patch || accessDenied.current) return;
      const previous = buffered.current.patches.get(patch.id);
      if (previous && previous.version >= patch.version) return;
      buffered.current.patches.set(patch.id, patch);
      setState((state) => state.key !== key ? state : { ...state, tasks: patchTeamWorkItems(state.tasks, patch) });
    },
  });
  const live = useRef(connected || liveEventsConnected); live.current = connected || liveEventsConnected;
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    let denied = false;
    let timer: ReturnType<typeof setTimeout>;
    let generation = 0;
    let lastLoadAt = 0;
    const load = async () => {
      if (denied || current.current !== key || controller.signal.aborted) return;
      clearTimeout(timer);
      const requestGeneration = ++generation;
      lastLoadAt = Date.now();
      try {
        const body = await teamWorkspaceRequest<{ workspaceId: string; tasks: TeamWorkItem[]; truncated: boolean }>(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/work`,
          { signal: controller.signal, headers: teamWorkspaceHeaders(workspaceId) },
        );
        if (body.workspaceId !== workspaceId || !Array.isArray(body.tasks)) throw new Error("Invalid shared work response.");
        if (current.current === key && !controller.signal.aborted && requestGeneration === generation) {
          let tasks = body.tasks.filter(item => item.workspaceId === workspaceId);
          for (const patch of buffered.current.patches.values()) tasks = patchTeamWorkItems(tasks, patch);
          setState({ key, tasks, loading: false, error: null, truncated: body.truncated === true });
        }
      } catch (error) {
        if (requestGeneration === generation && error instanceof TeamWorkspaceRequestError && [401, 403, 404].includes(error.status)) {
          denied = true; accessDenied.current = true;
        }
        if (current.current === key && !controller.signal.aborted && requestGeneration === generation) setState({ key, tasks: [], loading: false, error: error instanceof Error ? error.message : "Shared work is unavailable.", truncated: false });
      } finally {
        if (!denied && current.current === key && !controller.signal.aborted && requestGeneration === generation) {
          timer = setTimeout(poll, 5000);
        }
      }
    };
    const poll = () => {
      if (live.current && Date.now() - lastLoadAt < 120_000) timer = setTimeout(poll, 5000);
      else void load();
    };
    loadRef.current = load;
    void load();
    return () => { controller.abort(); clearTimeout(timer); loadRef.current = async () => {}; };
  }, [key, workspaceId]);
  return state.key === key && key ? state : { tasks: [], loading: Boolean(key), error: null, truncated: false };
}
