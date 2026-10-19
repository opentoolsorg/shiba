import { afterEach, describe, expect, it, vi } from "vitest";
import type { DelegatedRun } from "@shiba/shared";
import type { Env } from "../src/env.js";
import type { V1Context } from "../src/v1/context.js";
import { handleDiffs, parseUnifiedDiff } from "../src/v1/diffs.js";
import { handlePreviews } from "../src/v1/previews.js";
import { handlePulls } from "../src/v1/pulls.js";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts", "index 1..2 100644", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,2 +1,2 @@", "-old", "+new", "+more", " same",
  "diff --git a/new.txt b/new.txt", "new file mode 100644", "--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1 @@", "+hi",
  "diff --git a/gone.txt b/gone.txt", "deleted file mode 100644", "--- a/gone.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye",
  "diff --git a/img.png b/img.png", "Binary files a/img.png and b/img.png differ", "",
].join("\n");

const run: DelegatedRun = { runId: "r1", sandboxId: "s1", repoUrl: "https://github.com/acme/repo", task: "Fix bugs",
  baseBranch: "main", publishPullRequest: true, generation: 2, status: "completed", createdAt: 1000, updatedAt: 4000, diff: DIFF,
  pullUrl: "https://github.com/acme/repo/pull/7",
  signals: [{ kind: "checkpoint.captured", at: 2000, detail: "refs/shiba/checkpoints/s1/0" },
    { kind: "checkpoint.captured", at: 3000, detail: "refs/shiba/checkpoints/s1/1" }] };

