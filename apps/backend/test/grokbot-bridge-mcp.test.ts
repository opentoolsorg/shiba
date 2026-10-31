import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../src/mcp-gateway.js";
import { registerGrokbotBridgeTools } from "../src/mcp-grokbot-bridge-tools.js";
import type { Env } from "../src/env.js";
import type { TokenRecord } from "../src/agent-tokens.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

describe("grokbot bridge MCP tools", () => {
  it("round-trips queue → status → complete for the calling principal", async () => {
    const db = customAgentD1().database;
    const env = { AGENT_AUDIT: db } as unknown as Env;
    const registry = createToolRegistry(env);
    registerGrokbotBridgeTools(registry, env);
    const principal: TokenRecord = {
      kind: "agent",
      principal: "grok-bot",
      orgId: "self-hosted",
      scopes: ["sandbox:exec", "runs:read"],
      created: 1,
      revoked: false,
    };
    const ctx = { env, principal };
    const byName = (name: string) => registry.tools().find((tool) => tool.name === name)!;

    await expect(byName("queue_grokbot_bridge_task").handler({ founderSkillId: "founder-hubspot-stripe-reconcile" }, { env, principal: { ...principal, orgId: "other-org" } })).rejects.toThrow("self-hosted");
    const spoofed = await byName("queue_grokbot_bridge_task").handler({ founderSkillId: "founder-stripe-revenue-pulse", automationId: "spoofed" }, { env, principal: { ...principal, principal: "automation:spoofed" } });
    await expect(byName("grokbot_bridge_status").handler({ taskId: spoofed.structuredContent?.taskId }, ctx)).rejects.toThrow("not found");
    const queued = await byName("queue_grokbot_bridge_task").handler({
      founderSkillId: "founder-stripe-revenue-pulse",
      payload: { smoke: true },
    }, ctx);
    const queuedPayload = (queued.structuredContent ?? JSON.parse(String((queued.content[0] as { text: string }).text))) as { taskId: string; status: string };
    expect(queuedPayload.status).toBe("queued");
    expect(queuedPayload.taskId).toMatch(/^gbt-/);

    const otherCtx = { env, principal: { ...principal, principal: "another-bot" } };
    await expect(byName("grokbot_bridge_status").handler({ taskId: queuedPayload.taskId }, otherCtx)).rejects.toThrow("not found");
    const pendingList = await byName("grokbot_bridge_status").handler({}, ctx);
    expect(pendingList.structuredContent).toMatchObject({ tasks: [{ taskId: queuedPayload.taskId }] });

    const statusQueued = await byName("grokbot_bridge_status").handler({ taskId: queuedPayload.taskId }, ctx);
    expect(statusQueued.structuredContent ?? JSON.parse(String((statusQueued.content[0] as { text: string }).text))).toMatchObject({ status: "queued", taskId: queuedPayload.taskId });

    const completed = await byName("complete_grokbot_bridge_task").handler({
      taskId: queuedPayload.taskId,
      result: { mrrUsd: 99_000 },
      postSlack: false,
    }, ctx);
    const done = (completed.structuredContent ?? JSON.parse(String((completed.content[0] as { text: string }).text))) as { status: string; result: { mrrUsd: number } };
    expect(done.status).toBe("completed");
    expect(done.result.mrrUsd).toBe(99_000);

    await expect(byName("complete_grokbot_bridge_task").handler({ taskId: queuedPayload.taskId, result: { replacement: true }, postSlack: false }, ctx)).rejects.toThrow("current state");
    const statusDone = await byName("grokbot_bridge_status").handler({ taskId: queuedPayload.taskId }, ctx);
    expect(statusDone.structuredContent ?? JSON.parse(String((statusDone.content[0] as { text: string }).text))).toMatchObject({ status: "completed" });
  });
});
