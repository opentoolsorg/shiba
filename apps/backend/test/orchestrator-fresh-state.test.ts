import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { productionEnvStubs } from "./orchestrator-host.js";

vi.mock("@cloudflare/think", () => ({ Think: class { getTools() { return {}; } } }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("../src/agents/specialists/tools.js", () => ({ createSpecialistTools: () => ({}) }));

import { CodingOrchestrator } from "../src/agents/orchestrator.js";

const coderInput = { agent: "coder", goal: "Fix source", context: { repoUrl: "https://github.com/o/r", context: "Keep approvals." } };
const options = { toolCallId: "fresh-coder", messages: [], context: {} };

function freshHost(persistState: boolean) {
  const queueSlackRun = vi.fn(async () => Response.json({ approvalId: "human-pending" }));
  const instance = Object.assign(Object.create(CodingOrchestrator.prototype) as object, {
    env: { ...productionEnvStubs() } as unknown as Env,
    name: "session:private",
    messages: [{ role: "user", id: "turn", metadata: {} }],
    queueSlackRun,
    setState(state: unknown) { if (persistState) Object.assign(this, { state }); },
  }) as unknown as CodingOrchestrator;
  return { instance, queueSlackRun };
}

describe("production orchestrator on a first turn with no state yet", () => {
  it("queues a delegated coder task and passes no canvas origin", async () => {
    const { instance, queueSlackRun } = freshHost(true);
    const result = await (instance.getTools().delegate_task as { execute?: (input: unknown, options: unknown) => Promise<unknown> })
      .execute?.(coderInput, options);
    expect(result).toMatchObject({ agent: "coder", status: "awaiting_approval" });
    expect(queueSlackRun.mock.calls[0]?.slice(2)).toEqual([undefined, undefined]);
  });

  it("still queues when the Durable Object has written no state at all", async () => {
    const { instance, queueSlackRun } = freshHost(false);
    const result = await (instance.getTools().delegate_task as { execute?: (input: unknown, options: unknown) => Promise<unknown> })
      .execute?.(coderInput, options);
    expect(result).toMatchObject({ agent: "coder", status: "awaiting_approval" });
    expect(queueSlackRun).toHaveBeenCalledOnce();
  });
});
