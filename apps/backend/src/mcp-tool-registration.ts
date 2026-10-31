/** Shared registration point used by both MCP serving and capability discovery. */
import type { Env } from "./env.js";
import type { ToolRegistry } from "./mcp-gateway.js";
import { registerEmailTools } from "./mcp-email-tools.js";
import { registerGmailTools } from "./mcp-gmail-tools.js";
import { registerMemoryTools } from "./mcp-memory-tools.js";
import { registerRunTools } from "./mcp-run-tools.js";
import { registerGrokbotBridgeTools } from "./mcp-grokbot-bridge-tools.js";
import { registerScreenTools } from "./mcp-screen-tools.js";

/** Register precisely the set of built-in handlers served on `/mcp`. */
export function registerAllMcpTools(registry: ToolRegistry, env: Env): void {
  registerEmailTools(registry, env);
  registerGmailTools(registry);
  registerMemoryTools(registry, env);
  registerRunTools(registry, env);
  registerGrokbotBridgeTools(registry, env);
  registerScreenTools(registry, env);
}
