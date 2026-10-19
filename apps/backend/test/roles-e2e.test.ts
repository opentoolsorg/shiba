/**
 * T57 end-to-end proof (PLAN.md §19.3) — the full route a role-carrying task
 * takes, driven through the real orchestrator with the SHIPPED pin.
 *
 * The other roles tests assert `resolveRoleModel` in isolation and assert
 * against literals. This one does the thing that actually matters: POST a
 * role-carrying run to the real DO, read the approval record the DO minted,
 * and assert the pinned harness+model were FROZEN onto it. A pin that resolves
 * but is not frozen is the failure mode §18.0 already caught once (an input
 * field declared, consumed, and tested only at the unit level is dead), so the
 * assertion here is on the approval record, not on the resolver.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { CodingOrchestrator, type OrchestratorState } from "../src/agents/orchestrator.js";
import { harnessModelEnv, RETIRED_MODELS, resolveRoleModel } from "../src/agents/roles.js";
import { HARNESS_DEFAULT_MODELS, resolveHarness } from "../src/harness/index.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";
import { AGENT_ROLES } from "@shiba/shared";
import { setSandboxHandleResolver } from "../src/sandbox/lifecycle.js";

const mocks = vi.hoisted(() => ({
  destroy: vi.fn(),
  execute: vi.fn(),
  keepAliveWhile: vi.fn((fn: () => Promise<unknown>) => fn()),
  schedule: vi.fn(async (..._args: unknown[]) => ({})),
}));

vi.mock("@cloudflare/think", () => ({
  Think: class {
    onStart() {}
    getTools() { return {}; }
    onRequest() { return new Response(null, { status: 404 }); }
    keepAliveWhile(fn: () => Promise<unknown>) { return mocks.keepAliveWhile(fn); }
    schedule(...args: unknown[]) { return mocks.schedule(...args); }
  },
}));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: mocks.execute }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
setSandboxHandleResolver(() => ({ destroy: mocks.destroy }));

/** Drop `//` and block comments outside strings, then trailing commas — same passes as scripts/check-alchemy-drift.mjs. */
function parseJsonc(text: string): unknown {
  const uncommented = text.replace(/"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith('"') ? m : ""));
  return JSON.parse(uncommented.replace(/"(?:[^"\\]|\\.)*"|,(\s*[}\]])/g, (m, tail?: string) => tail ?? m));
}

/** The pin as shipped: vars.ROLE_MODEL_MAP parsed from the real wrangler.jsonc, not restated. */
const WRANGLER = parseJsonc(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")) as {
  vars?: { ROLE_MODEL_MAP?: string };
};
const SHIPPED_RAW = WRANGLER.vars?.ROLE_MODEL_MAP;
// Absent pin is the regression under test, not a crash: {} lets the suite load and report which role lost its route.
const SHIPPED_MAP = (SHIPPED_RAW === undefined ? {} : JSON.parse(SHIPPED_RAW)) as Record<
  string,
  { harness: string; model: string }
>;

function env(overrides: Partial<Env> = {}): Env {
  return { ...productionEnvStubs(), ROLE_MODEL_MAP: JSON.stringify(SHIPPED_MAP), ...overrides } as Env;
}

function agent(overrides: Partial<Env> = {}) {
  return Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    env: env(overrides),
    state: { runs: [] } as OrchestratorState,
    setState(state: OrchestratorState) { setStateLikeProduction(this, state); },
  });
}

function queue(instance: CodingOrchestrator, body: Record<string, unknown>) {
  return instance.onRequest(
    new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.destroy.mockResolvedValue(undefined);
});

describe("shipped wrangler.jsonc ROLE_MODEL_MAP", () => {
  it("resolves every AGENT_ROLES entry through resolveRoleModel", () => {
    // A typo in the shipped pin (role key, harness, or provider) must fail CI here.
    expect(SHIPPED_RAW, "vars.ROLE_MODEL_MAP missing from wrangler.jsonc").toBeTypeOf("string");
    for (const role of AGENT_ROLES) {
      expect(resolveRoleModel(env(), role), `role ${role} must resolve`).toEqual(SHIPPED_MAP[role]);
    }
  });
});

