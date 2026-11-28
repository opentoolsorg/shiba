import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../src/mcp-gateway.js";
import { registerAllMcpTools } from "../src/mcp-tool-registration.js";
import type { Env } from "../src/env.js";
import { ASK_USER_PUBLISHED } from "../src/tools/ws08-ask-user.js";

describe("tool catalog registration", () => {
  it("registers WS10 media tools", () => {
    const registry = createToolRegistry({} as Env);
    registerAllMcpTools(registry, {} as Env);
    const names = new Set(registry.tools().map((tool) => tool.name));
    expect(names.has("web_search")).toBe(true);
    expect(names.has("browser_open")).toBe(true);
    expect(names.has("generate_image")).toBe(true);
  });

  it("publishes WS07 knowledge_search as a read-only knowledge:read tool and registers WS08 ask_user schema", () => {
    const registry = createToolRegistry({} as Env);
    registerAllMcpTools(registry, {} as Env);
    const tools = new Map(registry.tools().map((tool) => [tool.name, tool]));
    expect(ASK_USER_PUBLISHED).toBe(true);
    expect(tools.get("knowledge_search")).toMatchObject({ scope: "knowledge:read", meta: { annotations: { readOnlyHint: true } } });
    expect(Object.keys(tools.get("knowledge_search")?.meta.inputSchema ?? {})).toEqual(["query", "limit"]);
    expect(tools.get("knowledge_read")).toMatchObject({ scope: "knowledge:read", meta: { annotations: { readOnlyHint: true } } });
    expect(Object.keys(tools.get("knowledge_read")?.meta.inputSchema ?? {})).toEqual(["sourceKind", "sourceId", "maxChars"]);
    expect(tools.has("ask_user")).toBe(true);
  });
});
