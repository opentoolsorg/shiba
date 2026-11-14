/** Writable Work API. useWorkTasks(actorId, workspaceId, enabled) -> { tasks, loading, error, truncated,
 *  create(title, patch?), update(id, patch), archive(id), comment(id, text), dismissError() }.
 *  Each mutation applies optimistically and resolves to the server task, or null on failure (rolled back, `error` set).
 *  Endpoints: POST /api/workspaces/:id/work {title, ...patch}; PATCH .../work/:taskId {patch};
 *  POST .../:taskId/archive; POST .../:taskId/comments {text}. All respond {task}.
 *  `tasks` merges server rows with local changes and excludes archived rows. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTeamWorkItems } from "./team-work-client";
import type { TeamWorkItem } from "./team-work-items";
import { teamWorkspaceHeaders, teamWorkspaceRequest } from "./team-workspaces-client";

export type WorkTaskPatch = Partial<
  Pick<
    TeamWorkItem,
    | "title"
    | "status"
    | "ownerId"
    | "reviewerId"
    | "priority"
    | "startDate"
    | "endDate"
    | "parentId"
    | "blocked"
    | "objective"
    | "waitingOn"
    | "context"
    | "doneWhen"
  >
>;

const base = (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/work`;
const send = async (workspaceId: string, path: string, method: string, body: unknown) => {
  const { task } = await teamWorkspaceRequest<{ task: TeamWorkItem }>(
    `${base(workspaceId)}${path}`,
    {
      method,
      headers: teamWorkspaceHeaders(workspaceId),
      body: JSON.stringify(body),
    },
  );
  if (!task || task.workspaceId !== workspaceId) throw new Error("Invalid work response.");
  return task;
};
export const createTaskRequest = (ws: string, title: string, patch: WorkTaskPatch = {}) =>
  send(ws, "", "POST", { title, ...patch });
export const updateTaskRequest = (ws: string, id: string, patch: WorkTaskPatch) =>
  send(ws, `/${encodeURIComponent(id)}`, "PATCH", { patch });
export const archiveTaskRequest = (ws: string, id: string) =>
  send(ws, `/${encodeURIComponent(id)}/archive`, "POST", {});
export const addCommentRequest = (ws: string, id: string, text: string) =>
  send(ws, `/${encodeURIComponent(id)}/comments`, "POST", { text });

export function useWorkTasks(actorId: string | null, workspaceId: string, enabled: boolean) {
  const polled = useTeamWorkItems(actorId, workspaceId, enabled);
  const [optimistic, setOptimistic] = useState<{ scope: string; items: Record<string, TeamWorkItem> }>({
    scope: "",
    items: {},
  });
  const [mutationError, setMutationError] = useState<string | null>(null);
  const scope = `${actorId}|${workspaceId}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const items = optimistic.scope === scope ? optimistic.items : {};
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // In-flight ids keep their optimistic row even if an older poll lands meanwhile.
  const inFlight = useRef(new Map<string, number>());
  const seq = useRef(0);

  const put = useCallback(
    (task: TeamWorkItem | null, id: string) =>
      setOptimistic((prev) => {
        const next = { ...(prev.scope === scopeRef.current ? prev.items : {}) };
        if (task) next[id] = task;
        else delete next[id];
        return { scope: scopeRef.current, items: next };
      }),
    [],
  );

  // Drop confirmed optimistic rows once polling has caught up with them.
  useEffect(() => {
    const caughtUp = Object.values(items).filter(
      (o) =>
        !inFlight.current.has(o.id) &&
        polled.tasks.some((p) => p.id === o.id && p.updatedAt >= o.updatedAt),
    );
    if (caughtUp.length)
      setOptimistic((prev) => {
        const next = { ...prev.items };
        for (const o of caughtUp) delete next[o.id];
        return { scope: prev.scope, items: next };
      });
  }, [polled.tasks, items]);

  const merged = useMemo(() => {
    const byId = new Map(polled.tasks.map((t) => [t.id, t]));
    for (const o of Object.values(items)) byId.set(o.id, { ...byId.get(o.id), ...o });
    return [...byId.values()].filter((t) => !t.archived);
  }, [polled.tasks, items]);
  const mergedRef = useRef(merged);
  mergedRef.current = merged;

  const run = useCallback(
    async (
      id: string,
      optimistic: ((current: TeamWorkItem) => TeamWorkItem) | TeamWorkItem,
      call: () => Promise<TeamWorkItem>,
    ) => {
      const before = itemsRef.current[id];
      const current = mergedRef.current.find((t) => t.id === id);
      const myScope = scopeRef.current;
      const track = (delta: number) => {
        const n = (inFlight.current.get(id) ?? 0) + delta;
        if (n > 0) inFlight.current.set(id, n);
        else inFlight.current.delete(id);
      };
      setMutationError(null);
      if (typeof optimistic !== "function") put(optimistic, id);
      else if (current) put(optimistic(current), id);
      track(1);
      try {
        const task = await call();
        if (scopeRef.current === myScope) put(task, id);
        return task;
      } catch (error) {
        if (scopeRef.current === myScope) {
          put(before ?? null, id);
          setMutationError(error instanceof Error ? error.message : "Could not save the change.");
        }
        return null;
      } finally {
        track(-1);
      }
    },
    [put],
  );

  const create = useCallback(
    async (title: string, patch: WorkTaskPatch = {}) => {
      const id = `pending-${++seq.current}`;
      const draft: TeamWorkItem = {
        id,
        workspaceId,
        roomId: "",
        roomTitle: "",
        title,
        assigneeKind: "human",
        status: "queued",
        updatedAt: Date.now(),
        ...patch,
      };
      const task = await run(id, draft, () => createTaskRequest(workspaceId, title, patch));
      if (task) {
        put(null, id);
        put(task, task.id);
      }
      return task;
    },
    [workspaceId, run, put],
  );
  const update = useCallback(
    (id: string, patch: WorkTaskPatch) =>
      run(
        id,
        (t) => ({ ...t, ...patch }),
        () => updateTaskRequest(workspaceId, id, patch),
      ),
    [workspaceId, run],
  );
  const archive = useCallback(
    (id: string) =>
      run(
        id,
        (t) => ({ ...t, archived: true }),
        () => archiveTaskRequest(workspaceId, id),
      ),
    [workspaceId, run],
  );
  const comment = useCallback(
    (id: string, text: string) =>
      run(
        id,
        (t) => ({
          ...t,
          activity: [
            ...(t.activity ?? []),
            {
              id: `pending-${++seq.current}`,
              at: Date.now(),
              actorId: actorId ?? undefined,
              kind: "comment",
              text,
            },
          ],
        }),
        () => addCommentRequest(workspaceId, id, text),
      ),
    [workspaceId, actorId, run],
  );
  const dismissError = useCallback(() => setMutationError(null), []);

  return {
    tasks: merged,
    loading: polled.loading,
    truncated: polled.truncated,
    error: mutationError ?? polled.error,
    dismissError,
    create,
    update,
    archive,
    comment,
  };
}
