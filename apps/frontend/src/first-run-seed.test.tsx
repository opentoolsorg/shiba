// @vitest-environment happy-dom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureFirstRunSeed, useFirstRunSeed } from "./first-run-seed";

const seeded = {
  workspaceId: `ws_${"a".repeat(24)}`,
  createdWorkspace: true,
  createdAgents: ["chief-of-staff", "coding-coworker", "pr-reviewer", "standup-summarizer"],
};
beforeEach(() => sessionStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("POSTs the seed once and reports seeding then the result", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json(seeded));
  vi.stubGlobal("fetch", fetcher);
  const hook = renderHook(() => useFirstRunSeed({ actorId: "Owner@Example.com", enabled: true }));
  expect(hook.result.current.seeding).toBe(true);
  await waitFor(() => expect(hook.result.current.seeding).toBe(false));
  expect(hook.result.current).toEqual({ seeding: false, error: null, result: seeded });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[0]).toBe("/api/first-run-seed");
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST", credentials: "same-origin" });
});

it("does not call again in the same session, including after a remount", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json(seeded));
  vi.stubGlobal("fetch", fetcher);
  const first = renderHook(() => useFirstRunSeed({ actorId: "owner@example.com", enabled: true }));
  await waitFor(() => expect(first.result.current.result).toEqual(seeded));
  first.unmount();
  const second = renderHook(() => useFirstRunSeed({ actorId: "owner@example.com", enabled: true }));
  expect(second.result.current).toEqual({ seeding: false, error: null, result: null });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("shares one in-flight request between concurrent callers", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json(seeded));
  vi.stubGlobal("fetch", fetcher);
  const [a, b] = await Promise.all([
    ensureFirstRunSeed("x@example.com"),
    ensureFirstRunSeed("x@example.com"),
  ]);
  expect(a).toEqual(seeded);
  expect(b).toBe(a);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("never calls when disabled or signed out", () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  expect(
    renderHook(() => useFirstRunSeed({ actorId: "owner@example.com", enabled: false })).result
      .current.seeding,
  ).toBe(false);
  renderHook(() => useFirstRunSeed({ actorId: null, enabled: true }));
  expect(fetcher).not.toHaveBeenCalled();
});

it("treats a denied (read-only) response as nothing to seed, not an error", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { error: "First-run setup is not available for invited members." },
          { status: 403 },
        ),
      ),
  );
  const hook = renderHook(() => useFirstRunSeed({ actorId: "member@example.com", enabled: true }));
  await waitFor(() => expect(hook.result.current.seeding).toBe(false));
  expect(hook.result.current).toEqual({ seeding: false, error: null, result: null });
});

it("surfaces server failures and retries on the next mount", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ error: "Workspace storage is unavailable." }, { status: 503 }),
    )
    .mockResolvedValueOnce(Response.json(seeded));
  vi.stubGlobal("fetch", fetcher);
  const first = renderHook(() => useFirstRunSeed({ actorId: "owner@example.com", enabled: true }));
  await waitFor(() => expect(first.result.current.error).toBe("Workspace storage is unavailable."));
  first.unmount();
  const second = renderHook(() => useFirstRunSeed({ actorId: "owner@example.com", enabled: true }));
  await waitFor(() => expect(second.result.current.result).toEqual(seeded));
  expect(fetcher).toHaveBeenCalledTimes(2);
});
