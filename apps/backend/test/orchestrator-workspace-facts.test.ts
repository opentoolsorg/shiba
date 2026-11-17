import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { WorkspaceChannelFactsStore } from "../src/workspace-channel-facts.js";
import type { Env } from "../src/env.js";
import { CodingOrchestrator } from "../src/agents/orchestrator.js";

vi.mock("@cloudflare/think", () => ({ Think: class {} }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));

function host(env: Env, name = "slack:T1:C1:1.0") {
  return Object.assign(Object.create(CodingOrchestrator.prototype) as object, {
    env, name, messages: [], state: {}, employeeToolProfileId: () => undefined,
  }) as unknown as CodingOrchestrator;
}

describe("coordinator workspace facts system instructions", () => {
  it("loads facts into actual turn instructions without modifying the task or approval state", async () => {
    const f = customAgentD1({ bare: true });
    try {
      f.sqlite.exec(readFileSync(new URL("../migrations/0063_workspace_channel_facts.sql", import.meta.url), "utf8"));
      const saved = await new WorkspaceChannelFactsStore(f.database).remember({ teamId: "T1", connectionId: "legacy" }, "Alex owns billing", { createdBy: "user", sourceChannel: "C2" });
      const instance = host({ AGENT_AUDIT: f.database, SLACK_BOT_TOKEN: "fixture-token" } as Env);
      const system = instance.getSystemPrompt();
      expect(system).toContain("codemode.channel_remember");
      expect(system).toContain("codemode.channel_forget");
      const ctx = { system, tools: {} } as Parameters<CodingOrchestrator["beforeTurn"]>[0];
      const result = await instance.beforeTurn(ctx);
      expect(result.instructions).toContain("<workspace_facts>");
      expect(result.instructions).toContain(saved.id);
      expect(result.instructions).toContain("Alex owns billing");
      expect(ctx.system).toBe(system);
      expect(instance.state).toEqual({});
    } finally { f.sqlite.close(); }
  });

  it("leaves system instructions unchanged for missing or broken storage and non-Slack threads", async () => {
    for (const env of [{} as Env, { AGENT_AUDIT: { prepare: () => { throw new Error("offline"); } } } as unknown as Env]) {
      const result = await host(env).beforeTurn({ system: "original", tools: {} } as Parameters<CodingOrchestrator["beforeTurn"]>[0]);
      expect(result.instructions).toBe("original");
    }
    const instance = host({} as Env, "default");
    expect(instance.getSystemPrompt()).not.toContain("channel_remember");
    expect((await instance.beforeTurn({ system: "original", tools: {} } as Parameters<CodingOrchestrator["beforeTurn"]>[0])).instructions).toBe("original");
  });
});
