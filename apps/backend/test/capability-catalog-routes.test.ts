import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { handleCapabilityCatalog } from "../src/capability-catalog-routes.js";

describe("GET /api/capabilities", () => {
  it("requires a verified dashboard identity and returns bounded metadata without schemas or grants", async () => {
    const env = { REQUIRE_ACCESS: true } as unknown as Env;
    const denied = await handleCapabilityCatalog(new Request("https://shiba.test/api/capabilities"), env);
    expect(denied?.status).toBe(401);

    const response = await handleCapabilityCatalog(new Request("https://shiba.test/api/capabilities?limit=3", {
      headers: { "CF-Access-Authenticated-User-Email": "owner@example.test" },
    }), env);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    const directory = await response!.json() as {
      entries: Array<Record<string, unknown>>; returned: number; truncated: boolean; liveChecksPerformed: boolean;
    };
    expect(directory.returned).toBe(3);
    expect(directory.truncated).toBe(true);
    expect(directory.liveChecksPerformed).toBe(false);
    expect(directory.entries.every((entry) => entry.allowed === false && !("inputSchema" in entry))).toBe(true);
    expect(directory.entries.every((entry) => typeof entry.requiredScope === "string" && typeof entry.writeEffect === "string")).toBe(true);
  });

  it("rejects mutation methods and invalid bounds", async () => {
    const env = { REQUIRE_ACCESS: true } as unknown as Env;
    const headers = { "CF-Access-Authenticated-User-Email": "owner@example.test" };
    expect((await handleCapabilityCatalog(new Request("https://shiba.test/api/capabilities", { method: "POST", headers }), env))?.status).toBe(405);
    expect((await handleCapabilityCatalog(new Request("https://shiba.test/api/capabilities?limit=0", { headers }), env))?.status).toBe(400);
  });
});

describe("GET /api/capabilities/invocations", () => {
  it("requires dashboard auth and returns only the self-hosted sanitized receipts", async () => {
    const authOnly = { REQUIRE_ACCESS: true } as unknown as Env;
    expect((await handleCapabilityCatalog(new Request("https://shiba.test/api/capabilities/invocations"), authOnly))?.status).toBe(401);
    const calls: string[] = [];
    const db = {
      prepare(sql: string) {
        calls.push(sql);
        return {
          run: async () => ({ success: true, results: [], meta: { changes: 1 } }),
          bind: (...params: unknown[]) => ({
            run: async () => ({ success: true, results: [], meta: { changes: 1 } }),
            all: async () => ({ results: [{
              invocation_id: "inv-1", created_at: 100, updated_at: 200,
              principal: "local-agent", tool: "send_email", args_hash: "a".repeat(64),
              status: "pending_approval", approval_id: "approval-1", error_code: null,
            }], success: true, meta: { changes: 0 } }),
          }),
        };
      },
    };
    const env = { REQUIRE_ACCESS: true, AGENT_AUDIT: db } as unknown as Env;
    const response = await handleCapabilityCatalog(new Request("https://shiba.test/api/capabilities/invocations?limit=10", {
      headers: { "CF-Access-Authenticated-User-Email": "owner@example.test" },
    }), env);
    expect(response?.status).toBe(200);
    const body = await response!.json() as { entries: Array<Record<string, unknown>> };
    expect(body.entries[0]).toMatchObject({ invocationId: "inv-1", status: "pending_approval", approvalId: "approval-1" });
    expect(JSON.stringify(body)).not.toContain("to@example.test");
    expect(calls.some((sql) => sql.includes("WHERE org_id = ?"))).toBe(true);
  });
});
