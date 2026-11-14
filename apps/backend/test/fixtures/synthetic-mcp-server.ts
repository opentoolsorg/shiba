/**
 * Synthetic streamable-HTTP MCP fixture metadata for WS04 acceptance tests.
 * Tests stub transport via `fetch`; this module only names the contract.
 */
export const SYNTHETIC_MCP_ENDPOINT = "https://mcp.example.com/mcp";
export const SYNTHETIC_MCP_TOOLS = [
  {
    name: "echo",
    description: "Echo fixture",
    inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false },
  },
] as const;