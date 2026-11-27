import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { handleChiefOfStaffName } from "../src/chief-of-staff-name-routes.js";

const auth = vi.hoisted(() => ({ ok: true, user: "owner@example.test" as string | null }));
vi.mock("../src/request-auth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/request-auth.js")>(),
  isAuthorizedRequest: vi.fn(async () => auth.ok),
  resolveUserId: vi.fn(async () => auth.user),
}));

function db() {
  const rows = new Map<string, string>();
  return { prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({
    first: async () => (rows.has(String(args[0])) ? { name: rows.get(String(args[0])) } : null),
    run: async () => { if (sql.startsWith("INSERT")) rows.set(String(args[0]), String(args[1])); },
  }) }) } as unknown as D1Database;
}
const env = () => ({ AGENT_AUDIT: db() }) as Env;
const req = (method: string, body?: unknown) => new Request("https://x/api/chief-of-staff", {
  method, headers: { "content-type": "application/json", origin: "https://x" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

describe("personal chief-of-staff name", () => {
  it("returns null until set, then the trimmed saved name", async () => {
    const bindings = env();
    expect(await (await handleChiefOfStaffName(req("GET"), bindings))!.json()).toEqual({ name: null });
    const put = await handleChiefOfStaffName(req("PUT", { name: "  Ada  " }), bindings);
    expect(await put!.json()).toEqual({ name: "Ada" });
    expect(await (await handleChiefOfStaffName(req("GET"), bindings))!.json()).toEqual({ name: "Ada" });
  });

  it.each(["", "   ", "x".repeat(41), 7, "a\u0007b", "a\nb", "a\u202Eb", "a\u2069b"])("rejects invalid name %j", async (name) => {
    expect((await handleChiefOfStaffName(req("PUT", { name }), env()))!.status).toBe(400);
  });

  it("requires a human session", async () => {
    auth.ok = false;
    expect((await handleChiefOfStaffName(req("GET"), env()))!.status).toBe(401);
    auth.ok = true;
  });
});
