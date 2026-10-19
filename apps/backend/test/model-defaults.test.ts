import { describe, expect, it } from "vitest";
import { describeRoleModels } from "../src/agents/roles.js";
import type { Env } from "../src/env.js";
import { defaultCodingFromConnection, soleReadyConnection } from "../src/model-defaults.js";
import type { Connection } from "../src/model-connections.js";

function env(overrides: Partial<Env> = {}): Env {
  return {
    GATEWAY_ID: "default",
    ORCHESTRATOR_MODEL: "",
    CODING_MODEL: "google/gemini-3.5-flash-lite",
    ...overrides,
  } as Env;
}

const conn = (overrides: Partial<Connection> = {}): Connection => ({
  id: "conn_only",
  owner: "deployment",
  service: "anthropic",
  authMode: "gateway-byok",
  status: "ready",
  displayName: "Only",
  credentialRef: null,
  createdAt: 0,
  updatedAt: 0,
  lastCheckedAt: null,
  ...overrides,
});

describe("sole ready connection defaults", () => {
  it("routes every unpinned role through the single connection pair", () => {
    const connection = conn();
    const snapshot = {
      connections: [connection],
      policy: { version: 0, models: {}, updatedAt: 0 },
      connectionOrder: [connection.id],
    };
    expect(soleReadyConnection(snapshot)?.id).toBe("conn_only");
    const pair = defaultCodingFromConnection(connection);
    expect(pair).toEqual({ harness: "claude-code", model: "anthropic/claude-sonnet-4-6" });
    const rows = describeRoleModels(env(), undefined, snapshot);
    for (const row of rows) {
      expect(row.source).toBe("connection-default");
      expect(row.harness).toBe("claude-code");
      expect(row.connectionId).toBe("conn_only");
    }
  });

  it("does not apply when two ready connections exist", () => {
    const snapshot = {
      connections: [conn({ id: "a" }), conn({ id: "b", displayName: "B" })],
      policy: { version: 0, models: {}, updatedAt: 0 },
      connectionOrder: ["a", "b"],
    };
    expect(soleReadyConnection(snapshot)).toBeNull();
    const rows = describeRoleModels(env(), undefined, snapshot);
    expect(rows.every((r) => r.source === "default")).toBe(true);
  });
});
