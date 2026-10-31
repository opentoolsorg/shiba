import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/sandbox", () => ({
  ContainerProxy: class {},
  Sandbox: class {},
  proxyToSandbox: async () => null,
  getSandbox: () => ({ destroy: async () => {} }),
}));
const routed = vi.hoisted(() => ({ requests: [] as Request[] }));
vi.mock("agents/routing", () => ({
  getAgentByName: async () => ({ fetch: async () => new Response("{}", { status: 404 }) }),
  routeAgentRequest: async (request: Request) => {
    if (new URL(request.url).pathname !== "/agents/coding-orchestrator/default") return null;
    routed.requests.push(request);
    return new Response("ok");
  },
}));
vi.mock("@cloudflare/think", () => ({ Think: class {
  onStart() {}
  getTools() { return {}; }
  onRequest() { return new Response(null, { status: 404 }); }
} }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: vi.fn() }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));

/**
 * The MCP surface is exercised through `worker.fetch` with `agents/mcp`
 * stubbed: `createMcpHandler(...)` records every request the worker would
 * have served, so tests see both the auth gate and the exact principal
 * header the tool registry reads inside the handler.
 */
const served = vi.hoisted(() => ({ requests: [] as Request[] }));
vi.mock("agents/mcp", () => ({
  createMcpHandler: (_factory: unknown, _opts?: unknown) => ({
    fetch: async (request: Request) => {
      served.requests.push(request);
      return Response.json({ mcp: "served" }, { status: 200 });
    },
    notify: {},
  }),
}));

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import {
  createToken,
  hashToken,
  type AgentTokensEnv,
  type TokenRecord,
} from "../src/agent-tokens.js";
import {
  createToolRegistry,
  encodePrincipal,
  hashToolArgs,
  MCP_PRINCIPAL_HEADER,
  principalFor,
  visibleToolsForPrincipal,
} from "../src/mcp-gateway.js";

/** In-memory KV, same fake as the token-store suite. */
class FakeKV {
  readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async list() {
    return { keys: [], list_complete: true, cursor: "", cacheStatus: null };
  }
}

interface D1Call {
  sql: string;
  params: unknown[];
}

/** In-memory D1 recording (sql, params) pairs like the real binding. */
class FakeD1 {
  readonly calls: D1Call[] = [];
  readonly invocations = new Map<string, Record<string, unknown>>();
  fail = false;
  prepare(sql: string) {
    const calls = this.calls;
    const invocations = this.invocations;
    const execute = async (params: unknown[]) => {
      if (this.fail) throw new Error("D1 unavailable");
      calls.push({ sql, params });
      if (sql.includes("INSERT OR IGNORE INTO capability_invocations")) {
        const [id, orgId, principal, tool, argsHash, key, createdAt, updatedAt] = params;
        const composite = key == null ? String(id) : `${orgId}\u0000${principal}\u0000${key}`;
        if (invocations.has(composite)) return { success: true, results: [], meta: { changes: 0 } };
        invocations.set(composite, { invocation_id: id, org_id: orgId, principal, tool, args_hash: argsHash, idempotency_key: key, status: "dispatching", created_at: createdAt, updated_at: updatedAt, approval_id: null, error_code: null });
        return { success: true, results: [], meta: { changes: 1 } };
      }
      if (sql.includes("UPDATE capability_invocations SET")) {
        const row = [...invocations.values()].find((item) => item.invocation_id === params[4]);
        if (!row || row.status !== "dispatching") return { success: true, results: [], meta: { changes: 0 } };
        Object.assign(row, { status: params[0], updated_at: params[1], approval_id: params[2], error_code: params[3] });
        return { success: true, results: [], meta: { changes: 1 } };
      }
      return { success: true, results: [], meta: { changes: 1 } };
    };
    return {
      run: async () => {
        return execute([]);
      },
      bind: (...params: unknown[]) => ({
        run: async () => execute(params),
        first: async <T,>() => {
          if (this.fail) throw new Error("D1 unavailable");
          calls.push({ sql, params });
          const [orgId, principal, key] = params;
          const row = [...invocations.values()].find((item) => item.org_id === orgId && item.principal === principal && item.idempotency_key === key);
          return (row ?? null) as T | null;
        },
        all: async <T,>() => ({ results: [] as T[], success: true, meta: { changes: 0 } }),
      }),
    };
  }
}

