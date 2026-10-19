import { describe, expect, it } from "vitest";
import type { DelegatedRun } from "@shiba/shared";
import type { Env } from "../../../apps/backend/src/env.js";
import { handleV1 } from "../../../apps/backend/src/v1-routes.js";
import { writeThreadCreateReceipt } from "../../../apps/backend/src/v1-idempotency.js";

class FakeKV {
  map = new Map<string, string>();
  async get(key: string, opts?: { type?: string }) {
    const value = this.map.get(key);
    if (value === undefined) return null;
    return opts?.type === "json" ? JSON.parse(value) : value;
  }
  async put(key: string, value: string) {
    this.map.set(key, value);
  }
  async list() {
    return { keys: [], list_complete: true, cursor: "" };
  }
}

const run: DelegatedRun = {
  runId: "r1",
  sandboxId: "s1",
  repoUrl: "https://github.com/acme/repo",
  task: "Fix",
  baseBranch: "main",
  publishPullRequest: false,
  status: "completed",
  generation: 1,
  createdAt: 1,
  updatedAt: 2,
};

describe("@shiba/sdk contract (Worker v1 handler)", () => {
  const dashboardScopes = ["api:read", "api:write", "api:keys:admin"] as const;

  function v1Fixture() {
    const calls: Request[] = [];
    const deps = {
      authorize: async () => ({
        principal: "u1",
        orgId: "self-hosted",
        scopes: [...dashboardScopes],
      }),
      resolveTarget: async () => ({ agentName: "caller", userId: "u1" }),
      getStub: async () => ({
        fetch: async (request: Request) => {
          calls.push(request);
          if (request.method === "GET" && request.url.includes("/api/runs/r1")) {
            return Response.json({ run });
          }
          if (request.method === "POST" && request.url.endsWith("/api/runs")) {
            return Response.json({ ok: true, approvalId: "a1" });
          }
          return Response.json({ runs: [run] });
        },
      }),
    };
    const send = (path: string, method = "GET", body?: unknown, env: Partial<Env> = {}) =>
      handleV1(
        new Request(`https://worker.test${path}`, {
          method,
          headers: { "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        env as Env,
        deps,
      );
    return { send, calls };
  }

  it("matches SDK list/get thread JSON shape", async () => {
    const list = await v1Fixture().send("/api/v1/threads");
    const listBody = await list!.json() as { threads: { threadId: string }[] };
    expect(listBody.threads[0]?.threadId).toBe("r1");

    const get = await v1Fixture().send("/api/v1/threads/r1");
    const getBody = await get!.json() as { thread: { threadId: string } };
    expect(getBody.thread.threadId).toBe("r1");
  });

  it("dedupes create when requestId repeats", async () => {
    const kv = new FakeKV();
    const env = { AGENT_TOKENS: kv as unknown as KVNamespace } as Env;
    await writeThreadCreateReceipt(env, "self-hosted", "sdk-req", { approvalId: "a-old", at: 1 });
    const res = await v1Fixture().send(
      "/api/v1/threads",
      "POST",
      { requestId: "sdk-req", repoUrl: run.repoUrl, task: "Hello" },
      env,
    );
    expect(await res!.json()).toMatchObject({ approvalId: "a-old", deduped: true });
  });
});
