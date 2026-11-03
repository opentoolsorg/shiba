import { describe, expect, it, beforeEach } from "vitest";
import {
  getIntegrationProvider,
  resetIntegrationProviderCacheForTests,
} from "../src/integrations/runtime.js";
import { integrationsProviderIdSchema } from "@shiba/shared";
import type { Env } from "../src/env.js";

function env(partial: Partial<Env> = {}): Env {
  return {
    GATEWAY_ID: "default",
    ORCHESTRATOR_MODEL: "m",
    CODING_MODEL: "m",
    RUNTIME: "sandbox",
    CodingOrchestrator: {} as Env["CodingOrchestrator"],
    OpenCodeAgent: {} as Env["OpenCodeAgent"],
    Sandbox: {} as Env["Sandbox"],
    Automations: {} as Env["Automations"],
    Mailbox: {} as Env["Mailbox"],
    Memory: {} as Env["Memory"],
    Waitlist: {} as Env["Waitlist"],
    MEMORY_VECTORS: {} as Env["MEMORY_VECTORS"],
    ATTACHMENTS: {} as Env["ATTACHMENTS"],
    AGENT_TOKENS: {} as Env["AGENT_TOKENS"],
    AGENT_AUDIT: {} as Env["AGENT_AUDIT"],
    ASSETS: {} as Env["ASSETS"],
    AI: {} as Env["AI"],
    ModelConfig: {} as Env["ModelConfig"],
    ...partial,
  } as Env;
}

describe("integrations provider factory", () => {
  beforeEach(() => {
    resetIntegrationProviderCacheForTests();
  });

  it("defaults to openconnector without integration credentials", () => {
    expect(getIntegrationProvider(env()).id).toBe("openconnector");
  });

  it("initializes the default provider without integration credentials", async () => {
    const provider = getIntegrationProvider(env());
    expect(await provider.health()).toMatchObject({ provider: "openconnector", status: "unconfigured" });
  });

  it("uses the default for unrecognized provider values", () => {
    expect(getIntegrationProvider(env({ INTEGRATIONS_PROVIDER: "unknown" })).id).toBe("openconnector");
  });

  it("reuses the provider for the same environment and isolates credential changes", () => {
    const firstEnv = env();
    const first = getIntegrationProvider(firstEnv);
    expect(getIntegrationProvider(firstEnv)).toBe(first);
    expect(getIntegrationProvider(env({ OPEN_CONNECTOR_ADMIN_TOKEN: "key" }))).not.toBe(first);
  });
});

describe("integrations provider contract", () => {
  it("allows only openconnector", () => {
    expect(integrationsProviderIdSchema.options).toEqual(["openconnector"]);
    expect(integrationsProviderIdSchema.safeParse("unknown").success).toBe(false);
  });
});
