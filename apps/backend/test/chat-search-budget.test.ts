import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { CodingOrchestrator } from "../src/agents/orchestrator.js";
import { buildSessionAgentName } from "../src/web-sessions.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

vi.mock("@cloudflare/think", () => ({ Think: class {} }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));

type ToolSet = Record<string, { execute: (input: unknown, options: unknown) => Promise<{ ok: boolean; error?: string }> }>;

/**
 * A thread-wide budget key let two five-query batches disable web search for
 * the rest of a conversation. Each user message now gets its own window.
 */
function fixture(messages: unknown[]) {
  const { database } = customAgentD1();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ results: [{ title: "r", url: "https://example.com/a", content: "s" }] })));
  const env = { AGENT_AUDIT: database, WEB_SEARCH_API_KEY: "budget-test-key", WEB_SEARCH_PROVIDER: "tavily" } as unknown as Env;
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const agentName = buildSessionAgentName("ada@example.test", sessionId);
  const instance = Object.assign(Object.create(CodingOrchestrator.prototype) as object, {
    env, name: agentName, messages, state: { runs: [] }, employeeToolProfileId: () => undefined,
  }) as unknown as CodingOrchestrator & { messages: unknown[] };
  return { database, instance, tools: () => instance.getTools() as unknown as ToolSet };
}

const user = (id: string) => ({ role: "user", id, metadata: { shibaMode: "chat" }, parts: [] });
const search = (tools: ToolSet) => tools.web_search!.execute({ query: "pricing" }, { toolCallId: "t", messages: [] });

describe("chat web search budget window", () => {
  it("exhausts one message's budget and gives the next message a fresh one", async () => {
    const f = fixture([user("m1")]);
    const first = await search(f.tools());
    expect(first.ok).toBe(true);
    let blocked = 0;
    for (let index = 0; index < 12; index += 1) if (!(await search(f.tools())).ok) blocked += 1;
    expect(blocked).toBeGreaterThan(0);
    expect((await search(f.tools())).error).toBe("Web search budget exceeded for this message.");
    f.instance.messages = [user("m1"), { role: "assistant", parts: [] }, user("m2")] as unknown as typeof f.instance.messages;
    expect((await search(f.tools())).ok).toBe(true);
    const rows = await f.database.prepare("SELECT run_id, call_count FROM agent_tool_usage ORDER BY run_id").all<{ run_id: string; call_count: number }>();
    expect(rows.results.map((row) => row.run_id)).toEqual([
      `${f.instance.name}:turn:m1`,
      `${f.instance.name}:turn:m2`,
    ]);
  });

  it("charges a batch by its query count", async () => {
    const f = fixture([user("m1")]);
    await f.tools().web_search!.execute({ query: ["a", "b", "c"] }, { toolCallId: "t", messages: [] });
    const row = await f.database.prepare("SELECT call_count FROM agent_tool_usage").first<{ call_count: number }>();
    expect(row?.call_count).toBe(3);
    vi.unstubAllGlobals();
  });
});
