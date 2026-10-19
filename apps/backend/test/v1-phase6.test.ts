import { describe, expect, it, vi } from "vitest";
import type { DelegatedRun } from "@shiba/shared";
import type { Env } from "../src/env.js";
import { createApiKey, createToken, verifyToken } from "../src/agent-tokens.js";
import { handleApiKeys } from "../src/api-keys-routes.js";
import { handleV1 } from "../src/v1-routes.js";
import { threadCreateCommandId, writeThreadCreateReceipt } from "../src/v1-idempotency.js";

class FakeKV {
  map = new Map<string, string>();
  metadata = new Map<string, unknown>();
  async get(key: string, opts?: { type?: string }) {
    const value = this.map.get(key);
    if (value === undefined) return null;
    return opts?.type === "json" ? JSON.parse(value) : value;
  }
  async put(key: string, value: string, opts?: { metadata?: unknown }) {
    this.map.set(key, value);
    if (opts && "metadata" in opts) this.metadata.set(key, opts.metadata);
  }
  async list(opts?: { prefix?: string; cursor?: string }) {
    const prefix = opts?.prefix ?? "";
    const keys = [...this.map.keys()]
      .filter((name) => name.startsWith(prefix))
      .map((name) => ({ name, metadata: this.metadata.get(name) }));
    return { keys, list_complete: true, cursor: "" };
  }
}

const run: DelegatedRun = {
  runId: "r1", sandboxId: "s1", repoUrl: "https://github.com/acme/repo", task: "Fix",
  baseBranch: "main", publishPullRequest: false, status: "completed", generation: 1, createdAt: 1, updatedAt: 2,
};

describe("public API keys", () => {
  it("mints shk_ keys and verifies them", async () => {
    const env = { AGENT_TOKENS: new FakeKV() as unknown as KVNamespace };
    const { token, record } = await createApiKey(env, {
      label: "ci",
      principal: "ci-bot",
      scopes: ["api:read", "api:write"],
    });
    expect(token.startsWith("shk_")).toBe(true);
    expect(record.kind).toBe("api_key");
    expect(await verifyToken(env, token)).toMatchObject({ principal: "ci-bot" });
  });

  it("lists and revokes keys from the dashboard route", async () => {
    const kv = new FakeKV();
    const env = { AGENT_TOKENS: kv as unknown as KVNamespace };
    const minted = await createApiKey(env, { label: "x", principal: "p", scopes: ["api:read"] });
    const list = await handleApiKeys(new Request("http://localhost/api/api-keys"), env as Env);
    expect(list!.status).toBe(200);
    const body = await list!.json() as { keys: { keyId: string }[] };
    expect(body.keys.some((key) => key.keyId === minted.record.keyId)).toBe(true);
    const del = await handleApiKeys(
      new Request(`http://localhost/api/api-keys?keyId=${minted.record.keyId}`, { method: "DELETE" }),
      env as Env,
    );
    expect(await del!.json()).toMatchObject({ ok: true });
    expect(await verifyToken(env, minted.token)).toBeNull();
  });
});

describe("v1 contract (phase 6)", () => {
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
          headers: { "content-type": "application/json", ...(body ? {} : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        env as Env,
        deps,
      );
    return { send, calls, deps };
  }

  it("serves openapi.json without auth", async () => {
    const ok = await handleV1(new Request("https://worker.test/api/v1/openapi.json"), {} as Env, {
      authorize: async () => null,
    });
    expect(ok!.status).toBe(200);
    const doc = await ok!.json() as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/threads"]).toBeTruthy();
  });

  it("dedupes thread create on requestId", async () => {
    const kv = new FakeKV();
    const env = { AGENT_TOKENS: kv as unknown as KVNamespace } as Env;
    await writeThreadCreateReceipt(env, "self-hosted", "req-1", { approvalId: "a-old", at: 1 });
    const f = v1Fixture();
    const res = await f.send("/api/v1/threads", "POST", {
      requestId: "req-1",
      projectId: run.repoUrl,
      message: "Hello",
    }, env);
    expect(await res!.json()).toMatchObject({ approvalId: "a-old", deduped: true });
    expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("maps requestId to orchestrator commandId on first create", async () => {
    const f = v1Fixture();
    await f.send("/api/v1/threads", "POST", {
      requestId: "req-2",
      repoUrl: run.repoUrl,
      task: "Hello",
    });
    const post = f.calls.find((call) => call.method === "POST");
    const body = await post!.json() as { commandId?: string };
    expect(body.commandId).toBe(await threadCreateCommandId("self-hosted", "req-2"));
  });

  it("returns empty subagent list for a thread", async () => {
    const res = await v1Fixture().send("/api/v1/threads/r1/subagents");
    expect(await res!.json()).toEqual({ items: [], cursor: null });
  });

  it("rejects MCP agent tokens on the public v1 surface", async () => {
    const kv = new FakeKV();
    const env = { AGENT_TOKENS: kv as unknown as KVNamespace } as Env;
    const { token } = await createToken(env, "mcp-agent", ["runs:read"]);
    const res = await handleV1(
      new Request("https://worker.test/api/v1/threads", { headers: { authorization: `Bearer ${token}` } }),
      env,
    );
    expect(res!.status).toBe(401);
  });

  it("rejects bearer keys without api scopes on v1", async () => {
    const kv = new FakeKV();
    const env = { AGENT_TOKENS: kv as unknown as KVNamespace } as Env;
    const { token } = await createApiKey(env, { label: "r", principal: "p", scopes: ["api:keys:admin"] });
    const res = await handleV1(
      new Request("https://worker.test/api/v1/threads", { headers: { authorization: `Bearer ${token}` } }),
      env,
    );
    expect(res!.status).toBe(403);
  });
});