function makeEnv() {
  const kv = new FakeKV();
  const d1 = new FakeD1();
  const env = {
    AGENT_TOKENS: kv as unknown as KVNamespace,
    AGENT_AUDIT: d1 as unknown as D1Database,
  } as unknown as Env;
  return { env, kv, d1 };
}

const ctx = { waitUntil: (p: Promise<unknown>) => p } as unknown as ExecutionContext;

function mcpRequest(headers: Record<string, string> = {}) {
  return new Request("https://worker/mcp", { method: "POST", headers });
}

describe("/mcp route auth", () => {
  it("answers a plain 401 JSON — not an MCP error — when no token is sent", async () => {
    const { env } = makeEnv();
    served.requests.length = 0;
    const response = await worker.fetch(mcpRequest(), env, ctx);
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "Authentication required." });
    // A JSON-RPC-shaped failure would mean the request reached MCP handling.
    expect(body).not.toHaveProperty("jsonrpc");
    expect(served.requests).toHaveLength(0);
  });

  it("401s on malformed and unknown bearers alike", async () => {
    const { env } = makeEnv();
    for (const auth of ["Basic dXNlcjpwYXNz", "Bearer not-a-token", "Bearer"]) {
      served.requests.length = 0;
      const response = await worker.fetch(
        mcpRequest({ authorization: auth }),
        env,
        ctx,
      );
      expect(response.status).toBe(401);
      expect(served.requests).toHaveLength(0);
    }
    served.requests.length = 0;
    const unknown = await worker.fetch(
      mcpRequest({ authorization: `Bearer shb_${"0".repeat(16)}_${"0".repeat(48)}` }),
      env,
      ctx,
    );
    expect(unknown.status).toBe(401);
    expect(served.requests).toHaveLength(0);
  });

  it("requires bearer auth on /mcp/* subpaths too", async () => {
    const { env } = makeEnv();
    served.requests.length = 0;
    const denied = await worker.fetch(
      new Request("https://worker/mcp/sse", { method: "GET" }),
      env,
      ctx,
    );
    expect(denied.status).toBe(401);
    expect(served.requests).toHaveLength(0);
    const { token } = await createToken(
      env as unknown as AgentTokensEnv,
      "scout",
      ["email:read"],
    );
    const ok = await worker.fetch(
      new Request("https://worker/mcp/sse", {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      }),
      env,
      ctx,
    );
    expect(ok.status).toBe(200);
    expect(served.requests).toHaveLength(1);
  });

  it("429s before touching the token store when the limiter denies", async () => {
    const { env, kv } = makeEnv();
    const getSpy = vi.spyOn(kv, "get");
    const seenKeys: string[] = [];
    (env as { MCP_RATE_LIMIT?: RateLimit }).MCP_RATE_LIMIT = {
      limit: async ({ key }) => {
        seenKeys.push(key);
        return { success: false };
      },
    };
    served.requests.length = 0;
    const response = await worker.fetch(
      mcpRequest({ "cf-connecting-ip": "203.0.113.7", authorization: "Bearer nope" }),
      env,
      ctx,
    );
    expect(response.status).toBe(429);
    expect(seenKeys).toEqual(["203.0.113.7"]);
    // The KV read never happened — that is the entire point of the limiter.
    expect(getSpy).not.toHaveBeenCalled();
    expect(served.requests).toHaveLength(0);
  });

  it("verifies the bearer and serves MCP when the limiter allows", async () => {
    const { env, kv } = makeEnv();
    const { token } = await createToken(
      env as unknown as AgentTokensEnv,
      "allowed",
      ["email:read"],
    );
    const getSpy = vi.spyOn(kv, "get");
    const seenKeys: string[] = [];
    (env as { MCP_RATE_LIMIT?: RateLimit }).MCP_RATE_LIMIT = {
      limit: async ({ key }) => {
        seenKeys.push(key);
        return { success: true };
      },
    };
    served.requests.length = 0;
    const response = await worker.fetch(
      mcpRequest({ "cf-connecting-ip": "203.0.113.7", authorization: `Bearer ${token}` }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(seenKeys).toEqual(["203.0.113.7"]);
    expect(getSpy).toHaveBeenCalled();
    expect(served.requests).toHaveLength(1);
  });

  it("drops a forged principal before routing a non-MCP request", async () => {
    const { env } = makeEnv();
    routed.requests.length = 0;
    const response = await worker.fetch(
      new Request("http://localhost/agents/coding-orchestrator/default", {
        headers: { [MCP_PRINCIPAL_HEADER]: "forged" },
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(routed.requests).toHaveLength(1);
    expect(routed.requests[0]!.headers.has(MCP_PRINCIPAL_HEADER)).toBe(false);
  });

  it("a forged x-shiba-principal header never survives to the handler", async () => {
    const { env } = makeEnv();
    const { token, record } = await createToken(
      env as unknown as AgentTokensEnv,
      "honest",
      ["email:read"],
    );
    served.requests.length = 0;
    const forged = encodePrincipal({ ...record, principal: "forged" });
    const response = await worker.fetch(
      mcpRequest({ authorization: `Bearer ${token}`, [MCP_PRINCIPAL_HEADER]: forged }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(principalFor(served.requests[0]!)).toEqual(record);
  });

  it("forwards non-ASCII principal names as escaped JSON the registry decodes", async () => {
    const { env } = makeEnv();
    const { token, record } = await createToken(
      env as unknown as AgentTokensEnv,
      "エージェント🤖",
      ["email:read"],
    );
    served.requests.length = 0;
    const response = await worker.fetch(
      mcpRequest({ authorization: `Bearer ${token}` }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(served.requests).toHaveLength(1);
    const forwarded = served.requests[0]!;
    // The header stays ByteString-safe even though the name is not.
    const raw = forwarded.headers.get(MCP_PRINCIPAL_HEADER)!;
    expect(raw).not.toContain("🤖");
    expect(principalFor(forwarded)).toEqual(record);
    expect(principalFor(forwarded)?.principal).toBe("エージェント🤖");
  });

  it("forwards verified principals as an injected header the client cannot spoof", async () => {
    const { env } = makeEnv();
    const { token, record } = await createToken(
      env as unknown as AgentTokensEnv,
      "scout",
      ["email:read"],
    );
    const spoof = JSON.stringify({
      principal: "evil",
      scopes: ["admin:tokens"],
      created: 1,
      revoked: false,
    });
    served.requests.length = 0;
    const response = await worker.fetch(
      mcpRequest({ authorization: `Bearer ${token}`, [MCP_PRINCIPAL_HEADER]: spoof }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(served.requests).toHaveLength(1);
    const forwarded = served.requests[0]!;
    // The forwarded request carries the verified record, not the spoof.
    expect(principalFor(forwarded)).toEqual(record);
    expect(principalFor(forwarded)?.principal).toBe("scout");
    expect(forwarded.headers.get(MCP_PRINCIPAL_HEADER)).not.toBe(spoof);
    // The bearer itself still rides along — the transport copies all headers.
    expect(forwarded.headers.get("authorization")).toBe(`Bearer ${token}`);
  });

  it("preserves org and token lifecycle metadata through the authenticated /mcp handler", async () => {
    const { env } = makeEnv();
    const { token, record } = await createToken(env as unknown as AgentTokensEnv, "same-name", ["email:read"]);
    const scoped: TokenRecord = {
      ...record,
      orgId: "workspace-b",
      kind: "agent",
      expiresAt: Date.now() + 60_000,
    };
    await env.AGENT_TOKENS.put(`tok_${await hashToken(token)}`, JSON.stringify(scoped));
    served.requests.length = 0;
    const response = await worker.fetch(mcpRequest({ authorization: `Bearer ${token}` }), env, ctx);
    expect(response.status).toBe(200);
    expect(served.requests).toHaveLength(1);
    expect(principalFor(served.requests[0]!)).toEqual(scoped);
  });
});

describe("principalFor", () => {
  const record: TokenRecord = {
    principal: "engage",
    scopes: ["memory:read"],
    created: 1_000,
    revoked: false,
  };

  it("returns the injected record and null for absent or corrupt headers", () => {
    const ok = principalFor(
      mcpRequest({ [MCP_PRINCIPAL_HEADER]: JSON.stringify(record) }),
    );
    expect(ok).toEqual(record);
    expect(principalFor(mcpRequest())).toBeNull();
    expect(
      principalFor(mcpRequest({ [MCP_PRINCIPAL_HEADER]: "{not json" })),
    ).toBeNull();
    expect(
      principalFor(
        mcpRequest({
          [MCP_PRINCIPAL_HEADER]: JSON.stringify({ principal: 7, scopes: "x" }),
        }),
      ),
    ).toBeNull();
  });

  it("preserves verified organization, token kind, label, key id, and expiry", () => {
    const scoped: TokenRecord = {
      ...record,
      orgId: "workspace-b",
      kind: "api_key",
      label: "Build worker",
      keyId: "key_b",
      expiresAt: 12_000,
    };
    expect(principalFor(mcpRequest({ [MCP_PRINCIPAL_HEADER]: JSON.stringify(scoped) }))).toEqual(scoped);
    expect(principalFor(mcpRequest({ [MCP_PRINCIPAL_HEADER]: JSON.stringify({ ...scoped, expiresAt: Number.NaN }) }))).toBeNull();
    expect(principalFor(mcpRequest({ [MCP_PRINCIPAL_HEADER]: JSON.stringify({ ...scoped, scopes: ["unknown:scope"] }) }))).toBeNull();
  });
});

describe("principalFor", () => {
  const record: TokenRecord = {
    principal: "engage",
    scopes: ["memory:read"],
    created: 1_000,
    revoked: false,
  };

  it("decodes a ByteString-escaped non-ASCII principal", () => {
    const unicode: TokenRecord = { ...record, principal: "エージェント🤖" };
    expect(
      principalFor(
        mcpRequest({ [MCP_PRINCIPAL_HEADER]: encodePrincipal(unicode) }),
      ),
    ).toEqual(unicode);
  });
});

describe("hashToolArgs", () => {
  it("is order-insensitive across nested objects", async () => {
    const a = await hashToolArgs({ b: 1, a: { z: 2, y: [3, { q: 0 }] } });
    const b = await hashToolArgs({ a: { y: [3, { q: 0 }], z: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("tool registry", () => {
  const principal: TokenRecord = {
    principal: "scout",
    scopes: ["email:read"],
    created: 1,
    revoked: false,
  };
  const okResult = { content: [{ type: "text" as const, text: "done" }] };

  it("filters tool discovery by verified principal scopes before exposing schemas", () => {
    const registry = createToolRegistry({} as Env);
    registry.registerTool("read_mail", "email:read", async () => okResult, { inputSchema: { query: ({} as never) } });
    registry.registerTool("send_mail", "email:send", async () => okResult, { inputSchema: { body: ({} as never) } });
    expect(visibleToolsForPrincipal(registry.tools(), principal).map((tool) => tool.name)).toEqual(["read_mail"]);
    expect(visibleToolsForPrincipal(registry.tools(), { ...principal, revoked: true })).toEqual([]);
    expect(visibleToolsForPrincipal(registry.tools(), null)).toEqual([]);
  });

  it("rejects duplicate tool names instead of silently replacing a registered handler", () => {
    const registry = createToolRegistry({} as Env);
    registry.registerTool("same", "email:read", async () => okResult);
    expect(() => registry.registerTool("same", "email:send", async () => okResult)).toThrow(/Duplicate MCP tool name/);
  });

  it("runs a scoped call and audits ok with the hashed args", async () => {
    const { env, d1 } = makeEnv();
    const registry = createToolRegistry(env);
    const handler = vi.fn(async () => okResult);
    registry.registerTool("search_emails", "email:read", handler);
    const args = { query: "s3cr3t-token-value", mailbox: "agent@shiba.dev" };
    const result = await registry.invoke("search_emails", args, principal);
    expect(result.content).toEqual(okResult.content);
    expect(result._meta?.["com.shiba/invocation"]).toMatchObject({ status: "succeeded", invocationId: expect.any(String) });
    expect(handler).toHaveBeenCalledWith(
      args,
      expect.objectContaining({ env, principal }),
    );
    const insert = d1.calls.find((c) => c.sql.startsWith("INSERT INTO audit_log"));
    expect(insert).toBeDefined();
    const [, , principal_, tool, argsHash, outcome] = insert!.params;
    expect(principal_).toBe("scout");
    expect(tool).toBe("search_emails");
    // args_hash is a hash of the raw args — the secret value never lands.
    expect(argsHash).toBe(await hashToolArgs(args));
    expect(String(argsHash)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(argsHash)).not.toContain("s3cr3t");
    expect(outcome).toBe("ok");
  });

  it("records approval-queued MCP calls as pending instead of successful execution", async () => {
    const { env, d1 } = makeEnv();
    const registry = createToolRegistry(env);
    registry.registerTool("queue_email", "email:send", async () => ({
      content: [{ type: "text", text: "Approval required." }],
      structuredContent: { status: "pending_approval", approvalId: "approval-123" },
    }));
    const result = await registry.invoke("queue_email", { body: "private body" }, { ...principal, scopes: ["email:send"] });
    expect(result.structuredContent).toMatchObject({ status: "pending_approval" });
    const insert = d1.calls.find((c) => c.sql.startsWith("INSERT INTO audit_log"))!;
    expect(insert.params[5]).toBe("pending_approval");
    expect(insert.params[6]).toBe("approval_id:approval-123");
    expect(JSON.stringify(insert.params)).not.toContain("private body");
  });

  it("links snake-case email approval ids into the invocation receipt", async () => {
    const { env } = makeEnv();
    const registry = createToolRegistry(env);
    registry.registerTool("send_email", "email:send", async () => ({
      content: [{ type: "text", text: "Approval required." }],
      structuredContent: { status: "pending_approval", approval_id: "email-approval-7" },
    }));
    const result = await registry.invoke("send_email", { body: "private" }, { ...principal, scopes: ["email:send"] });
    expect(result._meta?.["com.shiba/invocation"]).toMatchObject({ status: "pending_approval", approvalId: "email-approval-7" });
  });

  it("persists and replays one exact idempotency key without a second dispatch", async () => {
    const { env } = makeEnv();
    const registry = createToolRegistry(env);
    const handler = vi.fn(async () => okResult);
    registry.registerTool("local_fixture_read", "email:read", handler);
    const first = await registry.invoke("local_fixture_read", { q: "synthetic" }, principal, { idempotencyKey: "fixture-request-1" });
    const replay = await registry.invoke("local_fixture_read", { q: "synthetic" }, principal, { idempotencyKey: "fixture-request-1" });
    const changed = await registry.invoke("local_fixture_read", { q: "changed" }, principal, { idempotencyKey: "fixture-request-1" });
    expect(first._meta?.["com.shiba/invocation"]).toMatchObject({ status: "succeeded", invocationId: expect.any(String) });
    expect(replay._meta?.["com.shiba/invocation"]).toMatchObject({ status: "succeeded", replayed: true });
    expect(changed.isError).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("keeps same-named MCP principals and replay keys isolated across organizations", async () => {
    const { env } = makeEnv();
    const registry = createToolRegistry(env);
    const handler = vi.fn(async () => okResult);
    registry.registerTool("local_fixture_read", "email:read", handler);
    const orgA = { ...principal, orgId: "org-a" };
    const orgB = { ...principal, orgId: "org-b" };
    const a = await registry.invoke("local_fixture_read", { q: "same" }, orgA, { idempotencyKey: "same-key" });
    const b = await registry.invoke("local_fixture_read", { q: "same" }, orgB, { idempotencyKey: "same-key" });
    expect(a._meta?.["com.shiba/invocation"]).toMatchObject({ status: "succeeded" });
    expect(b._meta?.["com.shiba/invocation"]).toMatchObject({ status: "succeeded" });
    expect((a._meta?.["com.shiba/invocation"] as { invocationId: string }).invocationId)
      .not.toBe((b._meta?.["com.shiba/invocation"] as { invocationId: string }).invocationId);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("does not call the handler when the durable invocation store is unavailable", async () => {
    const { env, d1 } = makeEnv();
    d1.fail = true;
    const registry = createToolRegistry(env);
    const handler = vi.fn(async () => okResult);
    registry.registerTool("local_fixture_read", "email:read", handler);
    const result = await registry.invoke("local_fixture_read", { q: "synthetic" }, principal);
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: "Tool invocation could not be durably recorded; no tool was dispatched." });
    expect(handler).not.toHaveBeenCalled();
  });

  it("denies a missing scope without calling the handler, and audits denied", async () => {
    const { env, d1 } = makeEnv();
    const registry = createToolRegistry(env);
    const handler = vi.fn(async () => okResult);
    registry.registerTool("send_email", "email:send", handler);
    const result = await registry.invoke("send_email", { draft_id: "d1" }, principal);
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: 'Forbidden: missing scope "email:send".',
    });
    expect(handler).not.toHaveBeenCalled();
    const insert = d1.calls.find((c) => c.sql.startsWith("INSERT INTO audit_log"))!;
    expect(insert.params[5]).toBe("denied");
    expect(insert.params[2]).toBe("scout");
    expect(insert.params[6]).toBe("missing scope: email:send");
  });

  it("denies identically when the principal is absent", async () => {
    const { env } = makeEnv();
    const registry = createToolRegistry(env);
    registry.registerTool("search_emails", "email:read", async () => okResult);
    const result = await registry.invoke("search_emails", {}, null);
    expect(result.isError).toBe(true);
  });

  it("audits a thrown handler as error and returns an isError result", async () => {
    const { env, d1 } = makeEnv();
    const registry = createToolRegistry(env);
    registry.registerTool("boom", "email:read", async () => {
      throw new Error("store unreachable");
    });
    const result = await registry.invoke("boom", {}, principal);
    expect(result.isError).toBe(true);
    expect(result._meta?.["com.shiba/invocation"]).toMatchObject({ status: "unknown_outcome" });
    const insert = d1.calls.find((c) => c.sql.startsWith("INSERT INTO audit_log"))!;
    expect(insert.params[5]).toBe("error");
    expect(String(insert.params[6])).toContain("store unreachable");
  });

  it("answers isError for an unregistered tool — and still audits it", async () => {
    const { env, d1 } = makeEnv();
    const registry = createToolRegistry(env);
    const result = await registry.invoke("nope", {}, principal);
    expect(result.isError).toBe(true);
    // Every tool call leaves an audit row, even one no handler served.
    const insert = d1.calls.find((c) => c.sql.startsWith("INSERT INTO audit_log"))!;
    expect(insert.params[2]).toBe("scout");
    expect(insert.params[3]).toBe("nope");
    expect(insert.params[5]).toBe("error");
    expect(insert.params[6]).toBe("unknown tool");
  });

  it("audits unhashable args as error instead of throwing out of invoke", async () => {
    const { env, d1 } = makeEnv();
    const registry = createToolRegistry(env);
    const handler = vi.fn(async () => okResult);
    registry.registerTool("search_emails", "email:read", handler);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const args of [circular, { n: 1n }]) {
      d1.calls.length = 0;
      const result = await registry.invoke("search_emails", args, principal);
      expect(result.isError).toBe(true);
      expect(handler).not.toHaveBeenCalled();
      const insert = d1.calls.find((c) => c.sql.startsWith("INSERT INTO audit_log"))!;
      expect(insert.params[2]).toBe("scout");
      expect(insert.params[3]).toBe("search_emails");
      expect(insert.params[4]).toBe("<unhashable>");
      expect(insert.params[5]).toBe("error");
    }
  });
});
