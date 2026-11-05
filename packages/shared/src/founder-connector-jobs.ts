import { z } from "zod";
import { founderSkillIdSchema } from "./founder-skill-library.js";
import { workspaceIntegrationActionSchema, workspaceIntegrationApprovalSchema, workspaceIntegrationConnectionSchema } from "./workspace-integrations.js";

const id = z.string().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const workspace = z.string().regex(/^ws_[a-f0-9]{24}$/);
const actor = z.string().min(1).max(320);
const version = z.number().int().positive();
const jsonArguments = z.record(z.string(), z.unknown());
const timezone = z.string().min(1).max(100).refine((value) => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return value === value.trim(); }
  catch { return false; }
});
const cadence = {
  cadence: z.enum(["daily", "weekly"]), localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5][05]$/),
  weekday: z.number().int().min(0).max(6).optional(), timezone, expiresAt: z.number().int().positive(),
};

/** A schedule creates review occurrences. It never grants automatic app execution. */
export const founderConnectorPrepareInputSchema = z.strictObject({
  employeeId: id, employeeVersion: version, skillId: id, skillVersion: version,
  connectionId: id, connectionVersion: version, actionId: id, arguments: jsonArguments,
  ...cadence, expectedVersion: z.number().int().nonnegative(),
}).refine((value) => value.cadence === "weekly" ? value.weekday !== undefined : value.weekday === undefined);
export type FounderConnectorPrepareInput = z.infer<typeof founderConnectorPrepareInputSchema>;

export const founderConnectorContractSchema = z.object({
  format: z.literal("shiba.founder-connector.v1"), libraryId: founderSkillIdSchema, workspaceId: workspace, ownerId: actor, ownerAccountId: id,
  employeeId: id, employeeVersion: version, employeeName: z.string().min(1).max(200),
  skillId: id, skillVersion: version, skillName: z.string().min(1).max(200),
  connectionId: id, connectionVersion: version, providerKey: id, identityLabel: z.string().max(400).nullable(),
  actionId: id, actionName: z.string().min(1).max(200), inputSchema: jsonArguments, arguments: jsonArguments,
  actionSchemaHash: digest, bindingDigest: digest, recipeSha256: digest, ...cadence,
  cron: z.string().min(1).max(100), destination: z.literal("private-dashboard"), model: z.null(),
  employeeConfig: z.string().max(64_000).optional(), skillInstructions: z.string().max(64_000).optional(),
});
export type FounderConnectorContract = z.infer<typeof founderConnectorContractSchema>;
export const founderConnectorPlanSchema = z.object({
  id, version, digest, state: z.enum(["draft", "enabled", "paused", "revoked", "blocked"]), contract: founderConnectorContractSchema,
  reviewExpiresAt: z.number().int().positive(), nextDueAt: z.number().int().positive(), blockedReason: z.string().max(200).optional(),
  canEnable: z.boolean(), canPause: z.boolean(), canResume: z.boolean(), canRevoke: z.boolean(),
});
export type FounderConnectorPlan = z.infer<typeof founderConnectorPlanSchema>;
export const founderConnectorOccurrenceSchema = z.object({
  id, planId: id, planVersion: version, digest, scheduledAt: z.number().int().positive(), createdAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(), requestId: id,
  status: z.enum(["pending", "awaiting-approval", "approved", "executing", "completed", "failed", "unknown", "expired", "cancelled", "denied"]),
  approval: workspaceIntegrationApprovalSchema.nullable(), canPrepare: z.boolean(), canDecide: z.boolean(), canExecute: z.boolean(),
});
export type FounderConnectorOccurrence = z.infer<typeof founderConnectorOccurrenceSchema>;
const responseScope = { ok: z.literal(true), workspaceId: workspace, libraryId: founderSkillIdSchema, actorId: actor };
export const founderConnectorStateSchema = z.object({
  ...responseScope, canConfigure: z.boolean(), plan: founderConnectorPlanSchema.nullable(), occurrences: z.array(founderConnectorOccurrenceSchema).max(50),
  stalePlan: founderConnectorPlanSchema.pick({ id: true, version: true, digest: true, state: true, canRevoke: true }).optional(),
  unavailableReason: z.string().max(200).optional(),
});
export type FounderConnectorState = z.infer<typeof founderConnectorStateSchema>;
export const founderConnectorOptionsSchema = z.object({
  ...responseScope, canConfigure: z.boolean(), employees: z.array(z.object({ id, version, name: z.string().min(1).max(200) })).max(100),
  skill: z.object({ id, version, name: z.string().min(1).max(200) }).nullable(), connections: z.array(workspaceIntegrationConnectionSchema).max(100),
});
export type FounderConnectorOptions = z.infer<typeof founderConnectorOptionsSchema>;
export const founderConnectorActionsSchema = z.object({
  ...responseScope, connectionId: id, employeeId: id, employeeVersion: version, actions: z.array(workspaceIntegrationActionSchema).max(25),
});
export type FounderConnectorActions = z.infer<typeof founderConnectorActionsSchema>;
export const founderConnectorDecisionSchema = z.strictObject({ expectedVersion: version, digest, reviewed: z.literal(true) });
export type FounderConnectorDecision = z.infer<typeof founderConnectorDecisionSchema>;
export const founderConnectorOccurrenceInputSchema = z.strictObject({ expectedVersion: version, digest, occurrenceDigest: digest });
export const founderConnectorActionDecisionSchema = founderConnectorOccurrenceInputSchema.extend({ approvalId: id, inputHash: digest, approved: z.boolean() });
export const founderConnectorActionExecuteSchema = founderConnectorOccurrenceInputSchema.extend({ approvalId: id, inputHash: digest });
