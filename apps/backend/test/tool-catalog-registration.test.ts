import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../src/mcp-gateway.js";
import { registerAllMcpTools } from "../src/mcp-tool-registration.js";
import type { Env } from "../src/env.js";
import { ASK_USER_PUBLISHED } from "../src/tools/ws08-ask-user.js";
import { KNOWLEDGE_SEARCH_PUBLISHED } from "../src/tools/ws07-knowledge-search.js";

describe("tool catalog registration", () => {
  it("registers WS10 media tools", () => {
    const registry = createToolRegistry({} as Env);
    registerAllMcpTools(registry, {} as Env);
    const names = new Set(registry.tools().map((tool) => tool.name));
    expect(names.has("web_search")).toBe(true);
    expect(names.has("browser_open")).toBe(true);
    expect(names.has("generate_image")).toBe(true);
  });

  it("hides WS07 knowledge_search and registers WS08 ask_user schema", () => {
    const registry = createToolRegistry({} as Env);
    registerAllMcpTools(registry, {} as Env);
    const names = new Set(registry.tools().map((tool) => tool.name));
    expect(KNOWLEDGE_SEARCH_PUBLISHED).toBe(false);
    expect(ASK_USER_PUBLISHED).toBe(true);
    expect(names.has("knowledge_search")).toBe(false);
    expect(names.has("ask_user")).toBe(true);
  });
});