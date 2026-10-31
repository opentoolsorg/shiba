/**
 * Grok Bot bridge: SaaS connectors that live in Grok Bot are reached over MCP
 * instead of native Shiba OAuth. Founder skills use this execution target on
 * scheduled automations; agents poll/complete tasks via MCP tools.
 */
import { z } from "zod";
import { expectedDeliverablesSchema } from "./deliverables.js";

export const grokbotBridgeExecutionTargetSchema = z.object({
  kind: z.literal("grokbot-bridge"),
  founderSkillId: z.string().trim().min(1).max(64),
  workspaceName: z.string().trim().min(1).max(100).optional(),
  expectedDeliverables: expectedDeliverablesSchema.min(1),
  /** Slack channel id (C…) or name (#founder-metrics). Defaults to SLACK_APPROVALS_CHANNEL. */
  slackChannel: z.string().trim().min(1).max(80).optional(),
  /** integration-catalog ids this skill expects via Grok Bot (informational + bridge routing). */
  bridgeCatalogIds: z.array(z.string().trim().min(1).max(64)).max(8).optional(),
  requiresSensitiveApproval: z.boolean().optional(),
}).strict();

export type GrokbotBridgeExecutionTarget = z.infer<typeof grokbotBridgeExecutionTargetSchema>;

export const grokbotBridgeTaskStatusSchema = z.enum([
  "queued",
  "running",
  "awaiting_approval",
  "completed",
  "failed",
]);

export type GrokbotBridgeTaskStatus = z.infer<typeof grokbotBridgeTaskStatusSchema>;

export const queueGrokbotBridgeTaskInputSchema = z.object({
  founderSkillId: z.string().trim().min(1).max(64).describe("Founder skill library id, e.g. founder-stripe-revenue-pulse."),
  automationId: z.string().trim().min(1).max(64).optional().describe("Optional linked automation id."),
  payload: z.record(z.string(), z.unknown()).optional().describe("Opaque JSON for Grok Bot; never interpreted by Shiba."),
});

export const grokbotBridgeStatusInputSchema = z.object({
  taskId: z.string().trim().min(1).max(64).describe("Bridge task id returned from queue_grokbot_bridge_task."),
});

export const completeGrokbotBridgeTaskInputSchema = z.object({
  taskId: z.string().trim().min(1).max(64),
  result: z.record(z.string(), z.unknown()).describe("Structured connector output from Grok Bot (untrusted)."),
  postSlack: z.boolean().optional().describe("When true, Shiba formats and posts the founder skill digest to Slack after approval gates."),
});
