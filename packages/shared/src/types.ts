import { z } from "zod";
import { executionTargetSchema, type ExecutionTarget } from "./execution-target.js";
import { expectedDeliverablesSchema } from "./deliverables.js";

/** User-facing workspace selection. Execution targets carry its frozen form. */
export type WorkspaceTarget =
  | { type: "github"; repoUrl: string; baseBranch?: string }
  | { type: "ephemeral"; workspaceId: string; template?: string };

export const workspaceTargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("github"),
    repoUrl: z.string().url().max(2048),
    baseBranch: z.string().min(1).max(256).optional(),
  }).strict(),
  z.object({
    type: z.literal("ephemeral"),
    workspaceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
    template: z.string().trim().min(1).max(100).optional(),
  }).strict(),
]);

/** Preserve the existing approval and dispatch representation for all callers. */
export function workspaceTargetToExecutionTarget(
  target: WorkspaceTarget,
  expectedDeliverables: string[] = [],
): ExecutionTarget {
  const parsed = workspaceTargetSchema.parse(target);
  if (parsed.type === "github") {
    return { kind: "repository", repoUrl: parsed.repoUrl, baseBranch: parsed.baseBranch ?? "main" };
  }
  return executionTargetSchema.parse({
    kind: "artifact-workspace",
    workspaceId: parsed.workspaceId,
    workspaceName: parsed.workspaceId.slice(0, 100),
    ...(parsed.template ? { template: parsed.template } : {}),
    expectedDeliverables: expectedDeliverablesSchema.parse(expectedDeliverables),
  });
}

export function isEphemeralWorkspace(target: ExecutionTarget | undefined): boolean {
  return target?.kind === "artifact-workspace" && target.workspaceId !== undefined;
}
