import { agentTool } from "agents/agent-tools";
import { tool, type ToolExecutionOptions, type ToolSet } from "ai";
import { z } from "zod";
import type { Env } from "../../env.js";
import { redactSecrets } from "../../security.js";
import { ExplorerAgent } from "./explorer-agent.js";
import { ReviewerAgent } from "./reviewer-agent.js";
import {
  exploreInputSchema,
  reviewInputSchema,
  sealSpecialistDispatch,
  specialistObservationSchema,
  withinSpecialistDeadline,
  type ChildTaskEvent,
  type SpecialistRole,
} from "./contract.js";

export interface SpecialistTurnBudget { remaining: number; active: number }
export interface SpecialistToolHooks {
  onEvent: (event: ChildTaskEvent) => void | Promise<void>;
  cancel: (role: SpecialistRole, childTaskId: string) => void | Promise<void>;
}

/** Only these explicit snapshots cross the child boundary. No transcript is copied. */
export function createSpecialistTools(env: Env, parentName: string, budget: SpecialistTurnBudget, hooks: SpecialistToolHooks): ToolSet {
  const makeTool = (role: SpecialistRole) => {
    const child = agentTool(role === "explorer" ? ExplorerAgent : ReviewerAgent, {
      description: "Run one isolated, read-only specialist inspection.",
      displayName: role === "explorer" ? "Shiba Explorer" : "Shiba Reviewer",
      inputSchema: z.unknown(),
      outputSchema: specialistObservationSchema,
    });
    const execute = child.execute;
    if (!execute) throw new Error("Read-only specialist tool is unavailable.");
    return async (input: unknown, options: ToolExecutionOptions<unknown>) => {
      if (budget.active > 0 || budget.remaining <= 0) {
        return { ok: false, status: "error", error: "Specialist task capacity reached. Each turn permits three sequential inspections.", retryable: false };
      }
      const callId = options.toolCallId;
      const childTaskId = `agent-tool:${callId}`;
      budget.remaining -= 1;
      budget.active += 1;
      const emit = (kind: ChildTaskEvent["kind"], summary?: string) => hooks.onEvent({ kind, childTaskId, agent: role, parentName, ...(summary ? { summary } : {}) });
      try {
        const dispatch = await sealSpecialistDispatch(env, role, parentName, childTaskId, input);
        await emit("ChildTaskSpawned");
        await emit("ChildTaskProgress", "Inspecting explicit context with read-only tools.");
        const result = await withinSpecialistDeadline((signal) => Promise.resolve(execute(dispatch, { ...options, abortSignal: signal })), dispatch.expiresAt, options.abortSignal);
        if (typeof result === "object" && result !== null && "ok" in result && result.ok === false) {
          await emit("ChildTaskFailed", "The read-only specialist did not complete.");
          return result;
        }
        const observation = specialistObservationSchema.parse(result);
        await emit(observation.status === "completed" ? "ChildTaskCompleted" : "ChildTaskFailed", observation.summary);
        return observation;
      } catch (error) {
        await hooks.cancel(role, childTaskId);
        const summary = redactSecrets(error instanceof Error ? error.message : "Read-only specialist failed.").slice(0, 4_000);
        await emit("ChildTaskFailed", summary);
        return { ok: false, status: "error", error: summary, retryable: false };
      } finally {
        budget.active -= 1;
      }
    };
  };
  return {
    explore_codebase: tool({
      description: "Inspect an explicit file snapshot with an isolated Explorer. Read-only symbol search, file reads, and repository queries. No sandbox or human approval is required. Supply only relevant files and explicit context.",
      inputSchema: exploreInputSchema,
      execute: makeTool("explorer"),
    }),
    review_diff: tool({
      description: "Audit an explicit unified diff against a supplied specification with an isolated Reviewer. Produces a structured markdown report. Read-only. Publishing requires separate human approval.",
      inputSchema: reviewInputSchema,
      execute: makeTool("reviewer"),
    }),
  };
}
