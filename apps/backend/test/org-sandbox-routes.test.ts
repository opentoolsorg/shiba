import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { handleOrgSandboxSettings } from "../src/org-sandbox-routes.js";

vi.mock("../src/request-auth.js", () => ({
  isAuthorizedRequest: vi.fn(async () => true),
}));

function mockD1(): D1Database {
  const settings = new Map<string, Record<string, unknown>>();
  const stmt = (sql: string, args: unknown[] = []) => ({
    async run() {
      if (
        sql.includes("CREATE TABLE") ||
        sql.includes("audit_log") ||
        sql.includes("CREATE INDEX")
      ) {
        return { success: true };
      }
      if (sql.includes("INSERT INTO org_sandbox_settings")) {
        settings.set(String(args[0]), {
          org_id: args[0],
          provider_id: args[1],
          computesdk_backend: args[2],
          updated_at: args[3],
        });
      }
      return { success: true };
    },
    async first() {
      if (sql.includes("org_sandbox_settings")) {
        return settings.get(String(args[0])) ?? null;
      }
      return null;
    },
  });
  const prepare = (sql: string) => ({
    ...stmt(sql),
    bind(...args: unknown[]) {
      return stmt(sql, args);
    },
  });
  return { prepare } as unknown as D1Database;
}

function envWithAudit(): Env {
  return {
    AGENT_AUDIT: mockD1(),
    SHIBA_SANDBOX_PROVIDER: "cloudflare",
    Sandbox: {} as unknown,
  } as Env;
}

describe("handleOrgSandboxSettings", () => {
  it("GET returns provider catalog", async () => {
    const res = await handleOrgSandboxSettings(
      new Request("https://x/api/org/sandbox"),
      envWithAudit(),
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { ok?: boolean; providers?: unknown[] };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.providers)).toBe(true);
  });

  it("PATCH requires providerId", async () => {
    const res = await handleOrgSandboxSettings(
      new Request("https://x/api/org/sandbox", { method: "PATCH", body: "{}" }),
      envWithAudit(),
    );
    expect(res?.status).toBe(400);
  });
});