describe("shipped role pin reaches the approval record (PLAN.md §19)", () => {
  it("freezes the pinned harness + model onto the pending approval, per role", async () => {
    for (const role of AGENT_ROLES) {
      const instance = agent();
      const res = await queue(instance, {
        repoUrl: "https://github.com/o/r",
        task: `work for ${role}`,
        role,
      });
      expect(res.status, `queueing role ${role} must be accepted`).toBe(200);

      const approvals = instance.state.pendingApprovals ?? [];
      expect(approvals, `role ${role} must mint exactly one approval`).toHaveLength(1);

      const record = approvals[0]!;
      const expected = SHIPPED_MAP[role]!;
      // The approval record is what a human reads and what dispatch executes.
      // Assert the pin landed there — not merely that the resolver returned it.
      expect(record.route?.harness, `role ${role} harness not frozen`).toBe(expected.harness);
      expect(record.route?.modelId, `role ${role} model not frozen`).toBe(expected.model);
    }
  });

  it("freezes Pi's own default model instead of CODING_MODEL", async () => {
    const instance = agent({ ROLE_MODEL_MAP: undefined, CODING_MODEL: "google/gemini-3.5-flash-lite" });
    const res = await queue(instance, {
      repoUrl: "https://github.com/o/r",
      task: "fix",
      harness: "pi",
    });
    expect(res.status).toBe(200);
    const record = (instance.state.pendingApprovals ?? [])[0]!;
    expect(record.route?.harness).toBe("pi");
    expect(record.route?.modelId).toBe("anthropic/claude-sonnet-4-6");
  });

  it("freezes the PI_MODEL deployment override", async () => {
    const piEnv = Object.assign({ ROLE_MODEL_MAP: undefined }, { PI_MODEL: "openai/gpt-5" });
    const instance = agent(piEnv);
    const res = await queue(instance, {
      repoUrl: "https://github.com/o/r",
      task: "fix",
      harness: "pi",
    });
    expect(res.status).toBe(200);
    const record = (instance.state.pendingApprovals ?? [])[0]!;
    expect(record.route?.harness).toBe("pi");
    expect(record.route?.modelId).toBe("openai/gpt-5");
  });

  it("freezes the deployment default route for an unpinned deployment, not the shipped pin", async () => {
    // Negative control in-process: with no pin, the DO must fall through to the
    // deployment default rather than inventing a route from the shipped map.
    const instance = agent({ ROLE_MODEL_MAP: undefined });
    const res = await queue(instance, {
      repoUrl: "https://github.com/o/r",
      task: "fix",
      role: "fixer",
    });
    expect(res.status).toBe(200);
    const record = (instance.state.pendingApprovals ?? [])[0]!;
    // The default chain, derived through the same seams resolveHarnessAndModel
    // uses — rolePick null → AGENT_HARNESS else "opencode", then the per-harness
    // *_MODEL var else HARNESS_DEFAULT_MODELS. Deriving the expectation from
    // those tables (not a literal) keeps this honest when the defaults move.
    const expectedHarness = resolveHarness(
      instance.env.AGENT_HARNESS?.trim() ?? "opencode",
      instance.env,
    ).name;
    const expectedModel =
      harnessModelEnv(instance.env, expectedHarness) ?? HARNESS_DEFAULT_MODELS[expectedHarness];
    // Positive assertion: the route must be FROZEN on the record and must be
    // the resolved deployment default — an absent route fails loudly here.
    expect(record.route).toBeDefined();
    expect(record.route?.harness).toBe(expectedHarness);
    expect(record.route?.modelId).toBe(expectedModel);
    // The implicit default carries no connection; the shipped fixer pin must
    // not have leaked into the frozen route.
    expect(record.route?.connectionId).toBeNull();
    expect(record.route?.modelId).not.toBe(SHIPPED_MAP.fixer!.model);
  });

  it("rejects a role-carrying request when the pin is broken, before any approval", async () => {
    // A malformed map must fail at intake — never mint an approval the human
    // could approve and then watch die inside a container.
    const instance = agent({
      ROLE_MODEL_MAP: JSON.stringify({ fixer: { harness: "codex", model: "anthropic/claude-opus-5-5" } }),
    });
    const res = await queue(instance, {
      repoUrl: "https://github.com/o/r",
      task: "fix",
      role: "fixer",
    });
    expect(res.status).toBe(400);
    expect(instance.state.pendingApprovals ?? []).toHaveLength(0);
  });

  it("rejects a pin naming a retired model at intake, before any approval", async () => {
    RETIRED_MODELS.add(SHIPPED_MAP.orchestrator!.model);
    try {
      const instance = agent();
      const res = await queue(instance, { repoUrl: "https://github.com/o/r", task: "plan", role: "orchestrator" });
      expect(res.status).toBe(400);
      expect(await res.text()).toMatch(/retired/);
      expect(instance.state.pendingApprovals ?? []).toHaveLength(0);
    } finally {
      RETIRED_MODELS.delete(SHIPPED_MAP.orchestrator!.model);
    }
  });
});
