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
