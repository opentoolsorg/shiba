import { describe, expect, it } from "vitest";
import type { DelegatedRun } from "@shiba/shared";
import type { Env } from "../src/env.js";
import { handleV1 } from "../src/v1-routes.js";

const artifact = { path: "deliverables/report.md", mediaType: "text/markdown", bytes: 7, sha256: "a".repeat(64) };
const run: DelegatedRun = {
  runId: "r1", sandboxId: "sb1", repoUrl: "https://github.com/acme/repo", task: "Write a report",
  baseBranch: "main", publishPullRequest: false, generation: 1, status: "completed", createdAt: 1, updatedAt: 2,
  expectedDeliverables: [artifact.path],
  deliverables: [{ ...artifact, content: "PRIVATE BODY", storageKey: "PRIVATE KEY" } as typeof artifact],
};

function fixture(apiKey = false) {
  const calls: Request[] = [];
  const send = (path: string, method = "GET", body?: unknown) => handleV1(new Request(`https://worker.test/api/v1${path}`, {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), {} as Env, {
    authorize: async () => ({ principal: "operator", orgId: "org-approved", scopes: ["api:read", "api:write"], ...(apiKey ? { apiKey: { principal: "operator", orgId: "org-approved", scopes: [], created: 1, revoked: false } } : {}) }),
    resolveTarget: async () => ({ agentName: "owner-session", userId: "operator" }),
    getStub: async () => ({ fetch: async (request: Request) => {
      calls.push(request);
      return request.method === "GET" ? Response.json(request.url.includes("/api/runs/r1") ? { run } : { runs: [run] }) : Response.json({ ok: true, approvalId: "human-approval" });
    } }),
  });
  return { send, calls };
}

describe("v1 deliverable projection", () => {
  it("preserves bot selection and requested outputs while keeping principal org scope authoritative", async () => {
    const f = fixture();
    const response = await f.send("/threads", "POST", { repoUrl: run.repoUrl, task: run.task, customAgentId: "profile-v1", expectedDeliverables: run.expectedDeliverables, orgId: "forged-org", threadKey: "default" });
    expect(response?.status).toBe(200);
    const queued = await f.calls.find((call) => call.method === "POST")!.json();
    expect(queued).toMatchObject({ customAgentId: "profile-v1", expectedDeliverables: run.expectedDeliverables, orgId: "org-approved", threadKey: "owner-session" });
  });

  it.each(["/threads", "/threads/r1", "/threads/r1/runs", "/threads/r1/run-state"])("returns metadata without content or storage keys at %s", async (path) => {
    const response = await fixture().send(path);
    expect(response?.status).toBe(200);
    const body = await response!.json() as Record<string, unknown>;
    const text = JSON.stringify(body);
    expect(text).not.toContain("PRIVATE");
    expect(text).not.toContain("storageKey");
    expect(text).toContain('"expectedDeliverables":["deliverables/report.md"]');
    expect(text).toContain(JSON.stringify(artifact));
  });

  it("preserves frozen expected outputs when retrying the same task", async () => {
    const f = fixture();
    expect((await f.send("/threads/r1/retry", "POST", {}))?.status).toBe(202);
    expect(await f.calls.find((call) => call.method === "POST")!.json()).toMatchObject({ expectedDeliverables: run.expectedDeliverables, orgId: "org-approved", threadKey: "owner-session" });
  });

  it("keeps unconfigured org API-key runtime access closed", async () => {
    const f = fixture(true);
    expect((await f.send("/threads", "POST", { repoUrl: run.repoUrl, task: run.task, expectedDeliverables: run.expectedDeliverables }))?.status).toBe(501);
    expect(f.calls).toHaveLength(0);
  });
});
