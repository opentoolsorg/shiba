// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTeamWorkItems } from "./team-work-client";
import type { WorkspaceEvent, WorkspaceTaskPatch } from "@shiba/shared";
import type { UseWorkspaceEventsOptions } from "./state/workspace-events";
const live = vi.hoisted(() => ({ options: null as UseWorkspaceEventsOptions | null, connected: false }));
vi.mock("./state/workspace-events", () => ({ useWorkspaceEvents: (options: UseWorkspaceEventsOptions) => {
  live.options = options; return live.connected;
} }));
const patch = (fields: Partial<WorkspaceTaskPatch> = {}): WorkspaceTaskPatch => ({
  id: "task", workspaceId: a, title: "Team work", status: "todo", priority: "medium", ownerId: null,
  reviewerId: null, startDate: null, endDate: null, parentId: null, blocked: false, archived: false,
  updatedAt: 1, version: 2, ...fields,
});
const event = (task: WorkspaceTaskPatch, kind = "task.updated"): WorkspaceEvent => ({
  id: `event_${task.id}`, workspaceId: task.workspaceId, entityId: task.id, at: task.updatedAt, kind, payload: { task },
});

const a = `ws_${"a".repeat(24)}`, b = `ws_${"b".repeat(24)}`;
const task = (workspaceId: string) => ({ workspaceId, id: "task", roomId: "room", roomTitle: "Shared room", title: "Team work", assigneeKind: "human", status: "queued", updatedAt: 1 });
afterEach(() => { live.options = null; live.connected = false; cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("uses an explicit scope and never displays a stale workspace response", async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }))
    .mockResolvedValueOnce(Response.json({ workspaceId: b, tasks: [task(b), task(a)], truncated: true }));
  vi.stubGlobal("fetch", fetcher);
  const hook = renderHook(({ workspaceId }) => useTeamWorkItems("owner@example.com", workspaceId, true), { initialProps: { workspaceId: a } });
  hook.rerender({ workspaceId: b });
  expect(hook.result.current.tasks).toEqual([]);
  await waitFor(() => expect(hook.result.current.tasks).toHaveLength(1));
  await act(async () => { finish(Response.json({ workspaceId: a, tasks: [task(a)] })); });
  expect(hook.result.current.tasks[0]?.workspaceId).toBe(b);
  expect(hook.result.current.truncated).toBe(true);
  expect(new Headers(fetcher.mock.calls[1]?.[1].headers).get("X-Shiba-Workspace")).toBe(b);
});

it("clears rows immediately when the authenticated actor changes", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ workspaceId: a, tasks: [task(a)] }))
    .mockImplementationOnce(() => new Promise(() => {}));
  vi.stubGlobal("fetch", fetcher);
  const hook = renderHook(({ actorId }) => useTeamWorkItems(actorId, a, true), { initialProps: { actorId: "first@example.com" } });
  await waitFor(() => expect(hook.result.current.tasks).toHaveLength(1));
  hook.rerender({ actorId: "second@example.com" });
  expect(hook.result.current.tasks).toEqual([]);
  expect(hook.result.current.loading).toBe(true);
});

it("clears retained data and stops polling after access is revoked", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ workspaceId: a, tasks: [task(a)] }))
    .mockResolvedValue(Response.json({ error: "Workspace access removed." }, { status: 404 }));
  vi.stubGlobal("fetch", fetcher);
  const hook = renderHook(() => useTeamWorkItems("owner@example.com", a, true));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(hook.result.current.tasks).toHaveLength(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(hook.result.current.tasks).toEqual([]);
  expect(hook.result.current.error).toContain("removed");
  act(() => live.options?.onEvent(event(patch({ status: "done", updatedAt: 2 }))));
  await act(async () => { live.options?.onReconnect?.(); });
  expect(hook.result.current.tasks).toEqual([]);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("does not fetch private runs when no team workspace is selected", () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const hook = renderHook(() => useTeamWorkItems("owner@example.com", "", true));
  expect(fetcher).not.toHaveBeenCalled();
  expect(hook.result.current.tasks).toEqual([]);
});

it("patches status and creation without HTTP, preserving loaded detail and removing archived tasks", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ workspaceId: a, tasks: [{ ...task(a), objective: "Keep this detail" }] }));
  vi.stubGlobal("fetch", fetcher);
  const hook = renderHook(() => useTeamWorkItems("owner@example.com", a, true));
  await waitFor(() => expect(hook.result.current.tasks).toHaveLength(1));
  act(() => live.options?.onEvent(event(patch({ status: "done", updatedAt: 2 }))));
  expect(hook.result.current.tasks[0]).toMatchObject({ status: "done", objective: "Keep this detail" });
  act(() => live.options?.onEvent(event(patch({ id: "created", updatedAt: 3 }), "task.created")));
  expect(hook.result.current.tasks.map(item => item.id)).toEqual(["created", "task"]);
  act(() => live.options?.onEvent(event(patch({ archived: true, updatedAt: 4, version: 3 }))));
  expect(hook.result.current.tasks.map(item => item.id)).toEqual(["created"]);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("ignores stale versions and other workspaces, and clears nullable assignee metadata", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ workspaceId: a, tasks: [{ ...task(a), ownerId: "human:member@example.test" }] }));
  vi.stubGlobal("fetch", fetcher);
  const hook = renderHook(() => useTeamWorkItems("owner@example.com", a, true));
  await waitFor(() => expect(hook.result.current.tasks).toHaveLength(1));
  act(() => live.options?.onEvent(event(patch({ status: "done", ownerId: null, updatedAt: 2, version: 3 }))));
  act(() => live.options?.onEvent(event(patch({ status: "todo", updatedAt: 3, version: 2 }))));
  act(() => live.options?.onEvent({ ...event(patch({ status: "todo", updatedAt: 4 })), workspaceId: b }));
  expect(hook.result.current.tasks[0]?.status).toBe("done");
  expect(hook.result.current.tasks[0]?.ownerId).toBeUndefined();
  expect(hook.result.current.tasks[0]?.assigneeActorId).toBeUndefined();
});

it("preserves patches delivered during a GET and performs one reconnect catch-up", async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }))
    .mockResolvedValue(Response.json({ workspaceId: a, tasks: [task(a)] }));
  vi.stubGlobal("fetch", fetcher);
  const hook = renderHook(() => useTeamWorkItems("owner@example.com", a, true));
  act(() => live.options?.onEvent(event(patch({ status: "done", updatedAt: 2 }))));
  await act(async () => { finish(Response.json({ workspaceId: a, tasks: [task(a)] })); });
  expect(hook.result.current.tasks[0]?.status).toBe("done");
  await act(async () => { live.options?.onReconnect?.(); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(hook.result.current.tasks[0]?.status).toBe("done");
});

it("resumes five-second polling after the live socket drops", async () => {
  vi.useFakeTimers(); live.connected = true;
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ workspaceId: a, tasks: [task(a)] })));
  vi.stubGlobal("fetch", fetcher);
  const hook = renderHook(() => useTeamWorkItems("owner@example.com", a, true));
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(fetcher).toHaveBeenCalledTimes(1);
  live.connected = false; hook.rerender();
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
