// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useWorkTasks } from "./work-mutations";

const ws = `ws_${"a".repeat(24)}`;
const row = (over = {}) => ({
  workspaceId: ws,
  id: "t1",
  roomId: "r",
  roomTitle: "R",
  title: "One",
  assigneeKind: "human",
  status: "queued",
  updatedAt: 1,
  ...over,
});
const ok = (body: unknown) => Response.json(body);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stub(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const f = vi.fn((url: string, init?: RequestInit) => {
    if (!init?.method || init.method === "GET")
      return Promise.resolve(ok({ workspaceId: ws, tasks: [row()] }));
    return Promise.resolve(handler(url, init));
  });
  vi.stubGlobal("fetch", f);
  return f;
}

it("optimistically updates, then keeps the server row", async () => {
  const f = stub(() => ok({ task: row({ status: "completed", updatedAt: 5 }) }));
  const { result } = renderHook(() => useWorkTasks("a@x.co", ws, true));
  await waitFor(() => expect(result.current.tasks).toHaveLength(1));
  await act(async () => {
    await result.current.update("t1", { status: "completed" });
  });
  expect(result.current.tasks[0]?.status).toBe("completed");
  const call = f.mock.calls.find((c) => c[1]?.method === "PATCH");
  expect(call?.[0]).toContain("/work/t1");
  expect(JSON.parse(call?.[1]?.body as string)).toEqual({ patch: { status: "completed" } });
});

it("rolls back and surfaces the error when update fails", async () => {
  stub(() => Response.json({ error: "nope" }, { status: 400 }));
  const { result } = renderHook(() => useWorkTasks("a@x.co", ws, true));
  await waitFor(() => expect(result.current.tasks).toHaveLength(1));
  let out: unknown;
  await act(async () => {
    out = await result.current.update("t1", { status: "completed" });
  });
  expect(out).toBeNull();
  expect(result.current.tasks[0]?.status).toBe("queued");
  expect(result.current.error).toBe("nope");
});

it("creates a task and swaps the placeholder for the server row", async () => {
  stub(() => ok({ task: row({ id: "t2", title: "New", updatedAt: 9 }) }));
  const { result } = renderHook(() => useWorkTasks("a@x.co", ws, true));
  await waitFor(() => expect(result.current.tasks).toHaveLength(1));
  await act(async () => {
    await result.current.create("New");
  });
  expect(result.current.tasks.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
});

it("hides archived tasks and posts comments", async () => {
  const f = stub((url) =>
    url.endsWith("/archive")
      ? ok({ task: row({ archived: true, updatedAt: 3 }) })
      : ok({ task: row({ updatedAt: 4 }) }),
  );
  const { result } = renderHook(() => useWorkTasks("a@x.co", ws, true));
  await waitFor(() => expect(result.current.tasks).toHaveLength(1));
  await act(async () => {
    await result.current.comment("t1", "hi");
  });
  expect(f.mock.calls.some((c) => String(c[0]).endsWith("/t1/comments"))).toBe(true);
  await act(async () => {
    await result.current.archive("t1");
  });
  expect(result.current.tasks).toEqual([]);
});

it("shows the change before the server answers without reordering by a fake timestamp", async () => {
  let answer!: (r: Response) => void;
  stub(
    () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
  );
  const { result } = renderHook(() => useWorkTasks("a@x.co", ws, true));
  await waitFor(() => expect(result.current.tasks).toHaveLength(1));
  let pending!: Promise<unknown>;
  act(() => {
    pending = result.current.update("t1", { priority: "urgent" });
  });
  expect(result.current.tasks[0]?.priority).toBe("urgent");
  expect(result.current.tasks[0]?.updatedAt).toBe(1);
  await act(async () => {
    answer(ok({ task: row({ priority: "urgent", updatedAt: 7 }) }));
    await pending;
  });
  expect(result.current.tasks[0]).toMatchObject({ priority: "urgent", updatedAt: 7 });
});

it("appends a comment optimistically and removes it if posting fails", async () => {
  let answer!: (r: Response) => void;
  stub(
    () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
  );
  const { result } = renderHook(() => useWorkTasks("a@x.co", ws, true));
  await waitFor(() => expect(result.current.tasks).toHaveLength(1));
  let pending!: Promise<unknown>;
  act(() => {
    pending = result.current.comment("t1", "on it");
  });
  expect(result.current.tasks[0]?.activity).toEqual([
    expect.objectContaining({ kind: "comment", text: "on it", actorId: "a@x.co" }),
  ]);
  await act(async () => {
    answer(Response.json({ error: "Comment rejected." }, { status: 403 }));
    await pending;
  });
  expect(result.current.tasks[0]?.activity).toBeUndefined();
  expect(result.current.error).toBe("Comment rejected.");
  act(() => result.current.dismissError());
  expect(result.current.error).toBeNull();
});
