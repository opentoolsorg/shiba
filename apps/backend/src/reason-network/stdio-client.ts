/** Optional Node companion connector. This function has no effect until explicitly called. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ReasonNetworkMcpClient, ReasonNetworkTool } from "./adapter.js";

export interface ReasonNetworkStdioOptions {
  /** Explicit user/operator opt-in. Omitted or false means no process is started. */
  enabled?: boolean;
  /** Absolute path to a user-installed upstream executable; Shiba never downloads it. */
  executablePath: string;
  env?: Record<string, string>;
}

export async function connectReasonNetworkStdio(options: ReasonNetworkStdioOptions): Promise<ReasonNetworkMcpClient & { close(): Promise<void> }> {
  if (options.enabled !== true) throw new Error("Reason Network companion is disabled; set enabled only after explicit local configuration.");
  if (!options.executablePath.startsWith("/")) throw new TypeError("Reason Network executable must be an absolute path.");
  const transport = new StdioClientTransport({ command: options.executablePath, args: ["mcp"], env: options.env });
  const client = new Client({ name: "shiba-reason-network", version: "0.1.0" });
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  return {
    connected: true,
    toolNames: names,
    async callTool(name: ReasonNetworkTool, args: Record<string, unknown>, meta: { sessionId: string }) {
      const response = await client.callTool({ name, arguments: args, _meta: { sessionId: meta.sessionId } });
      if (response.isError) throw new Error("Reason Network MCP tool returned an error.");
      return response.content;
    },
    async close() { await client.close(); },
  };
}
