import { describe, expect, it, vi } from "vitest";
import { resolveBetterAuthUserId, type BetterAuthLaneEnv } from "@shiba/auth/better-auth";

describe("better-auth cold path", () => {
  it("does not touch D1 when no session cookie is present", async () => {
    let d1Calls = 0;
    const db = {
      prepare: (sql: string) => {
        d1Calls += 1;
        return {
          bind: () => ({
            async first() {
              return null;
            },
            async run() {
              return {};
            },
          }),
        };
      },
    } as unknown as D1Database;
    const env: BetterAuthLaneEnv = { AGENT_AUDIT: db, BETTER_AUTH_SECRET: "x".repeat(32) };
    const request = new Request("https://example.test/api/whoami");
    const userId = await resolveBetterAuthUserId(request, env);
    expect(userId).toBeNull();
    expect(d1Calls).toBe(0);
  });
});