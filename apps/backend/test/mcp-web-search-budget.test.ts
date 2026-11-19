import { describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Env } from "../src/env.js";
import { createToolRegistry } from "../src/mcp-gateway.js";
import { registerAgentMediaMcpTools } from "../src/tools/register-mcp.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

function fixture() {
  const { database } = customAgentD1();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ results: [{ title: "r", url: "https://example.com/a", content: "s" }] })));
  const env = { AGENT_AUDIT: database, WEB_SEARCH_API_KEY: "mcp-budget-key" } as unknown as Env;
  const registry = createToolRegistry(env);
  registerAgentMediaMcpTools(registry, env);
  const tool = registry.tools().find((entry) => entry.name === "web_search")!;
  const call = (args: Record<string, unknown>) => tool.handler(args, {
    principal: { principal: "ada@example.test", orgId: "self-hosted" },
  } as never) as Promise<CallToolResult>;
  return { database, tool, call };
}

describe("MCP web_search budget key", () => {
  it("does not publish a caller-controlled budget key", () => {
    const f = fixture();
    expect(Object.keys(f.tool.meta.inputSchema ?? {})).toEqual(["query", "maxResults", "domains", "recency", "country"]);
    vi.unstubAllGlobals();
  });

  it("keys usage by the calling principal, so argument runIds cannot reset it", async () => {
    const f = fixture();
    await f.call({ query: "one", runId: "fresh-key-1" });
    await f.call({ query: "two", runId: "fresh-key-2" });
    const rows = await f.database.prepare("SELECT run_id, call_count FROM agent_tool_usage").all<{ run_id: string; call_count: number }>();
    expect(rows.results).toEqual([{ run_id: "api:ada@example.test", call_count: 2 }]);
    vi.unstubAllGlobals();
  });

  it("still refuses past the budget", async () => {
    const f = fixture();
    await f.call({ query: ["a", "b", "c", "d", "e"] });
    await f.call({ query: ["f", "g", "h", "i", "j"] });
    const refused = await f.call({ query: "k" });
    expect(JSON.parse(String((refused.content[0] as { text: string }).text))).toMatchObject({ ok: false, error: "Web search budget exceeded for this run." });
    vi.unstubAllGlobals();
  });
});
