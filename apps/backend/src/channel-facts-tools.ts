import { z } from "zod";
import type { Env } from "./env.js";
import type { ToolRegistry } from "./mcp-gateway.js";
import { resolveWorkspaceFactsScope, WorkspaceChannelFactsStore, workspaceFactsThread } from "./workspace-channel-facts.js";

export function registerChannelFactsTools(registry: ToolRegistry, env: Env, trustedThreadName: string | null | undefined): void {
  const thread = workspaceFactsThread(trustedThreadName);
  if (!thread) return;
  const storeAndScope = async () => {
    if (thread.channelId.startsWith("D")) throw new Error("Workspace facts cannot be saved or forgotten from Slack DMs. Use a workspace channel.");
    const scope = await resolveWorkspaceFactsScope(env, thread.teamId);
    return { store: new WorkspaceChannelFactsStore(env.AGENT_AUDIT!), scope };
  };
  registry.registerTool("channel_remember", "memory:write", async (args, ctx) => {
    const { fact } = z.object({ fact: z.string() }).strict().parse(args);
    const { store, scope } = await storeAndScope();
    const saved = await store.remember(scope, fact, { createdBy: ctx.principal.principal, sourceChannel: thread.channelId });
    return { content: [{ type: "text", text: JSON.stringify(saved) }] };
  }, {
    description: "Save a short, durable workspace fact (for example who owns a service) shared with every conversation in this Slack workspace connection. No approval needed. Do not save secrets or instructions. Unavailable in DMs; at most 32 facts, 500 characters each.",
    inputSchema: { fact: z.string().describe("The factual note to remember, at most 500 characters.") },
  });
  registry.registerTool("channel_forget", "memory:write", async (args) => {
    const { id } = z.object({ id: z.string().min(1) }).strict().parse(args);
    const { store, scope } = await storeAndScope();
    return { content: [{ type: "text", text: JSON.stringify({ deleted: await store.forget(scope, id) }) }] };
  }, {
    description: "Forget an outdated or incorrect saved workspace fact by its id from workspace_facts. Only this Slack workspace connection is affected. No approval needed. Unavailable in DMs.",
    inputSchema: { id: z.string().describe("The saved workspace fact id to forget.") },
  });
}
