import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { answerUiBlock, getUiBlock } from "../src/ui-block-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { uiBlockRunId } from "../src/ui-block-scope.js";

vi.mock("@cloudflare/think", () => ({ Think: class { getTools() { return {}; } } }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("../src/agents/specialists/tools.js", () => ({ createSpecialistTools: () => ({}) }));

import { CodingOrchestrator } from "../src/agents/orchestrator.js";
import { createWebSession } from "../src/web-sessions.js";

const block = { version: 1, id: "next_step", type: "quick_replies", prompt: "Which step?", options: [{ id: "continue", label: "Continue" }] };
afterEach(() => vi.useRealTimers());

describe("production orchestrator ask_ui", () => {
  it("exposes an active Work tool and persists using the DO thread/run and authenticated owner", async () => {
    const { database, sqlite } = customAgentD1();
    try {
      sqlite.exec(readFileSync(new URL("../migrations/0068_ui_block_questions.sql", import.meta.url), "utf8"));
      const env = { AGENT_AUDIT: database } as unknown as Env;
      const ownerId = "owner@example.test";
      const session = createWebSession(ownerId);
      const runId = uiBlockRunId(session.agentName, "turn");
      const instance = Object.assign(Object.create(CodingOrchestrator.prototype) as object, {
        env, name: session.agentName, state: { runs: [] }, messages: [{ role: "user", id: "turn", metadata: {} }],
        approvedRunDelegate: () => ({}), employeeDraftStore: () => ({}),
        setState(state: unknown) { Object.assign(this, { state }); },
      }) as unknown as CodingOrchestrator;
      const tools = instance.getTools();
      expect(tools.ask_ui).toBeDefined();
      const turn = await instance.beforeTurn({ tools, system: "base" } as never);
      expect(turn.activeTools).toContain("ask_ui");
      const execute = tools.ask_ui!.execute as (input: unknown, options: unknown) => Promise<unknown>;
      vi.useFakeTimers();
      const waiting = execute(block, { toolCallId: "question-call", messages: [] });
      await vi.advanceTimersByTimeAsync(25_001);
      expect(await waiting).toMatchObject({ status: "pending", blockId: block.id });
      expect(await getUiBlock(env, ownerId, runId, block.id)).toMatchObject({ ownerId, runId, status: "pending", block });
      expect(await getUiBlock(env, "attacker", session.agentName, block.id)).toBeNull();
      await answerUiBlock(env, ownerId, runId, block.id, { blockId: block.id, optionIds: ["continue"] }, "web");
      expect(await execute(block, { toolCallId: "question-resume", messages: [] })).toMatchObject({ status: "answered", answer: { optionIds: ["continue"] } });
      expect(sqlite.prepare("SELECT count(*) AS n FROM ui_block_questions").get()).toEqual({ n: 1 });
      Object.assign(instance, { messages: [{ role: "user", id: "later-task", parts: [] }] });
      const later = execute(block, {});
      await vi.advanceTimersByTimeAsync(25_001);
      expect(await later).toMatchObject({ status: "pending" });
      expect(await getUiBlock(env, ownerId, uiBlockRunId(session.agentName, "later-task"), block.id)).toMatchObject({ status: "pending" });
      Object.assign(instance, { messages: [{ role: "user", id: "third-task", parts: [] }] });
      const third = execute(block, {});
      await vi.advanceTimersByTimeAsync(25_001);
      expect(await third).toMatchObject({ status: "pending" });
    } finally { sqlite.close(); }
  });

  it("does not derive owner identity from shared Slack conversations", async () => {
    const instance = Object.assign(Object.create(CodingOrchestrator.prototype) as object, {
      env: {}, name: "slack:T1:C1:123.000001", state: { runs: [] }, messages: [{ role: "user", id: "turn" }],
      approvedRunDelegate: () => ({}), employeeDraftStore: () => ({}),
    }) as unknown as CodingOrchestrator;
    const execute = instance.getTools().ask_ui!.execute as (input: unknown, options: unknown) => Promise<unknown>;
    expect(await execute(block, { toolCallId: "question-call", messages: [] })).toMatchObject({ isError: true, error: "ask_ui_requires_run" });
  });

  it.each(["slack:T1:C1:123.000001", "telegram:12345", "discord:123456789012345678"])("delivers a newly stored question once via postToThread for %s", async (name) => {
    const { database, sqlite } = customAgentD1();
    try {
      sqlite.exec(readFileSync(new URL("../migrations/0068_ui_block_questions.sql", import.meta.url), "utf8"));
      const ownerId = "chat-owner@example.test";
      const env = { AGENT_AUDIT: database, CHAT_EMPLOYEE_ACTOR: ownerId } as unknown as Env;
      const postToThread = vi.fn();
      const instance = Object.assign(Object.create(CodingOrchestrator.prototype) as object, {
        env, name, state: { runs: [] }, messages: [{ role: "user", id: "turn" }],
        approvedRunDelegate: () => ({}), employeeDraftStore: () => ({}), postToThread,
      }) as unknown as CodingOrchestrator;
      const execute = instance.getTools().ask_ui!.execute as (input: unknown, options: unknown) => Promise<unknown>;
      vi.useFakeTimers();
      const waiting = execute(block, {});
      await vi.advanceTimersByTimeAsync(25_001);
      expect(await waiting).toMatchObject({ status: "pending" });
      const runId = uiBlockRunId(name, "turn");
      const stored = await getUiBlock(env, ownerId, runId, block.id);
      expect(stored).toMatchObject({ ownerId, runId });
      expect(postToThread).toHaveBeenCalledWith(stored!.fallbackText, expect.objectContaining({ causationId: `ui-block:${runId}:${block.id}:0` }));
      if (name.startsWith("slack:")) expect(postToThread.mock.calls[0]![1].blocks).toBeDefined();
      else expect(postToThread.mock.calls[0]![1].blocks).toBeUndefined();
      await answerUiBlock(env, ownerId, runId, block.id, { blockId: block.id, optionIds: ["continue"] }, "fallback");
      expect(await execute(block, {})).toMatchObject({ status: "answered" });
      expect(postToThread).toHaveBeenCalledTimes(1);
    } finally { sqlite.close(); }
  });
});
