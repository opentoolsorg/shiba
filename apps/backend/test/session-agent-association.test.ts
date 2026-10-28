import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentByName } from "agents/routing";
import type { Env } from "../src/env.js";
import { handleWebSessions } from "../src/sessions-routes.js";

vi.mock("agents/routing", () => ({ getAgentByName: vi.fn() }));

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "cag-111111111111111111111111";

function fixture(options: { binding?: boolean; org?: string; deleted?: boolean; harness?: string; outage?: boolean } = {}) {
  const forwarded = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { session?: unknown; metadata?: unknown };
    return Response.json({ session: body.session ?? { id: SESSION_ID, ...body } });
  });
  vi.mocked(getAgentByName).mockResolvedValue({ fetch: forwarded } as never);
  const queries: unknown[][] = [];
  const db = {
    prepare(sql: string) {
      if (options.outage) throw new Error("database temporarily unavailable");
      return {
        async run() { return { success: true }; },
        bind(...values: unknown[]) {
          queries.push(values);
          return {
            async first() {
              if (!sql.includes("FROM org_custom_agents")) throw new Error("Unexpected query");
              if (values[0] !== (options.org ?? "self-hosted") || values[1] !== AGENT_ID || options.deleted) return null;
              return {
                id: AGENT_ID,
                org_id: options.org ?? "self-hosted",
                slug: "scout",
                version: 1,
                config_json: JSON.stringify({ name: "Scout", instructions: "Read the repository.", harness: options.harness ?? "opencode" }),
                created_at: 1,
                updated_at: 1,
                deleted_at: null,
              };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  const env = {
    CodingOrchestrator: {} as DurableObjectNamespace,
    ...(options.binding !== false ? { AGENT_AUDIT: db } : {}),
  } as unknown as Env;
  const request = (method: "POST" | "PATCH", metadata: unknown, extra: Record<string, unknown> = {}) => new Request(
    `http://localhost/api/sessions${method === "PATCH" ? `/${SESSION_ID}` : ""}`,
    {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Scout thread", ...(metadata === undefined ? {} : { metadata }), ...extra }),
    },
  );
  return { env, forwarded, queries, request };
}

beforeEach(() => vi.clearAllMocks());

describe("server-validated bot/thread associations", () => {
  it.each(["POST", "PATCH"] as const)("persists an active dashboard-org profile with %s", async (method) => {
    const f = fixture();
    const response = await handleWebSessions(f.request(method, { customAgentId: AGENT_ID, purpose: "review" }), f.env);
    expect(response?.status).toBe(method === "POST" ? 201 : 200);
    expect(f.queries).toEqual([["self-hosted", AGENT_ID]]);
    expect(f.forwarded).toHaveBeenCalledOnce();
    const saved = JSON.parse(String(f.forwarded.mock.calls[0]?.[1]?.body)) as { session?: { metadata: unknown }; metadata?: unknown };
    expect(saved.session?.metadata ?? saved.metadata).toEqual({ customAgentId: AGENT_ID, purpose: "review" });
  });

  it.each(["POST", "PATCH"] as const)("does not persist another org's profile through %s", async (method) => {
    const f = fixture({ org: "another-org" });
    const response = await handleWebSessions(f.request(method, { customAgentId: AGENT_ID, orgId: "another-org" }, { orgId: "another-org" }), f.env);
    expect(response?.status).toBe(404);
    expect(f.queries).toEqual([["self-hosted", AGENT_ID]]);
    expect(f.forwarded).not.toHaveBeenCalled();
  });

  it.each(["POST", "PATCH"] as const)("rejects a deleted profile through %s", async (method) => {
    const f = fixture({ deleted: true });
    expect((await handleWebSessions(f.request(method, { customAgentId: AGENT_ID }), f.env))?.status).toBe(404);
    expect(f.forwarded).not.toHaveBeenCalled();
  });

  it.each([null, 123, "", " scout "])("rejects malformed association %j before lookup", async (customAgentId) => {
    const f = fixture();
    expect((await handleWebSessions(f.request("POST", { customAgentId }), f.env))?.status).toBe(400);
    expect(f.queries).toEqual([]);
    expect(f.forwarded).not.toHaveBeenCalled();
  });

  it("uses canonical profile ids rather than treating slugs as identities", async () => {
    const f = fixture();
    expect((await handleWebSessions(f.request("POST", { customAgentId: "scout" }), f.env))?.status).toBe(404);
    expect(f.forwarded).not.toHaveBeenCalled();
  });

  it.each(["does-not-exist", "cursor", "codex-subscription"])("refuses unavailable harness %s", async (harness) => {
    const f = fixture({ harness });
    expect((await handleWebSessions(f.request("POST", { customAgentId: AGENT_ID }), f.env))?.status).toBe(409);
    expect(f.forwarded).not.toHaveBeenCalled();
  });

  it("returns an explicit setup error when the registry binding is absent", async () => {
    const f = fixture({ binding: false });
    const response = await handleWebSessions(f.request("POST", { customAgentId: AGENT_ID }), f.env);
    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({ error: "Bot registry is not configured." });
    expect(f.forwarded).not.toHaveBeenCalled();
  });

  it("returns a recoverable registry outage instead of accepting an unchecked reference", async () => {
    const f = fixture({ outage: true });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await handleWebSessions(f.request("PATCH", { customAgentId: AGENT_ID }), f.env);
      expect(response?.status).toBe(503);
      expect(await response?.json()).toEqual({ error: "Bot registry is unavailable." });
      expect(f.forwarded).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });

  it.each(["POST", "PATCH"] as const)("preserves ordinary session metadata without a custom-agent binding for %s", async (method) => {
    const f = fixture({ binding: false });
    const response = await handleWebSessions(f.request(method, { purpose: "review", priority: 1 }), f.env);
    expect(response?.status).toBe(method === "POST" ? 201 : 200);
    expect(f.forwarded).toHaveBeenCalledOnce();
  });

  it("allows a name-only PATCH even when the selected profile was subsequently deleted", async () => {
    const f = fixture({ deleted: true });
    expect((await handleWebSessions(f.request("PATCH", undefined), f.env))?.status).toBe(200);
    expect(f.queries).toEqual([]);
    expect(f.forwarded).toHaveBeenCalledOnce();
  });

  it("keeps authentication ahead of profile lookup", async () => {
    const f = fixture();
    const request = new Request("https://public.example/api/sessions", {
      method: "POST",
      body: JSON.stringify({ metadata: { customAgentId: AGENT_ID } }),
    });
    expect((await handleWebSessions(request, f.env))?.status).toBe(401);
    expect(f.queries).toEqual([]);
    expect(f.forwarded).not.toHaveBeenCalled();
  });
});
