import type { V1Context } from "./context.js";
import { readRun } from "./runs.js";

interface GitHubPull {
  node_id: string; number: number; html_url: string; state: string; merged: boolean; draft?: boolean;
  title: string; body: string | null; mergeable: boolean | null; additions?: number; deletions?: number;
  changed_files?: number; head: { ref: string; sha: string }; base: { ref: string };
}

const notImplemented = (detail: string) =>
  Response.json({ ok: false, error: "not_implemented", code: "not_implemented", detail }, { status: 501 });

async function github<T>(ctx: V1Context, path: string, init?: { method: string; body: unknown }): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    method: init?.method ?? "GET", signal: AbortSignal.timeout(30_000),
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${ctx.env.GITHUB_TOKEN}`,
      "User-Agent": "shiba", "X-GitHub-Api-Version": "2022-11-28", ...(init ? { "Content-Type": "application/json" } : {}) },
    ...(init ? { body: JSON.stringify(init.body) } : {}),
  });
  // Upstream bodies can echo request detail; only the status crosses the boundary.
  if (!response.ok) throw new Error(`github_${response.status}`);
  return await response.json() as T;
}

async function jsonBody(ctx: V1Context): Promise<Record<string, unknown> | Response> {
  try {
    const text = await ctx.request.text();
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { return Response.json({ ok: false, error: "invalid_request" }, { status: 400 }); }
}

const optionalOperationId = (value: unknown) =>
  value === undefined || (typeof value === "string" && value.length > 0 && value.length <= 64);

export async function handlePulls(ctx: V1Context): Promise<Response | null> {
  const match = ctx.url.pathname.match(/^\/api\/v1\/threads\/([^/]+)\/pr(?:\/(ready|status|comments|merge|review-loop))?$/);
  if (!match) return null;
  const action = match[2] ?? "create";
  const method = action === "status" || action === "comments" ? "GET" : action === "review-loop" ? (ctx.request.method === "PATCH" ? "PATCH" : "GET") : "POST";
  if (ctx.request.method !== method) return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  let id: string;
  try { id = decodeURIComponent(match[1]!); }
  catch { return Response.json({ ok: false, error: "invalid_thread" }, { status: 400 }); }
  const body = method === "GET" ? {} : await jsonBody(ctx);
  if (body instanceof Response) return body;
  if (!optionalOperationId(body.clientOperationId)) return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
  if (action === "merge") {
    const allowed = new Set(["pullRequestId", "expectedHeadSha", "mergeMethod", "commitTitle", "commitMessage", "clientOperationId"]);
    if (Object.keys(body).some((key) => !allowed.has(key)) || typeof body.expectedHeadSha !== "string" || !/^[a-fA-F0-9]{40,64}$/.test(body.expectedHeadSha) ||
        (body.mergeMethod !== undefined && !["merge", "squash", "rebase"].includes(body.mergeMethod as string)) ||
        (body.commitTitle !== undefined && (typeof body.commitTitle !== "string" || !body.commitTitle || body.commitTitle.length > 256)) ||
        (body.commitMessage !== undefined && (typeof body.commitMessage !== "string" || body.commitMessage.length > 65536)) ||
        (body.pullRequestId !== undefined && (typeof body.pullRequestId !== "string" || !body.pullRequestId))) {
      return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
    }
  }
  if (action === "review-loop" && method === "PATCH" &&
      (["enabled", "autoMerge"].some((key) => body[key] !== undefined && typeof body[key] !== "boolean") ||
       (body.pullRequestId !== undefined && (typeof body.pullRequestId !== "string" || !body.pullRequestId)))) {
    return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }
  if (action === "create" && ((body.title !== undefined && body.title !== null && (typeof body.title !== "string" || !body.title)) ||
      (body.body !== undefined && body.body !== null && typeof body.body !== "string") || (body.draft !== undefined && typeof body.draft !== "boolean"))) {
    return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }
  const run = await readRun(ctx, id);
  if (run instanceof Response) return run;
  // Merging is outward-facing: it must ride an approval, and ApprovalKind has no pr_merge kind yet.
  if (action === "merge") return notImplemented("PR merge requires a pr_merge approval kind; shiba never merges without an approval.");
  if (action === "review-loop") {
    if (method === "GET") return Response.json({ ok: true, reviewLoop: null });
    return notImplemented("The PR review loop needs a persisted loop record on the orchestrator.");
  }
  const pull = run.pullUrl?.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!pull) {
    // Publishing needs the run's captured files, which die with the settled sandbox.
    if (action === "create") return notImplemented("Opening a PR for a settled run needs its captured files; queue it with publishPullRequest.");
    return Response.json({ ok: false, error: "pull_request_not_found" }, { status: 404 });
  }
  if (!ctx.env.GITHUB_TOKEN) return Response.json({ ok: false, error: "github_not_configured" }, { status: 503 });
  const [, owner, repo, number] = pull;
  const repoFullName = `${owner}/${repo}`;
  const base = `/repos/${owner}/${repo}`;
  try {
    const pr = await github<GitHubPull>(ctx, `${base}/pulls/${number}`);
    const state = pr.merged ? "merged" : pr.state;
    if (action === "create") {
      // Idempotent: the run already published its PR, so return it rather than open a second one.
      return Response.json({ ok: true, pullRequest: { id: pr.node_id, threadId: id, number: pr.number, url: pr.html_url, repoFullName,
        state, headRef: pr.head.ref, headSha: pr.head.sha, baseRef: pr.base.ref, draft: pr.draft ?? false } }, { status: 201 });
    }
    if (action === "ready") {
      if (pr.draft) {
        const result = await github<{ errors?: unknown[] }>(ctx, "/graphql", { method: "POST", body: {
          query: "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }",
          variables: { id: pr.node_id } } });
        // GraphQL reports failures in a 200 body.
        if (result.errors?.length) throw new Error("github_502");
      }
      return Response.json({ ok: true, result: { changed: pr.draft === true, draft: false, number: pr.number, repoFullName, state } });
    }
    if (action === "status") {
      const checks = await github<{ check_runs: Array<{ id: number; name: string; status: string; conclusion: string | null;
        started_at: string | null; completed_at: string | null; html_url: string | null }> }>(ctx, `${base}/commits/${pr.head.sha}/check-runs`);
      return Response.json({ ok: true, pullRequestStatus: { number: pr.number, url: pr.html_url, repoFullName, provider: "github",
        title: pr.title, body: pr.body, descriptionAvailable: true, state, draft: pr.draft ?? false,
        mergeable: pr.mergeable === null ? "unknown" : pr.mergeable ? "mergeable" : "conflicting",
        checks: checks.check_runs.map((check) => ({ id: check.id, name: check.name, status: check.status, conclusion: check.conclusion,
          startedAt: check.started_at, completedAt: check.completed_at, url: check.html_url })), checksAvailable: true,
        additions: pr.additions ?? null, deletions: pr.deletions ?? null, changedFiles: pr.changed_files ?? null,
        baseRef: pr.base.ref, headRef: pr.head.ref, headSha: pr.head.sha } });
    }
    type Comment = { id: number; user: { login: string; avatar_url: string } | null; body: string; created_at: string;
      html_url: string; path?: string; line?: number | null; position?: number | null };
    const [issue, review] = await Promise.all([
      github<Comment[]>(ctx, `${base}/issues/${number}/comments?per_page=100`),
      github<Comment[]>(ctx, `${base}/pulls/${number}/comments?per_page=100`),
    ]);
    const comments = [...issue, ...review].map((comment) => ({ id: String(comment.id), authorLogin: comment.user?.login ?? null,
      authorAvatarUrl: comment.user?.avatar_url ?? null, body: comment.body, createdAt: comment.created_at,
      path: comment.path ?? null, line: comment.line ?? null, url: comment.html_url,
      // REST marks an outdated inline comment by a null position.
      isOutdated: comment.path !== undefined && comment.position === null }));
    // Thread resolution is GraphQL-only; REST cannot tell resolved from unresolved.
    return Response.json({ ok: true, pullRequestComments: { number: pr.number, repoFullName, commentsAvailable: true, unresolvedCount: 0, comments } });
  } catch (error) {
    const status = Number((error instanceof Error ? error.message : "").replace("github_", ""));
    return Response.json({ ok: false, error: "github_request_failed" }, { status: status === 404 ? 404 : 502 });
  }
}
