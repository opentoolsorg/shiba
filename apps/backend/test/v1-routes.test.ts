import { describe, expect, it } from "vitest";
import type { DelegatedRun } from "@shiba/shared";
import { AGENT_PRINCIPAL_HEADER, LOCAL_INTAKE_HEADER } from "@shiba/shared";
import type { Env } from "../src/env.js";
import { handleV1, type V1RouteDeps } from "../src/v1-routes.js";
import { reviewerTask } from "../src/review/prompt.js";

const run: DelegatedRun = {
  runId: "r1", sandboxId: "s1", repoUrl: "https://github.com/acme/repo", task: "ENG-12: Fix\nDetails",
  baseBranch: "main", publishPullRequest: false, status: "completed", generation: 0, createdAt: 1, updatedAt: 2,
};
function fixture(result: unknown = { run }, status = 200) {
  const calls: Request[] = [];
  const scopes: URL[] = [];
  const deps: V1RouteDeps = {
    isAuthorized: async () => true,
    resolveTarget: async (_request, _env, url) => { scopes.push(url); return { agentName: "caller", userId: "u1" }; },
    getStub: async (_env, name) => {
      expect(name).toBe("caller");
      return { fetch: async (request) => { calls.push(request); return Response.json(result, { status }); } };
    },
  };
  const send = (path: string, method = "GET", body?: unknown, env: Partial<Env> = {}) => handleV1(new Request(`https://worker.test${path}`, {
    method, headers: { "content-type": "application/json", [AGENT_PRINCIPAL_HEADER]: "forged", [LOCAL_INTAKE_HEADER]: "forged" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env as Env, deps);
  return { send, calls, scopes, deps };
}

describe("v1 routes", () => {
  it("ignores non-v1 paths", async () => {
    expect(await fixture().send("/api/runs")).toBeNull();
  });
  it("requires authorization", async () => {
    const f = fixture(); f.deps.isAuthorized = async () => false;
    expect((await f.send("/api/v1/threads"))?.status).toBe(401);
    expect(f.calls).toHaveLength(0);
  });
  it("reshapes threads and stamps the dashboard voucher", async () => {
    const f = fixture({ runs: [run] });
    expect(await (await f.send("/api/v1/threads"))?.json()).toEqual({ threads: [{
      threadId: "r1", repoUrl: run.repoUrl, title: "ENG-12: Fix", status: "completed", lane: "needs_review",
      archived: false, costUsd: null, createdAt: 1, updatedAt: 2, pullUrl: null, summary: null, error: null,
      errorCode: null, timedOut: false, usage: null,
    }] });
    expect(f.calls[0]?.headers.get(AGENT_PRINCIPAL_HEADER)).toBeNull();
    expect(f.calls[0]?.headers.get(LOCAL_INTAKE_HEADER)).toBe("dashboard");
  });
  it("gets one thread and preserves reported price", async () => {
    const response = await fixture({ run: { ...run, usage: { costUsd: 0.2 } } }).send("/api/v1/threads/r1");
    expect(await response?.json()).toMatchObject({ thread: { threadId: "r1", costUsd: 0.2 } });
  });
  it("passes through missing threads", async () => {
    expect((await fixture({ error: "Run not found." }, 404).send("/api/v1/threads/missing"))?.status).toBe(404);
  });
  it("queues threads without inventing a run id and uses body session", async () => {
    const f = fixture({ ok: true, approvalId: "a1" });
    const response = await f.send("/api/v1/threads", "POST", { repoUrl: run.repoUrl, task: "Fix", session: "s1", queuedBy: "forged" });
    expect(await response?.json()).toMatchObject({ approvalId: "a1", status: "waiting" });
    expect(f.scopes[0]?.searchParams.get("session")).toBe("s1");
    expect(await f.calls[0]?.json()).toEqual({ repoUrl: run.repoUrl, task: "Fix", orgId: "self-hosted" });
  });
  it("refuses messages on missing threads and interrupts active ones", async () => {
    expect((await fixture({ error: "missing" }, 404).send("/api/v1/threads/missing/message", "POST", { text: "Hi" }))?.status).toBe(404);
    const f = fixture({ run: { ...run, status: "running" } });
    f.deps.getStub = async () => ({
      fetch: async (request) => {
        f.calls.push(request);
        if (request.method === "GET") return Response.json({ run: { ...run, status: "running" } });
        return Response.json({ ok: true, approvalId: "steer-1" });
      },
    });
    expect((await f.send("/api/v1/threads/r1/message", "POST", { text: "Hi" }))?.status).toBe(200);
    expect(f.calls.some((call) => call.url.includes("/steer"))).toBe(true);
  });
  it("queues a follow-up with stored repository and continuation", async () => {
    const f = fixture();
    f.deps.getStub = async () => ({ fetch: async (request) => {
      f.calls.push(request);
      return Response.json(request.method === "GET" ? { run: { ...run, continuationKey: "key", threadKey: "thread" } } : { ok: true, approvalId: "a2" });
    } });
    const response = await f.send("/api/v1/threads/r1/message", "POST", { text: "Again", repoUrl: "forged" });
    expect(await response?.json()).toMatchObject({ approvalId: "a2", threadId: "r1", id: "adm_a2" });
    expect(await f.calls[1]?.json()).toEqual({
      repoUrl: run.repoUrl,
      task: "Follow-up on run r1:\nAgain",
      continuesKey: "key",
      threadKey: "thread",
      orgId: "self-hosted",
    });
  });
  it.each([["interrupt", "DELETE", "/api/runs/r1"], ["archive", "POST", "/api/runs/r1/archive"]])("forwards %s", async (action, method, path) => {
    const f = fixture();
    expect(await (await f.send(`/api/v1/threads/r1/${action}`, "POST"))?.json()).toMatchObject({ thread: { threadId: "r1" } });
    expect(f.calls[0]?.method).toBe(method);
    expect(new URL(f.calls[0]!.url).pathname).toBe(path);
  });
  it("derives task names from signal kinds and includes creation without signals", async () => {
    expect(await (await fixture().send("/api/v1/threads/r1/tasks"))?.json()).toEqual({ tasks: [{ name: "run", at: 1 }] });
    expect(await (await fixture({ run: { ...run, signals: [{ kind: "sandbox.ready", at: 3 }] } }).send("/api/v1/threads/r1/tasks"))?.json()).toEqual({ tasks: [{ name: "run", at: 1 }, { name: "sandbox.ready", at: 3, ok: true }] });
  });
  it("lists only unarchived reviews", async () => {
    const f = fixture({ runs: [run, { ...run, archivedAt: 3 }, { ...run, status: "running" }] });
    expect(await (await f.send("/api/v1/reviews"))?.json()).toMatchObject({ reviews: [{ threadId: "r1" }] });
  });
  it.each([undefined, "custom/reviewer"])("queues pinned reviews with model %s", async (model) => {
    const f = fixture({ ok: true, approvalId: "a1" });
    await f.send("/api/v1/reviews", "POST", { repoUrl: run.repoUrl, pullNumber: 12, headSha: "abc" }, { REVIEW_RUN_MODEL: model });
    expect(await f.calls[0]?.json()).toEqual({
      repoUrl: run.repoUrl,
      publishPullRequest: false,
      role: "reviewer",
      codingModel: model ?? "opencode-go/gpt-6.1-sol",
      commandId: `v1review:${run.repoUrl}:12:abc`,
      orgId: "self-hosted",
      task: reviewerTask({
        repoUrl: run.repoUrl,
        pullNumber: 12,
        headSha: "abc",
        diffUrl: `${run.repoUrl}/pull/12.diff`,
      }),
    });
  });
  it("returns 400, 404, and 405 for invalid requests", async () => {
    expect((await fixture().send("/api/v1/threads", "POST", {}))?.status).toBe(400);
    expect((await fixture().send("/api/v1/reviews", "POST", { repoUrl: "x", pullNumber: -1 }))?.status).toBe(400);
    expect((await fixture().send("/api/v1/threads/r1/message", "POST", { text: " " }))?.status).toBe(400);
    expect((await fixture().send("/api/v1/nope"))?.status).toBe(404);
    expect((await fixture().send("/api/v1/threads/r1/archive"))?.status).toBe(405);
    expect((await fixture().send("/api/v1/threads/r1/tasks", "POST"))?.status).toBe(405);
  });
});
