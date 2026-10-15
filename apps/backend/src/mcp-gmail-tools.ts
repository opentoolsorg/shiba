/** External MCP only: never register Gmail with the shared Code Mode principal. */
import { z } from "zod";
import { GmailError, readGmail, searchGmail } from "./gmail.js";
import type { ToolRegistry } from "./mcp-gateway.js";

const search = z.object({ query: z.string().max(256), limit: z.number().int().min(1).max(25).optional() }).strict();
const read = z.object({ messageIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)).min(1).max(25) }).strict();

export function registerGmailTools(registry: ToolRegistry): void {
  registry.registerTool("gmail_search", "gmail:read", async (args, ctx) => {
    const input = search.safeParse(args);
    if (!input.success) throw new GmailError("Invalid Gmail search arguments.");
    const result = await searchGmail(ctx.env, ctx.principal, input.data.query, input.data.limit ?? 25);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }, { description: "Search explicitly granted Gmail read-only connection; returns at most 25 message IDs.",
    inputSchema: search.shape, annotations: { readOnlyHint: true } });
  registry.registerTool("gmail_read", "gmail:read", async (args, ctx) => {
    const input = read.safeParse(args);
    if (!input.success) throw new GmailError("Invalid Gmail read arguments.");
    const result = await readGmail(ctx.env, ctx.principal, input.data.messageIds);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }, { description: "Read 1–25 messages from the explicitly granted connection; body text is capped at 20 KiB and untrusted. No attachments.",
    inputSchema: read.shape, annotations: { readOnlyHint: true } });
}
