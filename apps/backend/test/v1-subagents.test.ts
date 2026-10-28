import { describe, expect, it, vi } from "vitest";
import type { DelegatedRun } from "@shiba/shared";
import type { Env } from "../src/env.js";
import type { V1Context } from "../src/v1/context.js";
import { handleSubagents } from "../src/v1/subagents.js";

const root: DelegatedRun = {
  runId: "root", sandboxId: "root-sandbox", repoUrl: "https://github.com/acme/repo", task: "Fix the bug",
  baseBranch: "main", publishPullRequest: false, status: "running", generation: 1, createdAt: 1, updatedAt: 2,
};
const child: DelegatedRun = {
  ...root, runId: "child", parentRunId: root.runId, subagentPath: "1", subagentSandbox: "fresh",
  task: "Inspect the parser\nLook at error cases", createdAt: 3, updatedAt: 4, status: "completed", summary: "Found the bug",
};
const grandchild: DelegatedRun = {
  ...child, runId: "grandchild", parentRunId: child.runId, subagentPath: "1.1", task: "Inspect fixtures", createdAt: 5,
};

function fixture(path: string, options: { records?: DelegatedRun[]; visible?: DelegatedRun[]; method?: string; scope?: boolean; failure?: number } = {}) {
  const records = options.records ?? [root, child, grandchild];
  const request = new Request(`https://worker.test/api/v1${path}`, { method: options.method ?? "GET" });
  const forward = vi.fn(async (_method: string, route: string) => {
    if (options.failure) return Response.json({ error: "store unavailable" }, { status: options.failure });
    if (route === "/api/runs") return Response.json({ runs: options.visible ?? records });
    const id = decodeURIComponent(route.slice("/api/runs/".length));
    const run = records.find((item) => item.runId === id);
    return run ? Response.json({ run }) : Response.json({ error: "Run not found." }, { status: 404 });
  });
  const ctx: V1Context = { request, url: new URL(request.url), env: {} as Env,
    principal: { principal: "owner", orgId: "self-hosted", scopes: options.scope === false ? [] : ["api:read"] }, forward };
  return { ctx, forward };
}

async function result(path: string, options?: Parameters<typeof fixture>[1]) {
  return (await handleSubagents(fixture(path, options).ctx))!;
}

describe("persisted v1 subagent projections", () => {
  it("lists the entire actual tree and excludes identical paths under another thread", async () => {
    const otherRoot = { ...root, runId: "other-root" };
    const otherChild = { ...child, runId: "other-child", parentRunId: otherRoot.runId };
    const response = await result("/threads/root/subagents", { records: [root, child, grandchild, otherRoot, otherChild] });
    expect(response.status).toBe(200);
    const body = await response.json() as { items: Array<{ id: string; parentId: string; threadId: string }>; cursor: string | null };
    expect(body.items.map((item) => item.id)).toEqual(["child", "grandchild"]);
    expect(body.items[1]).toMatchObject({ parentId: "child", threadId: "root" });
    expect(body.cursor).toBeNull();
  });

  it("paginates without dropping descendants of a completed parent", async () => {
    const page = await (await result("/threads/root/subagents?limit=1")).json();
    expect(page).toMatchObject({ items: [{ id: "child" }], cursor: "child" });
    expect(await (await result("/threads/root/subagents?limit=1&cursor=child")).json())
      .toMatchObject({ items: [{ id: "grandchild" }], cursor: null });
  });

  it.each(["0", "101", "1.5", "nope"])("rejects invalid list limit %s", async (limit) => {
    expect((await result(`/threads/root/subagents?limit=${limit}`)).status).toBe(400);
  });

  it("rejects a cursor outside the requested tree", async () => {
    expect((await result("/threads/root/subagents?cursor=foreign-child")).status).toBe(400);
  });

  it("returns persisted detail and recorded usage without inventing credits", async () => {
    const response = await result("/subagents/grandchild", { records: [root, child, { ...grandchild, usage: { inputTokens: 20, outputTokens: 10, costUsd: 0.05 } }] });
    expect(await response.json()).toMatchObject({
      id: "grandchild", threadId: "root", parentId: "child", subagentPath: "1.1", status: "completed",
      usage: { inputTokens: 20, outputTokens: 10, costUsd: 0.05 },
    });
    expect(await (await result("/subagents/child")).json()).toMatchObject({ usage: null });
  });

  it("returns only the stored task and summary for subagent messages", async () => {
    const response = await result("/subagents/child/messages");
    expect(await response.json()).toMatchObject({ items: [
      { role: "user", content: child.task }, { role: "assistant", content: child.summary },
    ], cursor: null });
  });

  it.each(["/subagents/missing", "/subagents/missing/messages", "/subagents/root", "/subagents/root/messages"])("returns 404 for an absent subagent at %s", async (path) => {
    expect((await result(path)).status).toBe(404);
  });

  it("does not resolve a parent outside the caller-visible registry", async () => {
    expect((await result("/subagents/child", { visible: [child] })).status).toBe(404);
    expect((await result("/subagents/child/messages", { visible: [child] })).status).toBe(404);
  });

  it("bounds traversal of malformed cyclic lineage", async () => {
    const cycle = { ...child, parentRunId: grandchild.runId };
    expect((await result("/subagents/child", { records: [cycle, grandchild] })).status).toBe(404);
  });

  it("preserves storage failures instead of returning a false empty page", async () => {
    expect((await result("/threads/root/subagents", { failure: 503 })).status).toBe(503);
  });

  it("requires read permission before touching the run store", async () => {
    const f = fixture("/threads/root/subagents", { scope: false });
    expect((await handleSubagents(f.ctx))!.status).toBe(403);
    expect(f.forward).not.toHaveBeenCalled();
  });

  it("rejects mutations and malformed ids", async () => {
    expect((await result("/threads/root/subagents", { method: "POST" })).status).toBe(405);
    expect((await result("/threads/%E0%A4%A/subagents")).status).toBe(400);
  });

  it("leaves unrelated routes to other handlers", async () => {
    expect(await handleSubagents(fixture("/threads/root/messages").ctx)).toBeNull();
  });
});
