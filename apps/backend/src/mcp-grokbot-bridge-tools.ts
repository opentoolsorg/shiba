import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  completeGrokbotBridgeTaskInputSchema,
  getFounderSkillLibraryEntry,
  grokbotBridgeStatusInputSchema,
  queueGrokbotBridgeTaskInputSchema,
} from "@shiba/shared";
import type { Env } from "./env.js";
import type { ToolRegistry } from "./mcp-gateway.js";
import { orgIdForRecord } from "./agent-tokens.js";
import {
  completeBridgeTaskAndMaybeSlack,
  publicBridgeTask,
} from "./grokbot-bridge-runner.js";
import {
  createGrokbotBridgeTask,
  getGrokbotBridgeTask,
} from "./grokbot-bridge-store.js";

function jsonResult(payload: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}

export function registerGrokbotBridgeTools(registry: ToolRegistry, env: Env): void {
  registry.registerTool(
    "queue_grokbot_bridge_task",
    "sandbox:exec",
    async (args, ctx) => {
      if (!env.AGENT_AUDIT) throw new Error("Bridge storage unavailable.");
      const founderSkillId = String(args.founderSkillId);
      if (!getFounderSkillLibraryEntry(founderSkillId)) throw new Error("Unknown founder skill id.");
      const orgId = orgIdForRecord(ctx.principal);
      const payload = typeof args.payload === "object" && args.payload !== null && !Array.isArray(args.payload)
        ? args.payload as Record<string, unknown>
        : {};
      const task = await createGrokbotBridgeTask(env, {
        orgId,
        ownerId: ctx.principal.principal,
        principal: ctx.principal.principal,
        founderSkillId,
        automationId: typeof args.automationId === "string" ? args.automationId : undefined,
        payload,
      });
      return jsonResult({
        status: "queued",
        taskId: task.id,
        note: "Poll grokbot_bridge_status, then complete_grokbot_bridge_task from Grok Bot after connector work.",
      });
    },
    {
      description:
        "Queue a founder-skill Grok Bot bridge task. Grok Bot runs SaaS connectors on its side; Shiba stores task status and posts Slack digests when complete.",
      inputSchema: queueGrokbotBridgeTaskInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
  );

  registry.registerTool(
    "grokbot_bridge_status",
    "runs:read",
    async (args, ctx) => {
      if (!env.AGENT_AUDIT) throw new Error("Bridge storage unavailable.");
      const orgId = orgIdForRecord(ctx.principal);
      const task = await getGrokbotBridgeTask(env, orgId, ctx.principal.principal, String(args.taskId));
      if (!task) throw new Error("Bridge task not found.");
      return jsonResult(publicBridgeTask(task));
    },
    {
      description: "Read Grok Bot bridge task status for the calling MCP principal.",
      inputSchema: grokbotBridgeStatusInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
  );

  registry.registerTool(
    "complete_grokbot_bridge_task",
    "sandbox:exec",
    async (args, ctx) => {
      if (!env.AGENT_AUDIT) throw new Error("Bridge storage unavailable.");
      const orgId = orgIdForRecord(ctx.principal);
      const taskId = String(args.taskId);
      const task = await getGrokbotBridgeTask(env, orgId, ctx.principal.principal, taskId);
      if (!task) throw new Error("Bridge task not found.");
      const result = typeof args.result === "object" && args.result !== null && !Array.isArray(args.result)
        ? args.result as Record<string, unknown>
        : {};
      const entry = getFounderSkillLibraryEntry(task.founderSkillId);
      const updated = await completeBridgeTaskAndMaybeSlack(
        env,
        orgId,
        ctx.principal.principal,
        task,
        result,
        {
          postSlack: args.postSlack !== false,
          requiresSensitiveApproval: entry?.requiresSensitiveApproval,
        },
      );
      if (!updated) throw new Error("Bridge task update failed.");
      return jsonResult(publicBridgeTask(updated));
    },
    {
      description:
        "Complete a bridge task with Grok Bot connector output. Optionally posts the founder skill Slack digest (respecting sensitive approval gates).",
      inputSchema: completeGrokbotBridgeTaskInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
  );
}
