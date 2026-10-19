import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { runSetupDoctor } from "../src/setup-doctor.js";
import { readSetupStatus } from "../src/setup-status.js";
import { assertRunPreflight } from "../src/run-preflight.js";
import { resolveCodingRoute } from "../src/model-policy.js";
import type { Connection } from "../src/model-connections.js";

function env(overrides: Partial<Env> = {}): Env {
  return {
    GATEWAY_ID: "default",
    ORCHESTRATOR_MODEL: "",
    CODING_MODEL: "google/gemini-3.5-flash-lite",
    AI_GATEWAY_TOKEN: "gateway-token",
    AGENT_TOKENS: {
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
      list: async () => ({ keys: [] }),
    } as unknown as KVNamespace,
    ...overrides,
  } as Env;
}

const readyAnthropic = (id = "conn_a"): Connection => ({
  id,
  owner: "deployment",
  service: "anthropic",
  authMode: "gateway-byok",
  status: "ready",
  displayName: "Anthropic",
  credentialRef: "byok-anthropic",
  createdAt: 1,
  updatedAt: 1,
  lastCheckedAt: 1,
});

describe("runSetupDoctor", () => {
  it("marks gateway-backed roles ok when AI_GATEWAY_TOKEN is set", async () => {
    const status = await readSetupStatus(env(), false);
    const report = await runSetupDoctor(env(), { gateway: status.gateway });
    expect(report.roles.every((r) => r.ok)).toBe(true);
    expect(report.ok).toBe(true);
  });

  it("flags subscription harnesses without succeeded auth", async () => {
    const subEnv = env({
      SHIBA_CODEX_SUBSCRIPTION: "1",
      CODEX_SUBSCRIPTION_AUTH_JSON: "{}",
      ROLE_MODEL_MAP: JSON.stringify({
        reviewer: { harness: "codex-subscription", model: "openai-subscription/gpt-5.3-codex" },
      }),
    });
    const status = await readSetupStatus(subEnv, false);
    const report = await runSetupDoctor(subEnv, { gateway: status.gateway });
    const reviewer = report.roles.find((r) => r.role === "reviewer");
    expect(reviewer?.ok).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.severity === "error")).toBe(true);
  });
});

describe("assertRunPreflight", () => {
  it("refuses codex-subscription before queue when auth never succeeded", async () => {
    const snapshot = { connections: [], policy: { version: 0, models: {}, updatedAt: 0 }, connectionOrder: [] };
    const route = resolveCodingRoute(snapshot, {
      connectionId: null,
      model: "openai-subscription/gpt-5.3-codex",
      harness: "codex-subscription",
    });
    await expect(
      assertRunPreflight(
        env({ SHIBA_CODEX_SUBSCRIPTION: "1", CODEX_SUBSCRIPTION_AUTH_JSON: "{}" }),
        { harness: "codex-subscription", codingModel: "openai-subscription/gpt-5.3-codex", route },
        snapshot,
      ),
    ).rejects.toThrow(/no authenticated account/);
  });

  it("allows BYOK harness queue when verify standin is enabled without AI_GATEWAY_TOKEN", async () => {
    const snapshot = { connections: [], policy: { version: 0, models: {}, updatedAt: 0 }, connectionOrder: [] };
    const route = resolveCodingRoute(snapshot, {
      connectionId: null,
      model: "google/gemini-3.5-flash-lite",
      harness: "opencode",
    });
    await expect(
      assertRunPreflight(
        env({ SHIBA_VERIFY_STANDIN: "1" }),
        { harness: "opencode", codingModel: "google/gemini-3.5-flash-lite", route },
        snapshot,
      ),
    ).resolves.toBeUndefined();
  });

  it("binds the sole ready connection when model/harness match", async () => {
    const connection = readyAnthropic();
    const snapshot = {
      connections: [connection],
      policy: { version: 1, models: {}, updatedAt: 1 },
      connectionOrder: [connection.id],
    };
    const route = resolveCodingRoute(snapshot, {
      connectionId: null,
      model: "anthropic/claude-sonnet-4-6",
      harness: "claude-code",
    });
    expect(route.connectionId).toBe(connection.id);
  });
});
