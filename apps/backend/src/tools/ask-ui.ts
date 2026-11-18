import { parseUiBlock, uiBlockSchema } from "@shiba/shared";
import { tool, type ToolSet } from "ai";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Env } from "../env.js";
import type { ToolCallContext, ToolRegistry } from "../mcp-gateway.js";
import { createUiBlock, getUiBlock, UiBlockError, type UiBlockQuestion } from "../ui-block-store.js";
import { publishWorkspaceEvent } from "../platform/workspace-events-do.js";

export const ASK_UI_WAIT_MS = 25_000;
const POLL_MS = 500;

export interface AskUiRunContext {
  runId: string;
  ownerId: string;
  workspaceId?: string;
}

export interface AskUiDependencies {
  onCreated?: (question: UiBlockQuestion) => void | Promise<void>;
  /** Only a trusted dispatcher may supply this; never infer a run from tool args or a principal name. */
  resolveRunContext?: (context: ToolCallContext) => AskUiRunContext | null | Promise<AskUiRunContext | null>;
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function result(payload: Record<string, unknown>, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, ...(isError ? { isError: true } : {}) };
}

const ASK_UI_DESCRIPTION = "Ask the human an interactive question. Input is a version 1 UiBlock (confirm, quick_replies, choice, or form). Wait for its answer; when pending, call again with the identical block. An ask_ui answer is never an approval and cannot authorize an approval-gated action.";

export async function askUiAndWait(env: Env, run: AskUiRunContext | null | undefined, input: unknown, deps: AskUiDependencies = {}): Promise<CallToolResult> {
  const parsed = parseUiBlock(input);
  if (!parsed.ok) return result({ error: "invalid_ui_block", errors: parsed.errors }, true);
  if (!run?.runId.trim() || !run.ownerId.trim()) return result({ error: "ask_ui_requires_run" }, true);
  try {
    const { question, created } = await createUiBlock(env, run.ownerId, run.runId, parsed.block);
    if (created) await deps.onCreated?.(question);
    if (created && run.workspaceId) {
      await publishWorkspaceEvent(env, run.workspaceId, { kind: "ui_block.asked", entityId: run.runId, audience: { userIds: [run.ownerId] }, payload: { blockId: question.blockId } });
    }
    const now = deps.now ?? Date.now;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const budget = Math.max(0, Math.min(deps.waitMs ?? ASK_UI_WAIT_MS, ASK_UI_WAIT_MS));
    const deadline = now() + budget;
    let remaining = budget;
    let current = question;
    while (current.status === "pending" && remaining > 0 && now() < deadline) {
      const delay = Math.min(Math.max(1, deps.pollMs ?? POLL_MS), remaining, deadline - now());
      await sleep(delay);
      remaining -= delay;
      const next = await getUiBlock(env, run.ownerId, run.runId, question.blockId);
      if (!next) return result({ error: "question_not_found" }, true);
      current = next;
    }
    if (current.status === "answered") return result({ status: "answered", answer: current.answer });
    if (current.status === "cancelled") return result({ error: "question_cancelled" }, true);
    return result({ status: "pending", blockId: question.blockId, instruction: "The run is paused on this question. Call ask_ui again with the same block to keep waiting; do not proceed or assume an answer." });
  } catch (error) {
    if (error instanceof UiBlockError) return result({ error: error.message, errors: error.errors }, true);
    return result({ error: "ask_ui_unavailable" }, true);
  }
}

export function createAskUiAgentTools(env: Env, resolveRunContext: () => AskUiRunContext | null | Promise<AskUiRunContext | null>, deps: AskUiDependencies = {}): ToolSet {
  return {
    ask_ui: tool({
      description: ASK_UI_DESCRIPTION,
      inputSchema: uiBlockSchema,
      execute: async (block) => {
        const reply = await askUiAndWait(env, await resolveRunContext(), block, deps);
        return { ...reply.structuredContent, ...(reply.isError ? { isError: true } : {}) };
      },
    }),
  };
}

export function registerAskUiTool(registry: ToolRegistry, env: Env, deps: AskUiDependencies = {}): void {
  registry.registerTool("ask_ui", "api:write", async (args, context) =>
    askUiAndWait(env, await deps.resolveRunContext?.(context), args, deps), {
    description: ASK_UI_DESCRIPTION,
    inputSchema: {
      version: z.literal(1), id: z.string(), type: z.enum(["confirm", "quick_replies", "choice", "form"]),
      prompt: z.string(), title: z.string().optional(), fallbackText: z.string().optional(),
      confirmLabel: z.string().optional(), cancelLabel: z.string().optional(), danger: z.boolean().optional(),
      options: z.array(z.unknown()).optional(), multiple: z.boolean().optional(),
      minSelections: z.number().optional(), maxSelections: z.number().optional(),
      fields: z.array(z.unknown()).optional(), submitLabel: z.string().optional(),
    },
    annotations: { readOnlyHint: false },
  });
}
