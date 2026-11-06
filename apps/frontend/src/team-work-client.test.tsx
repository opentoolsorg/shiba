// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTeamWorkItems } from "./team-work-client";

const a = `ws_${"a".repeat(24)}`, b = `ws_${"b".repeat(24)}`;
const task = (workspaceId: string) => ({ workspaceId, id: "task", roomId: "room", roomTitle: "Shared room", title: "Team work", assigneeKind: "human", status: "queued", updatedAt: 1 });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

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
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("does not fetch private runs when no team workspace is selected", () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const hook = renderHook(() => useTeamWorkItems("owner@example.com", "", true));
  expect(fetcher).not.toHaveBeenCalled();
  expect(hook.result.current.tasks).toEqual([]);
});
