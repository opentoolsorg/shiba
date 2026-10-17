import { afterEach, describe, expect, it, vi } from "vitest";

const queued: Array<Record<string, unknown>> = [];
vi.mock("agents/routing", () => ({
  getAgentByName: async () => ({
    fetch: async (request: Request) => {
      queued.push(await request.json() as Record<string, unknown>);
      return Response.json({ approvalId: "appr_1" });
    },
  }),
  routeAgentRequest: async () => null,
}));

import { Automations } from "../src/automations-do.js";
import type { Env } from "../src/env.js";
import { handleAutomations } from "../src/v1/automations.js";
import type { V1Context } from "../src/v1/context.js";
import { handleMcp } from "../src/v1/mcp.js";
import { handleRepositories } from "../src/v1/repositories.js";

function makeDo() {
  const storage = new Map<string, unknown>();
  const state = { storage: {
    get: async (key: string) => storage.get(key),
    put: async (key: string, value: unknown) => void storage.set(key, value),
    list: async () => new Map(storage),
    delete: async (keys: string[]) => { for (const key of keys) storage.delete(key); },
  } } as unknown as DurableObjectState;
  return new Automations(state, { CodingOrchestrator: {}, AUTOMATIONS_ENABLED: "true", AI: {}, ORCHESTRATOR_MODEL: "@cf/test/model",
    GITHUB_TOKEN: "t" } as unknown as Env);
}