function fixture(path: string, method = "GET", body?: unknown, current: DelegatedRun = run, env: Partial<Env> = { GITHUB_TOKEN: "t" }, headers: Record<string, string> = {}) {
  const request = new Request(`https://worker.test/api/v1${path}`, { method,
    headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const forward = vi.fn(async (verb: string, _route: string, _input?: Record<string, unknown>) =>
    verb === "POST" ? Response.json({ ok: true, approvalId: "a1" }) : Response.json({ run: current }));
  const ctx: V1Context = {
    request, url: new URL(request.url), env: env as Env, forward,
    principal: { principal: "test", orgId: "self-hosted", scopes: ["api:read", "api:write", "api:keys:admin"] },
  };
  return { ctx, forward };
}

const pull = { node_id: "PR_1", number: 7, html_url: "https://github.com/acme/repo/pull/7", state: "open", merged: false, draft: true,
  title: "Fix", body: "b", mergeable: true, additions: 3, deletions: 1, changed_files: 2, head: { ref: "shiba/r1", sha: "a".repeat(40) }, base: { ref: "main" } };

function stubGitHub(routes: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    return path in routes ? Response.json(routes[path]) : new Response("nope", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("v1 P2 handlers", () => {
  it("return null for unrelated paths", async () => {
    for (const handler of [handleDiffs, handlePulls, handlePreviews]) expect(await handler(fixture("/threads/r1/runs").ctx)).toBeNull();
    expect(await handleDiffs(fixture("/threads/r1/diff/x/restore", "POST").ctx)).toBeNull();
  });

  it("parses unified diffs into per-file stats", () => {
    expect(parseUnifiedDiff(DIFF).map(({ patch: _patch, ...file }) => file)).toEqual([
      { path: "src/a.ts", state: "modified", additions: 2, deletions: 1 },
      { path: "new.txt", state: "added", additions: 1, deletions: 0 },
      { path: "gone.txt", state: "deleted", additions: 0, deletions: 1 },
      { path: "img.png", state: "modified", additions: 0, deletions: 0, truncated: true, truncatedReason: "binary" },
    ]);
  });

  it("serves the run diff and flags a mode fallback", async () => {
    const body = await (await handleDiffs(fixture("/threads/r1/diff").ctx))!.json() as { diff: Record<string, unknown> };
    expect(body.diff).toMatchObject({ threadId: "r1", mode: "uncommitted", effectiveMode: "base", isFallback: true, stats: { files: 4, additions: 3, deletions: 2 } });
    expect((await handleDiffs(fixture("/threads/r1/diff?mode=bogus").ctx))!.status).toBe(400);
    const empty = await (await handleDiffs(fixture("/threads/r1/diff?mode=base", "GET", undefined, { ...run, diff: undefined }).ctx))!.json();
    expect(empty).toMatchObject({ diff: { files: [], isFallback: false, unavailableReason: "no_diff_recorded" } });
  });

  it("lists checkpoints from captured signals with cursor paging", async () => {
    const first = await (await handleDiffs(fixture("/threads/r1/checkpoints?limit=1").ctx))!.json();
    expect(first).toEqual({ ok: true, nextCursor: "0", checkpoints: [{ id: "0", threadId: "r1", runId: "r1", label: "baseline", gitCommitSha: null, createdAt: new Date(2000).toISOString() }] });
    const second = await (await handleDiffs(fixture("/threads/r1/checkpoints?cursor=0").ctx))!.json();
    expect(second).toMatchObject({ nextCursor: null, checkpoints: [{ id: "1", label: "settle" }] });
    expect((await handleDiffs(fixture("/threads/r1/checkpoints?cursor=9").ctx))!.status).toBe(400);
    expect((await handleDiffs(fixture("/threads/r1/checkpoints?limit=0").ctx))!.status).toBe(400);
  });

  it("restores by forking an approval-gated run from the checkpoint ref", async () => {
    const f = fixture("/threads/r1/checkpoints/1/restore", "POST", { clientOperationId: "op" });
    const response = await handleDiffs(f.ctx);
    expect(response!.status).toBe(202);
    expect(await response!.json()).toEqual({ ok: true, result: { threadId: "r1", checkpointId: "1", status: "waiting", approvalId: "a1" } });
    expect(f.forward).toHaveBeenLastCalledWith("POST", "/api/runs/r1/fork", { checkpoint: "refs/shiba/checkpoints/s1/1", commandId: "v1:restore:r1:1:op" });
    expect((await handleDiffs(fixture("/threads/r1/checkpoints/9/restore", "POST").ctx))!.status).toBe(404);
    expect((await handleDiffs(fixture("/threads/r1/checkpoints/1/restore").ctx))!.status).toBe(405);
  });

  it("queues merge through pr_merge approval without calling GitHub directly", async () => {
    const fetchMock = stubGitHub({});
    const { ctx, forward } = fixture("/threads/r1/pr/merge", "POST", { expectedHeadSha: "a".repeat(40), mergeMethod: "squash" });
    expect((await handlePulls(fixture("/threads/r1/pr/merge", "POST", {}).ctx))!.status).toBe(400);
    expect((await handlePulls(fixture("/threads/r1/pr/merge", "POST", { expectedHeadSha: "a".repeat(40), extra: 1 }).ctx))!.status).toBe(400);
    const response = await handlePulls(ctx);
    expect(response!.status).toBe(200);
    expect(forward).toHaveBeenCalledWith("POST", "/api/runs/r1/merge", {
      expectedHeadSha: "a".repeat(40),
      mergeMethod: "squash",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the run's existing PR on create instead of opening another", async () => {
    stubGitHub({ "/repos/acme/repo/pulls/7": pull });
    const response = await handlePulls(fixture("/threads/r1/pr", "POST", { draft: true }).ctx);
    expect(response!.status).toBe(201);
    expect(await response!.json()).toMatchObject({ pullRequest: { number: 7, repoFullName: "acme/repo", state: "open", draft: true, headSha: "a".repeat(40) } });
    expect((await handlePulls(fixture("/threads/r1/pr", "POST", {}, { ...run, pullUrl: undefined }).ctx))!.status).toBe(501);
  });

  it("reports PR status with checks and mergeability", async () => {
    stubGitHub({ "/repos/acme/repo/pulls/7": pull, [`/repos/acme/repo/commits/${"a".repeat(40)}/check-runs`]: { check_runs: [
      { id: 1, name: "ci", status: "completed", conclusion: "success", started_at: null, completed_at: null, html_url: null }] } });
    expect(await (await handlePulls(fixture("/threads/r1/pr/status").ctx))!.json()).toMatchObject({ pullRequestStatus: {
      number: 7, state: "open", mergeable: "mergeable", checksAvailable: true, checks: [{ name: "ci", conclusion: "success" }] } });
  });

  it("merges issue and review comments", async () => {
    stubGitHub({ "/repos/acme/repo/pulls/7": pull,
      "/repos/acme/repo/issues/7/comments": [{ id: 1, user: { login: "u", avatar_url: "https://a" }, body: "hi", created_at: "t", html_url: "h" }],
      "/repos/acme/repo/pulls/7/comments": [{ id: 2, user: null, body: "nit", created_at: "t", html_url: "h", path: "a.ts", line: null, position: null }] });
    expect(await (await handlePulls(fixture("/threads/r1/pr/comments").ctx))!.json()).toMatchObject({ pullRequestComments: {
      number: 7, unresolvedCount: 0, comments: [{ id: "1", authorLogin: "u", isOutdated: false }, { id: "2", path: "a.ts", isOutdated: true }] } });
  });

  it("marks a draft ready via GraphQL", async () => {
    const fetchMock = stubGitHub({ "/repos/acme/repo/pulls/7": pull, "/graphql": { data: {} } });
    expect(await (await handlePulls(fixture("/threads/r1/pr/ready", "POST").ctx))!.json()).toMatchObject({ result: { changed: true, draft: false, number: 7 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces missing PRs, missing tokens, and upstream failures", async () => {
    expect((await handlePulls(fixture("/threads/r1/pr/status", "GET", undefined, { ...run, pullUrl: undefined }).ctx))!.status).toBe(404);
    expect((await handlePulls(fixture("/threads/r1/pr/status", "GET", undefined, run, {}).ctx))!.status).toBe(503);
    stubGitHub({});
    expect((await handlePulls(fixture("/threads/r1/pr/status").ctx))!.status).toBe(404);
  });

  it("has no review loop and refuses to configure one", async () => {
    expect(await (await handlePulls(fixture("/threads/r1/pr/review-loop").ctx))!.json()).toEqual({ ok: true, reviewLoop: null });
    expect((await handlePulls(fixture("/threads/r1/pr/review-loop", "PATCH", { enabled: "yes" }).ctx))!.status).toBe(400);
    expect((await handlePulls(fixture("/threads/r1/pr/review-loop", "PATCH", { enabled: true }).ctx))!.status).toBe(501);
  });

  it("reports previews as unsupported and refuses to start one", async () => {
    expect(await (await handlePreviews(fixture("/threads/r1/preview?port=3000").ctx))!.json()).toMatchObject({ preview: { name: "default", status: "unsupported", port: 3000 } });
    expect((await handlePreviews(fixture("/threads/r1/preview?port=80").ctx))!.status).toBe(400);
    expect((await handlePreviews(fixture("/threads/r1/preview/access").ctx))!.status).toBe(400);
    expect(await (await handlePreviews(fixture("/threads/r1/preview/access?frameOrigin=https://app.test").ctx))!.json()).toMatchObject({ preview: { status: "unsupported", gateway: null } });
    expect((await handlePreviews(fixture("/threads/r1/preview/start", "POST").ctx))!.status).toBe(501);
  });

  it("propagates a missing thread", async () => {
    const f = fixture("/threads/missing/preview");
    f.forward.mockResolvedValue(Response.json({ error: "missing" }, { status: 404 }));
    expect((await handlePreviews(f.ctx))!.status).toBe(404);
  });
});
