/**
 * Frozen work destination for a task. Runtime selection (`sandbox`/`local`)
 * remains a separate concern: a target describes what is being worked on,
 * not where the model process runs.
 *
 * `executionTarget` is optional on legacy requests and records. An absent
 * target means the historical repository destination from repoUrl/baseBranch.
 */
import { z } from "zod";
import { expectedDeliverablesSchema } from "./deliverables.js";

const boundedId = z.string().min(1).max(128);

export const repositoryExecutionTargetSchema = z.object({
  kind: z.literal("repository"),
  repoUrl: z.string().min(1).max(2048),
  baseBranch: z.string().min(1).max(256),
}).strict();

export const artifactWorkspaceExecutionTargetSchema = z.object({
  kind: z.literal("artifact-workspace"),
  workspaceName: z.string().trim().min(1).max(100).optional(),
  expectedDeliverables: expectedDeliverablesSchema.min(1),
}).strict();

/**
 * Schema for future connected-app work. This describes a requested action;
 * it does not grant permission or make the action executable. Intake must
 * reject it until a permissioned adapter and action-specific approval exist.
 */
export const connectedAppExecutionTargetSchema = z.object({
  kind: z.literal("connected-app"),
  connectionId: boundedId,
  action: z.string().trim().min(1).max(128),
}).strict();

export const executionTargetSchema = z.discriminatedUnion("kind", [
  repositoryExecutionTargetSchema,
  artifactWorkspaceExecutionTargetSchema,
  connectedAppExecutionTargetSchema,
]);

export type RepositoryExecutionTarget = z.infer<typeof repositoryExecutionTargetSchema>;
export type ArtifactWorkspaceExecutionTarget = z.infer<typeof artifactWorkspaceExecutionTargetSchema>;
export type ConnectedAppExecutionTarget = z.infer<typeof connectedAppExecutionTargetSchema>;
export type ExecutionTarget = z.infer<typeof executionTargetSchema>;

/** Resolve old callers without mutating or reinterpreting explicit targets. */
export function legacyRepositoryExecutionTarget(input: {
  repoUrl?: unknown;
  baseBranch?: unknown;
}): RepositoryExecutionTarget | null {
  if (typeof input.repoUrl !== "string" || typeof input.baseBranch !== "string") return null;
  const parsed = repositoryExecutionTargetSchema.safeParse({
    kind: "repository",
    repoUrl: input.repoUrl,
    baseBranch: input.baseBranch,
  });
  return parsed.success ? parsed.data : null;
}
