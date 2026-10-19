/**
 * Route freeze/revalidate is the approval-gate seam: an admissible route is
 * minted at queue time, and a connection revoked between approve and
 * dispatch must fail the run — never substitute another model.
 */
import { describe, expect, it } from "vitest";
import {
  EMPTY_POLICY,
  validateConnectionModel,
  validatePolicyModels,
  type ApprovedRoute,
  type Connection,
} from "../src/model-connections.js";
import {
  resolveCodingRoute,
  resolvePurposeModel,
  revalidateCodingRoute,
  type ModelConfigSnapshot,
} from "../src/model-policy.js";

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "conn_anthropic",
    owner: "deployment",
    service: "anthropic",
    authMode: "gateway-byok",
    status: "ready",
    displayName: "Anthropic BYOK",
    credentialRef: "anthropic-byok",
    createdAt: 0,
    updatedAt: 0,
    lastCheckedAt: null,
    ...overrides,
  };
}

function snapshot(connections: Connection[] = []): ModelConfigSnapshot {
  return { connections, policy: EMPTY_POLICY, connectionOrder: connections.map((c) => c.id) };
}

describe("resolveCodingRoute", () => {
  it("uses the implicit deployment default when no connection is requested", () => {
    const route = resolveCodingRoute(snapshot(), {
      model: "anthropic/claude-sonnet-4-6",
      harness: "claude-code",
    });
    expect(route).toEqual({
      purpose: "coding",
      connectionId: null,
      modelId: "anthropic/claude-sonnet-4-6",
      harness: "claude-code",
      policyVersion: 0,
    });
  });

  it("resolves a named connection to its id", () => {
    const route = resolveCodingRoute(snapshot([connection()]), {
      connectionId: "conn_anthropic",
      model: "anthropic/claude-sonnet-4-6",
      harness: "claude-code",
    });
    expect(route.connectionId).toBe("conn_anthropic");
  });

  it("throws on an unknown connection id", () => {
    expect(() =>
      resolveCodingRoute(snapshot(), {
        connectionId: "conn_missing",
        model: "anthropic/claude-sonnet-4-6",
        harness: "claude-code",
      }),
    ).toThrow(/Unknown model connection/);
  });

  it("throws on a disabled connection", () => {
    expect(() =>
      resolveCodingRoute(snapshot([connection({ status: "disabled" })]), {
        connectionId: "conn_anthropic",
        model: "anthropic/claude-sonnet-4-6",
        harness: "claude-code",
      }),
    ).toThrow(/disabled/);
  });

  it("throws when the model is outside the connection's namespace", () => {
    expect(() =>
      resolveCodingRoute(snapshot([connection()]), {
        connectionId: "conn_anthropic",
        model: "openai/gpt-5",
        harness: "codex",
      }),
    ).toThrow(/does not belong to the anthropic connection/);
  });

  it("throws when the harness cannot run the provider", () => {
    expect(() =>
      resolveCodingRoute(snapshot([connection()]), {
        connectionId: "conn_anthropic",
        model: "anthropic/claude-sonnet-4-6",
        harness: "codex",
      }),
    ).toThrow(/codex harness cannot run anthropic models/);
  });
});

describe("revalidateCodingRoute", () => {
  const frozen: ApprovedRoute = {
    purpose: "coding",
    connectionId: "conn_anthropic",
    modelId: "anthropic/claude-sonnet-4-6",
    harness: "claude-code",
    policyVersion: 0,
  };

  it("passes a null-connection (implicit) route unconditionally", () => {
    expect(revalidateCodingRoute(snapshot(), { ...frozen, connectionId: null })).toBeNull();
  });

  it("passes a still-admissible route", () => {
    expect(revalidateCodingRoute(snapshot([connection()]), frozen)).toBeNull();
  });

  it("fails when the approved connection was deleted", () => {
    expect(revalidateCodingRoute(snapshot(), frozen)).toMatch(/no longer exists/);
  });

  it("fails when the approved connection was disabled after approval", () => {
    expect(
      revalidateCodingRoute(snapshot([connection({ status: "disabled" })]), frozen),
    ).toMatch(/disabled/);
  });
});

