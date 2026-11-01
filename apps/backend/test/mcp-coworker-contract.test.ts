import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import type { TokenRecord } from "../src/agent-tokens.js";
import { createToolRegistry, visibleToolsForPrincipal } from "../src/mcp-gateway.js";
import { registerRunTools } from "../src/mcp-run-tools.js";

describe("MCP coworker contract", () => {
  it("lists run tools only when sandbox:exec and runs:read are both granted", () => {
    const registry = createToolRegistry({} as Env);
    registerRunTools(registry, {} as Env);
    const agent: TokenRecord = {
      principal: "scout",
      scopes: ["sandbox:exec", "runs:read"],
      created: 1,
      revoked: false,
    };
    const names = visibleToolsForPrincipal(registry.tools(), agent).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["queue_run", "run_status", "list_runs", "list_approvals"]));
    const execOnly = visibleToolsForPrincipal(registry.tools(), { ...agent, scopes: ["sandbox:exec"] }).map((tool) => tool.name);
    expect(execOnly).toContain("queue_run");
    expect(execOnly).not.toContain("list_runs");
  });
});
