import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { forwardOpenAI, type EgressEnv } from "../src/egress.js";
import { HOSTED_PROVIDER_KILL_SWITCH_MESSAGE, isHostedProviderAccessStopped } from "../src/hosted-provider-kill-switch.js";
import { assertModelRunPreflight } from "../src/run-preflight.js";
import { readSetupStatus } from "../src/setup-status.js";
import { requireTeamModelPolicy } from "../src/team-model-store.js";
import { putUserProviderSecret } from "../src/user-provider-keys.js";

function env(overrides: Partial<Env> = {}): Env {
  const records = new Map<string, string>();
  return {
    GATEWAY_ID: "default",
    INTERNAL_SIGNING_KEY: "ab".repeat(32),
    ORCHESTRATOR_MODEL: "",
    CODING_MODEL: "google/gemini-3.5-flash-lite",
    AI_GATEWAY_TOKEN: "gateway-token",
    MODEL_CREDENTIAL_KEY: "ab".repeat(32),
    AGENT_TOKENS: {
      get: async (key: string) => records.get(key) ?? null,
      put: async (key: string, value: string) => { records.set(key, value); },
      delete: async () => undefined,
      list: async () => ({ keys: [] }),
    } as unknown as KVNamespace,
    ...overrides,
  } as Env;
}

const snapshot = { connections: [], policy: { version: 0, models: {}, updatedAt: 0 }, connectionOrder: [] };
const route = (harness: string, modelId: string) => ({ purpose: "coding" as const, connectionId: null, modelId, harness, policyVersion: 0 });
const STOPPED = { SHIBA_HOSTED_PROVIDER_KILL_SWITCH: "1" };

describe("hosted-provider kill switch", () => {
  it("is off unless an admin sets 1, true or on", () => {
    expect(isHostedProviderAccessStopped({})).toBe(false);
    expect(isHostedProviderAccessStopped({ SHIBA_HOSTED_PROVIDER_KILL_SWITCH: "0" })).toBe(false);
    for (const value of ["1", "true", " ON "]) expect(isHostedProviderAccessStopped({ SHIBA_HOSTED_PROVIDER_KILL_SWITCH: value })).toBe(true);
  });

  it("refuses a gateway-funded run at intake, before any approval is minted", async () => {
    const params = { harness: "opencode", codingModel: "google/gemini-3.5-flash-lite", route: route("opencode", "google/gemini-3.5-flash-lite") };
    await expect(assertModelRunPreflight(env(), params, snapshot)).resolves.toBeUndefined();
    await expect(assertModelRunPreflight(env(STOPPED), params, snapshot)).rejects.toThrow(HOSTED_PROVIDER_KILL_SWITCH_MESSAGE);
  });

  it("keeps user-funded lanes running: personal keys and paired local daemons", async () => {
    const configured = env({ ...STOPPED, AI_GATEWAY_TOKEN: "" });
    await putUserProviderSecret(configured, "personal-owner", "openai-api", crypto.randomUUID());
    await expect(assertModelRunPreflight(configured, {
      harness: "codex-acp", codingModel: "openai/gpt-5.3-codex", initiatorUserId: "personal-owner", route: route("codex-acp", "openai/gpt-5.3-codex"),
    }, snapshot)).resolves.toBeUndefined();
    await expect(assertModelRunPreflight(env(STOPPED), {
      harness: "claude-code", codingModel: "anthropic/claude-sonnet-4-6", route: route("claude-code", "anthropic/claude-sonnet-4-6"), runtime: "local",
    }, snapshot)).resolves.toBeUndefined();
  });

  it("refuses AI Gateway egress at the Worker without calling the provider", async () => {
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const egress = (stopped: boolean) => ({
        AI: { gateway: () => ({ getUrl: async () => "https://gateway.example.com/openai" }) } as unknown as EgressEnv["AI"],
        GATEWAY_ID: "default", AI_GATEWAY_TOKEN: "gw-token", ...(stopped ? STOPPED : {}),
      }) as EgressEnv;
      const request = () => new Request("https://api.openai.com/v1/responses", { method: "POST", body: "{}" });
      const refused = await forwardOpenAI(request(), egress(true));
      expect(refused.status).toBe(503);
      expect(await refused.text()).toBe(HOSTED_PROVIDER_KILL_SWITCH_MESSAGE);
      expect(fetchMock).not.toHaveBeenCalled();
      expect((await forwardOpenAI(request(), egress(false))).status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stops Workers AI team-model turns", () => {
    expect(() => requireTeamModelPolicy(env({ ...STOPPED, SHIBA_TEAM_MODEL_SESSIONS: "1" }))).toThrow("hosted_provider_access_disabled");
  });

  it("reports the stop on setup status and drops the gateway fallback route", async () => {
    const status = await readSetupStatus(env(STOPPED), false);
    expect(status.gateway.hostedAccessStopped).toBe(true);
    expect(status.modelRoute.via).not.toBe("gateway");
    expect((await readSetupStatus(env(), false)).gateway.hostedAccessStopped).toBe(false);
  });
});
