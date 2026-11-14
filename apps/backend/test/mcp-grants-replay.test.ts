import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import {
  detectMcpGrantRefreshReplay,
  noteRotatedRefreshHash,
  upsertOAuthMcpGrant,
} from "../src/mcp-grants.js";
import { externalMcpD1 } from "./fixtures/external-mcp-schema.js";
import { sha256Hex } from "../src/agent-tokens.js";

describe("mcp grant refresh replay", () => {
  it("revokes grant when a rotated refresh hash is replayed", async () => {
    const { database: AGENT_AUDIT, sqlite } = externalMcpD1();
    const env = { AGENT_AUDIT } as unknown as Env;
    const grant = await upsertOAuthMcpGrant(env, {
      userId: "owner@example.test",
      clientId: "shc_test",
      clientName: "Inspector",
    });
    const hash = await sha256Hex("shr_replay_token");
    await noteRotatedRefreshHash(env, { grantId: grant.id, refreshHash: hash });
    expect(await detectMcpGrantRefreshReplay(env, { refreshHash: hash })).toBe(true);
    const row = sqlite.prepare("SELECT revoked_at FROM mcp_grants WHERE id = ?").get(grant.id) as { revoked_at: number };
    expect(row.revoked_at).toBeGreaterThan(0);
  });
});