function fixture(path: string, method = "GET", body?: unknown, env: Partial<Env> = { GITHUB_TOKEN: "t" }, headers: Record<string, string> = {}) {
  const request = new Request(`https://worker.test/api/v1${path}`, { method,
    headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const forward = vi.fn(async () => new Response("unused", { status: 500 }));
  const ctx: V1Context = { request, url: new URL(request.url), env: env as Env, forward };
  return { ctx, forward };
}

function withDo(durable = makeDo()) {
  const env = { Automations: { idFromName: () => "id", get: () => ({ fetch: (request: Request) => durable.fetch(request) }) } } as unknown as Partial<Env>;
  return { durable, call: (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
    handleAutomations(fixture(path, method, body, env, headers).ctx) };
}

function stubGitHub(routes: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    return path in routes ? Response.json(routes[path]) : new Response("nope", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const repo = { id: 42, full_name: "acme/repo", default_branch: "main", private: true, clone_url: "https://github.com/acme/repo.git", language: "TypeScript" };
const PROJECT = encodeURIComponent("https://github.com/acme/repo");

afterEach(() => { vi.unstubAllGlobals(); queued.length = 0; });

describe("v1 P3a handlers", () => {
  it("return null for unrelated paths", async () => {
    for (const handler of [handleRepositories, handleMcp, handleAutomations]) expect(await handler(fixture("/threads/r1/runs").ctx)).toBeNull();
    expect(await handleRepositories(fixture("/source-control/github/installations/1/branches").ctx)).toBeNull();
  });

  describe("repositories", () => {
    it("503s without GITHUB_TOKEN and 405s writes", async () => {
      const fetchMock = stubGitHub({});
      expect((await handleRepositories(fixture("/source-control/github/repositories", "GET", undefined, {}).ctx))!.status).toBe(503);
      expect((await handleRepositories(fixture("/source-control/github/repositories", "POST").ctx))!.status).toBe(405);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("lists repositories with exact Hoplite keys", async () => {
      stubGitHub({ "/user/repos": [repo] });
      const response = await handleRepositories(fixture("/source-control/github/repositories").ctx);
      expect(await response!.json()).toEqual({ ok: true, repositories: [{ id: "42", fullName: "acme/repo", defaultBranch: "main", private: true }] });
    });

    it("surfaces the PAT as one installation", async () => {
      stubGitHub({ "/user": { login: "acme", type: "Organization" }, "/user/repos": [repo] });
      const body = await (await handleRepositories(fixture("/source-control/github/installations").ctx))!.json() as {
        installations: Array<Record<string, unknown> & { repositories: Array<Record<string, unknown>> }> };
      expect(body.installations).toHaveLength(1);
      expect(body.installations[0]).toMatchObject({ id: "pat", installationId: 0, accountLogin: "acme", accountType: "Organization" });
      expect(body.installations[0]!.repositories[0]).toMatchObject({ id: "42", repositoryId: 42, installationId: "pat",
        fullName: "acme/repo", cloneUrl: repo.clone_url, language: "TypeScript", framework: null });
    });

    it("lists branches by numeric id or owner/repo", async () => {
      const fetchMock = stubGitHub({ "/repositories/42/branches": [{ name: "main" }, { name: "dev" }], "/repos/acme/repo/branches": [{ name: "main" }] });
      expect(await (await handleRepositories(fixture("/source-control/github/repositories/42/branches").ctx))!.json()).toEqual({ ok: true, branches: ["main", "dev"] });
      expect(await (await handleRepositories(fixture(`/source-control/github/repositories/${encodeURIComponent("acme/repo")}/branches`).ctx))!.json())
        .toEqual({ ok: true, branches: ["main"] });
      expect(String(fetchMock.mock.calls[0]![0])).toContain("per_page=100");
      expect(new Headers((fetchMock.mock.calls[0]![1] as RequestInit).headers).get("authorization")).toBe("Bearer t");
      expect((await handleRepositories(fixture(`/source-control/github/repositories/${encodeURIComponent("a/b/c")}/branches`).ctx))!.status).toBe(400);
      expect((await handleRepositories(fixture("/source-control/github/repositories/7/branches").ctx))!.status).toBe(404);
    });

    it("inspects package.json for framework, port and scripts", async () => {
      const pkg = { packageManager: "pnpm@9.0.0", dependencies: { next: "15", vite: "5" }, scripts: { dev: "next dev" } };
      stubGitHub({ "/repositories/42": repo, "/repositories/42/contents/package.json": { content: btoa(JSON.stringify(pkg)) } });
      expect(await (await handleRepositories(fixture("/source-control/github/repositories/42/inspect").ctx))!.json()).toEqual({ ok: true,
        inspection: { framework: "nextjs", settings: { path: ".", previewPort: 3000, invalid: false, scripts: {
          setup: { enabled: true, command: "pnpm install" }, run: { enabled: true, command: "pnpm run dev" }, archive: { enabled: false, command: null } } } } });
    });

    it("inspects a repo without package.json, and 404s a missing repo", async () => {
      stubGitHub({ "/repositories/42": repo });
      expect(await (await handleRepositories(fixture("/source-control/github/repositories/42/inspect").ctx))!.json()).toEqual({ ok: true,
        inspection: { framework: null, settings: { path: ".", previewPort: null, invalid: false, scripts: {} } } });
      expect((await handleRepositories(fixture("/source-control/github/repositories/9/inspect").ctx))!.status).toBe(404);
    });

    it("maps other upstream failures to 502", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("bad creds", { status: 401 })));
      const response = await handleRepositories(fixture("/source-control/github/repositories").ctx);
      expect(response!.status).toBe(502);
      expect(await response!.text()).not.toContain("bad creds");
    });
  });

  describe("mcp servers", () => {
    it("lists the built-in gateway with no secrets", async () => {
      const body = await (await handleMcp(fixture("/mcp/servers?projectId=p1").ctx))!.json();
      expect(body).toEqual({ ok: true, servers: [{ id: "shiba", projectId: null, name: "shiba",
        config: { transport: "http", url: "https://worker.test/mcp", needsAuth: true }, enabled: true }] });
    });

    it("validates create, then 501s", async () => {
      expect((await handleMcp(fixture("/mcp/servers", "POST", { config: {} }).ctx))!.status).toBe(400);
      expect((await handleMcp(fixture("/mcp/servers", "POST", { name: "x", config: {} }, {}, { "Idempotency-Key": "" }).ctx))!.status).toBe(400);
      const response = await handleMcp(fixture("/mcp/servers", "POST", { name: "linear", config: { transport: "http", url: "https://mcp.linear.app" } }).ctx);
      expect(response!.status).toBe(501);
      expect(await response!.json()).toMatchObject({ code: "not_implemented" });
    });

    it("404s unknown ids and 409s the read-only gateway", async () => {
      expect((await handleMcp(fixture("/mcp/servers/other", "PATCH", { enabled: false }).ctx))!.status).toBe(404);
      expect((await handleMcp(fixture("/mcp/servers/shiba", "DELETE").ctx))!.status).toBe(409);
      expect((await handleMcp(fixture("/mcp/servers/shiba", "PATCH", { enabled: "no" }).ctx))!.status).toBe(400);
      expect((await handleMcp(fixture("/mcp/servers/shiba", "GET").ctx))!.status).toBe(405);
    });
  });

  describe("automations", () => {
    const create = { name: "Nightly", triggerKind: "schedule", prompt: "Bump deps\nthen test", schedule: { mode: "cron", expression: "0 3 * * *", timezone: "UTC" } };

    it("creates, lists and filters by project", async () => {
      const { call } = withDo();
      const created = await call(`/projects/${PROJECT}/automations`, "POST", create);
      expect(created!.status).toBe(201);
      const body = await created!.json() as { automation: Record<string, unknown>; webhookToken?: string };
      expect(body.webhookToken).toBeUndefined();
      expect(body.automation).toMatchObject({ projectId: "https://github.com/acme/repo", repoFullName: "acme/repo", name: "Bump deps",
        enabled: true, triggerKind: "schedule", schedule: { mode: "cron", expression: "0 3 * * *", timezone: "UTC" },
        triggers: [{ id: "t0", triggerKind: "schedule", eventKind: null, schedule: { mode: "cron", expression: "0 3 * * *", timezone: "UTC" } }] });
      await call(`/projects/${encodeURIComponent("other/repo")}/automations`, "POST", create);
      const listed = await (await call(`/projects/${encodeURIComponent("acme/repo")}/automations`))!.json() as { automations: Array<{ id: string }> };
      expect(listed.automations.map((automation) => automation.id)).toEqual([body.automation.id]);
      expect((await call("/projects/not-a-repo/automations"))!.status).toBe(400);
    });

    it("returns a webhook token once and maps event kinds", async () => {
      const { call } = withDo();
      const response = await call(`/projects/${PROJECT}/automations`, "POST", { name: "PRs", prompt: "Review", triggerKind: "webhook",
        triggers: [{ id: "a", triggerKind: "webhook" }, { id: "b", triggerKind: "webhook", eventKind: "github.pull_request.opened" }] });
      const body = await response!.json() as { automation: { id: string; triggers: Array<{ eventKind: string | null }> }; webhookToken: string; webhookUrl: string };
      expect(body.webhookToken).toMatch(/^[0-9a-f]{64}$/);
      expect(body.webhookUrl).toBe(`https://worker.test/api/automations/${body.automation.id}/trigger`);
      expect(body.automation.triggers.map((trigger) => trigger.eventKind)).toEqual([null, "github.pull_request.opened"]);
      const listed = JSON.stringify(await (await call(`/projects/${PROJECT}/automations`))!.json());
      expect(listed).not.toContain(body.webhookToken);
    });

    it("rejects invalid input and 501s unsupported fields", async () => {
      const { call } = withDo();
      expect((await call(`/projects/${PROJECT}/automations`, "POST", { ...create, name: "" }))!.status).toBe(400);
      expect((await call(`/projects/${PROJECT}/automations`, "POST", { ...create, bogus: 1 }))!.status).toBe(400);
      expect((await call(`/projects/${PROJECT}/automations`, "POST", { ...create, repoFullName: "else/where" }))!.status).toBe(400);
      expect((await call(`/projects/${PROJECT}/automations`, "POST", { ...create, schedule: { mode: "cron", expression: "* * * * *", timezone: "UTC" } }))!.status).toBe(400);
      for (const extra of [{ modelId: "m" }, { isDraft: true }, { schedule: { mode: "interval", intervalMs: 60000 } },
        { schedule: { mode: "cron", expression: "0 3 * * *", timezone: "Asia/Kolkata" } }]) {
        expect((await call(`/projects/${PROJECT}/automations`, "POST", { ...create, ...extra }))!.status).toBe(501);
      }
      expect((await call(`/projects/${PROJECT}/automations`, "POST", { name: "x", prompt: "y", triggerKind: "webhook", eventKind: "linear.issue.created" }))!.status).toBe(501);
    });

    it("replays an Idempotency-Key without creating twice", async () => {
      const { call } = withDo();
      const first = await (await call(`/projects/${PROJECT}/automations`, "POST", create, { "Idempotency-Key": "k1" }))!.json() as { automation: { id: string } };
      const second = await call(`/projects/${PROJECT}/automations`, "POST", create, { "Idempotency-Key": "k1" });
      expect(second!.status).toBe(201);
      expect((await second!.json() as { automation: { id: string } }).automation.id).toBe(first.automation.id);
      expect(((await (await call(`/projects/${PROJECT}/automations`))!.json()) as { automations: unknown[] }).automations).toHaveLength(1);
      expect((await call(`/projects/${encodeURIComponent("other/repo")}/automations`, "POST", create, { "Idempotency-Key": "k1" }))!.status).toBe(409);
    });

    it("patches enabled/prompt, 501s other fields, and deletes", async () => {
      const { call } = withDo();
      const { automation } = await (await call(`/projects/${PROJECT}/automations`, "POST", create))!.json() as { automation: { id: string } };
      const item = `/projects/${PROJECT}/automations/${automation.id}`;
      const patched = await (await call(item, "PATCH", { enabled: false, prompt: "New prompt", clientOperationId: "op" }))!.json() as { automation: Record<string, unknown> };
      expect(patched.automation).toMatchObject({ enabled: false, prompt: "New prompt", name: "New prompt" });
      expect((await call(item, "PATCH", { name: "Renamed" }))!.status).toBe(501);
      expect((await call(item, "PATCH", { enabled: "no" }))!.status).toBe(400);
      expect((await call(`/projects/${encodeURIComponent("other/repo")}/automations/${automation.id}`, "DELETE"))!.status).toBe(404);
      expect(await (await call(item, "DELETE"))!.json()).toEqual({ ok: true, result: { id: automation.id } });
      expect((await call(item, "DELETE"))!.status).toBe(404);
    });

    it("runs an automation and reports status and executions", async () => {
      const { call } = withDo();
      const { automation } = await (await call(`/projects/${PROJECT}/automations`, "POST", create))!.json() as { automation: { id: string } };
      const run = await call(`/projects/${PROJECT}/automations/${automation.id}/run`, "POST");
      expect(run!.status).toBe(202);
      expect(await run!.json()).toMatchObject({ ok: true, execution: { automationId: automation.id, status: "accepted", triggerKind: "schedule", threadId: null } });
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ repoUrl: "https://github.com/acme/repo" });
      const executions = await (await call(`/projects/${PROJECT}/automations/${automation.id}/executions?limit=5`))!.json() as { executions: Array<Record<string, unknown>> };
      expect(executions.executions).toHaveLength(1);
      expect(executions.executions[0]).toMatchObject({ status: "accepted", automationId: automation.id, projectId: "https://github.com/acme/repo" });
      expect((await call(`/projects/${PROJECT}/automations/${automation.id}/executions?limit=0`))!.status).toBe(400);
      const status = await (await call(`/projects/${PROJECT}/automations/status`))!.json() as { statuses: Array<Record<string, unknown>>; totals: Record<string, number> };
      expect(status.statuses[0]).toMatchObject({ automationId: automation.id, lastStatus: "accepted", runs30d: 1 });
      expect(status.totals.runs30d).toBe(1);
      expect((await call(`/projects/${PROJECT}/automations/missing/run`, "POST"))!.status).toBe(404);
      expect((await call(`/projects/${PROJECT}/automations/status`, "POST"))!.status).toBe(405);
    });

    it("409s running a legacy automation that has no manual trigger", async () => {
      const durable = makeDo();
      await durable.fetch(new Request("https://internal/api/automations", { method: "POST",
        body: JSON.stringify({ id: "legacy", prompt: "p", repoUrl: "https://github.com/acme/repo", triggers: [{ kind: "schedule", cron: "0 3 * * *" }] }) }));
      const { call } = withDo(durable);
      expect((await call(`/projects/${PROJECT}/automations/legacy/run`, "POST"))!.status).toBe(409);
    });
  });
});
