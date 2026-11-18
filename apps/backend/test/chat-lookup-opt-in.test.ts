import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { CodingOrchestrator } from "../src/agents/orchestrator.js";
import { chatOptInTools } from "../src/conversation-mode.js";
import { createChatAgentMediaTools } from "../src/tools/chat-agent-tools.js";

vi.mock("@cloudflare/think", () => ({ Think: class {} }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));

const chat = (metadata: Record<string, unknown>) => [{ role: "user", metadata: { shibaMode: "chat", ...metadata } }];

function host(messages: unknown[]) {
  return Object.assign(Object.create(CodingOrchestrator.prototype) as object, {
    env: {} as Env, name: "owner@example.test", messages, state: {}, employeeToolProfileId: () => undefined,
  }) as unknown as CodingOrchestrator;
}

describe("chat lookup opt-in", () => {
  it("honors only allowlisted lookups on the latest explicit Chat turn", () => {
    expect(chatOptInTools(chat({ shibaChatTools: ["web_search", "knowledge_search"] }))).toEqual(["web_search", "knowledge_search"]);
    expect(chatOptInTools(chat({ shibaChatTools: ["delegate_coding_task", "browser_click", "knowledge_search"] }))).toEqual(["knowledge_search"]);
    expect(chatOptInTools(chat({ shibaChatTools: "web_search" }))).toEqual([]);
    expect(chatOptInTools(chat({}))).toEqual([]);
    expect(chatOptInTools([{ role: "user", metadata: { shibaMode: "work", shibaChatTools: ["web_search"] } }])).toEqual([]);
    expect(chatOptInTools([
      ...chat({ shibaChatTools: ["web_search"] }),
      { role: "assistant", parts: [] },
      ...chat({}),
    ])).toEqual([]);
  });

  it("keeps an unmarked Chat turn tool-free", async () => {
    const tools = { web_search: {}, knowledge_search: {}, browser_open: {}, generate_image: {} };
    const instance = host(chat({}));
    const turn = await instance.beforeTurn({ tools, system: "base" } as never);
    expect(turn.activeTools).toEqual([]);
    expect(instance.getSystemPrompt()).toContain("do not use tools");
  });

  it("activates only the opted-in read-only lookups that exist this turn", async () => {
    const tools = { web_search: {}, browser_open: {}, browser_click: {}, generate_image: {} };
    const instance = host(chat({ shibaChatTools: ["web_search", "knowledge_search", "browser_click"] }));
    const turn = await instance.beforeTurn({ tools, system: "base" } as never);
    expect(turn.activeTools).toEqual(["web_search"]);
    const prompt = instance.getSystemPrompt();
    expect(prompt).toContain("web_search and knowledge_search switched on");
    expect(prompt).toContain("Do not use any other tool");
  });

  it("offers knowledge_search to signed-in chat users only, scoped to their workspace", async () => {
    expect(createChatAgentMediaTools({} as Env, { runId: "r" })).not.toHaveProperty("knowledge_search");
    const tools = createChatAgentMediaTools({} as Env, { runId: "r", userId: "ada@example.test", orgId: "team:ws_1" });
    const unavailable = await (tools.knowledge_search as { execute: (input: unknown, options: unknown) => Promise<unknown> })
      .execute({ query: "launch" }, { toolCallId: "t", messages: [] });
    expect(unavailable).toMatchObject({ ok: false, unavailable: true });
  });
});
