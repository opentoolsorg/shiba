import { tool, type Tool, type ToolSet } from "ai";
import { z } from "zod";
import { workspaceTargetSchema } from "@shiba/shared";
import { exploreInputSchema, reviewInputSchema } from "./contract.js";
import type { SpecialistTurnBudget } from "./tools.js";
import { redactSecrets } from "../../security.js";

const coderContextSchema = z.strictObject({
  repoUrl: z.string().url().max(2048).optional(),
  baseBranch: z.string().min(1).max(200).default("main"),
  workspaceTarget: workspaceTargetSchema.optional(),
  context: z.string().max(4_000).default(""),
}).refine((value) => Boolean(value.repoUrl || value.workspaceTarget), "An explicit repository or workspace target is required.");

const delegateTaskInputSchema = z.strictObject({
  agent: z.enum(["researcher", "coder", "analyst"]),
  goal: z.string().trim().min(1).max(4_000),
  context: z.unknown(),
}).refine((value) => (JSON.stringify(value.context) ?? "").length <= 128_000, "Explicit child context is too large.");
type DelegateTaskInput = z.infer<typeof delegateTaskInputSchema>;

/** Compatibility roles use the same bounded specialists and human run gate. */
export function createDelegateTaskTool(
  tools: ToolSet,
  budget: SpecialistTurnBudget,
  queueCoding: (input: { task: string; repoUrl?: string; baseBranch: string; workspaceTarget?: z.infer<typeof workspaceTargetSchema> }) => Promise<Response>,
  persistBudget: () => void,
): Tool<DelegateTaskInput, unknown, Record<string, unknown>> {
  return tool<DelegateTaskInput, unknown, Record<string, unknown>>({
    description: "Delegate using an explicit goal and context only. Researcher context requires {files,context?}; analyst context requires {specification,diff,context?}; coder context requires {repoUrl|workspaceTarget,baseBranch?,context?}. Coder queues a fresh human approval and never starts execution itself. No parent history is inherited.",
    inputSchema: delegateTaskInputSchema,
    execute: async ({ agent, goal, context }, options) => {
      let explicit = context;
      if (typeof explicit === "string") {
        try { explicit = JSON.parse(explicit); }
        catch { return { agent, status: "invalid_context", summary: "Supply the required explicit snapshot, diff, or workspace target as a context object." }; }
      }
      if (explicit === null || typeof explicit !== "object" || Array.isArray(explicit)) {
        return { agent, status: "invalid_context", summary: "An explicit context object is required." };
      }
      if (agent !== "coder") {
        const schema = agent === "researcher" ? exploreInputSchema : reviewInputSchema;
        const parsed = schema.safeParse({ ...explicit, goal });
        if (!parsed.success) return { agent, status: "invalid_context", summary: "The explicit snapshot or diff context is missing, unsupported, or exceeds its bounds." };
        const child = agent === "researcher" ? tools.explore_codebase : tools.review_diff;
        if (!child?.execute) return { agent, status: "failed", summary: "The read-only specialist is unavailable." };
        return { agent, observation: await child.execute(parsed.data, options) };
      }
      const parsed = coderContextSchema.safeParse(explicit);
      if (!parsed.success) return { agent, status: "invalid_context", summary: "Supply an explicit repository or workspace target. Approval and publication fields are not accepted." };
      const task = [goal, parsed.data.context].filter(Boolean).join("\n\n");
      if (task.length > 4_000) return { agent, status: "invalid_context", summary: "The complete explicit goal and context exceed the approval task limit." };
      if (budget.active > 0 || budget.remaining <= 0) return { agent, status: "capacity_reached", summary: "The bounded child task capacity is exhausted." };
      budget.remaining -= 1;
      budget.active += 1;
      try {
        persistBudget();
        const { context: _context, ...target } = parsed.data;
        const response = await queueCoding({ ...target, task });
        const result: unknown = await response.json();
        return { agent, status: response.ok ? "awaiting_approval" : "failed", result };
      } catch (error) {
        return { agent, status: "failed", summary: redactSecrets(error instanceof Error ? error.message : "The fresh human approval could not be queued.").slice(0, 4_000) };
      } finally { budget.active -= 1; }
    },
  });
}