describe("purpose policy accepts the fleet purposes", () => {
  it("accepts review, plan, and ui as Workers AI models", () => {
    const result = validatePolicyModels({
      review: "@cf/meta/llama-3.1-8b-instruct",
      plan: "@cf/meta/llama-3.1-8b-instruct",
      ui: "@cf/meta/llama-3.1-8b-instruct",
    });
    expect(result).toEqual({
      models: {
        review: "@cf/meta/llama-3.1-8b-instruct",
        plan: "@cf/meta/llama-3.1-8b-instruct",
        ui: "@cf/meta/llama-3.1-8b-instruct",
      },
    });
  });

  it("still refuses coding, intent, and quality in the policy", () => {
    expect(validatePolicyModels({ coding: "@cf/x/y" })).toMatchObject({ error: expect.any(String) });
    expect(validatePolicyModels({ intent: "@cf/x/y" })).toMatchObject({ error: expect.any(String) });
    expect(validatePolicyModels({ quality: "@cf/x/y" })).toMatchObject({ error: expect.any(String) });
  });
});

describe("resolvePurposeModel", () => {
  it("prefers the policy model for a purpose", () => {
    const policy = { ...EMPTY_POLICY, models: { review: "@cf/a/policy-model" } };
    expect(resolvePurposeModel(policy, "review", { ORCHESTRATOR_MODEL: "@cf/a/orch", REVIEW_MODEL: "@cf/a/rev" })).toBe(
      "@cf/a/policy-model",
    );
  });

  it("falls back to the purpose-specific env var", () => {
    expect(resolvePurposeModel(EMPTY_POLICY, "review", { ORCHESTRATOR_MODEL: "@cf/a/orch", REVIEW_MODEL: "@cf/a/rev" })).toBe(
      "@cf/a/rev",
    );
    expect(resolvePurposeModel(EMPTY_POLICY, "plan", { ORCHESTRATOR_MODEL: "@cf/a/orch", PLAN_MODEL: "@cf/a/plan" })).toBe(
      "@cf/a/plan",
    );
    expect(resolvePurposeModel(EMPTY_POLICY, "ui", { ORCHESTRATOR_MODEL: "@cf/a/orch", UI_MODEL: "@cf/a/ui" })).toBe(
      "@cf/a/ui",
    );
  });

  it("falls back to ORCHESTRATOR_MODEL then the built-in default", () => {
    expect(resolvePurposeModel(EMPTY_POLICY, "review", { ORCHESTRATOR_MODEL: "@cf/a/orch" })).toBe("@cf/a/orch");
    expect(resolvePurposeModel(EMPTY_POLICY, "plan", {})).toBe("@cf/zai-org/glm-4.7-flash");
  });
});

describe("grok and luan connections", () => {
  it("validates grok models inside the xai namespace", () => {
    const conn = connection({ service: "grok", displayName: "Grok BYOK", credentialRef: "grok-byok" });
    expect(validateConnectionModel(conn, "xai/grok-4.6", "grok")).toBeNull();
    expect(validateConnectionModel(conn, "xai/grok-4.6", "opencode")).toBeNull();
    expect(validateConnectionModel(conn, "openai/gpt-5", "grok")).toMatch(/does not belong to the xai connection/);
  });

  it("validates luan models inside the opencode-go namespace", () => {
    const conn = connection({ service: "luan", displayName: "Luan fleet", credentialRef: "luan-byok" });
    expect(validateConnectionModel(conn, "opencode-go/deepseek-v3.2", "opencode")).toBeNull();
    expect(validateConnectionModel(conn, "xai/grok-4.6", "opencode")).toMatch(
      /does not belong to the opencode-go connection/,
    );
  });

  it("routes through resolveCodingRoute like any other connection", () => {
    const route = resolveCodingRoute(
      snapshot([connection({ id: "conn_grok", service: "grok" })]),
      { connectionId: "conn_grok", model: "xai/grok-4.6", harness: "grok" },
    );
    expect(route.connectionId).toBe("conn_grok");
    expect(route.modelId).toBe("xai/grok-4.6");
  });
});
