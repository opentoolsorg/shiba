import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { CodingOrchestrator } from "../src/agents/orchestrator.js";
import { chatOptInTools } from "../src/conversation-mode.js";
import { createChatAgentMediaTools } from "../src/tools/chat-agent-tools.js";
import { insertFileRecord } from "../src/files/files-store.js";
import { runIngestionJob } from "../src/knowledge/knowledge-ingestion.js";
import { buildSessionAgentName } from "../src/web-sessions.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

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

describe("chat knowledge lookup scope", () => {
  /** Chat runs in the deployment scope, where a dashboard user's files are personal to them. */
  async function fixture() {
    const { database } = customAgentD1();
    const objects = new Map<string, Uint8Array>();
    const env = {
      AGENT_AUDIT: database,
      // Keyword-only: this test is about whose sources are read, not ranking.
      AI: { run: vi.fn(async (_model: string, input: { text: string[] }) => ({ data: input.text.map(() => [0.1, 0.2]) })) },
      FILES: { async get(key: string) { const bytes = objects.get(key); return bytes ? { arrayBuffer: async () => bytes.buffer } : null; } },
    } as unknown as Env;
    async function add(owner: string, name: string, body: string) {
      objects.set(name, new TextEncoder().encode(body));
      const file = await insertFileRecord(env, {
        workspaceId: "self-hosted", scope: "personal", name, mime: "text/markdown",
        size: body.length, r2Key: name, sha256: "a".repeat(64), createdBy: owner,
      });
      await runIngestionJob(env, {
        jobId: `job-${name}`, sourceKind: "file", sourceId: file.id, workspaceId: "self-hosted",
        scope: "personal", version: 1, sha256: file.sha256, r2Key: name, mime: "text/markdown",
      });
    }
    await add("ada@example.test", "ada-falcon.md", "Falcon rollout notes.");
    await add("ben@example.test", "ben-falcon.md", "Falcon budget notes.");
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const instance = Object.assign(Object.create(CodingOrchestrator.prototype) as object, {
      env,
      name: buildSessionAgentName("ada@example.test", sessionId),
      messages: [{ role: "user", id: "m1", metadata: { shibaMode: "chat", shibaChatTools: ["knowledge_search"] }, parts: [] }],
      state: { runs: [] },
      employeeToolProfileId: () => undefined,
    }) as unknown as CodingOrchestrator;
    return { instance };
  }

  it("registers the tool on a dashboard chat session and returns only the caller's own sources", async () => {
    const { instance } = await fixture();
    const tools = instance.getTools() as Record<string, { execute: (input: unknown, options: unknown) => Promise<{ ok: boolean; hits?: Array<{ sourceName?: string }> }> }>;
    const result = await tools.knowledge_search!.execute({ query: "falcon" }, { toolCallId: "t", messages: [] });
    expect(result.hits?.map((hit) => hit.sourceName)).toEqual(["ada-falcon.md"]);
  });
});
