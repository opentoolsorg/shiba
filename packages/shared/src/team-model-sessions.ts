import { z } from "zod";
import { teamModelMoneyContractSchema, teamModelMoneyStateSchema, teamModelTurnCostSchema, TEAM_MODEL_LLAMA_MODEL, TEAM_MODEL_TEXT_OPERATION } from "./team-model-money.js";

/** Interactive, deployment-funded text only. This contract grants no tools. */
export const TEAM_MODEL_TEXT_MODEL = "@cf/zai-org/glm-4.7-flash";
const positive = z.number().int().positive();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const fundingBase = z.object({
  operation: z.literal(TEAM_MODEL_TEXT_OPERATION).optional(),
  roomId: z.string().regex(/^room_[a-f0-9]{24}$/), employeeId: z.string().min(1).max(128), employeeVersion: positive,
  memberId: z.string().email().max(254), memberVersion: positive, model: z.enum([TEAM_MODEL_TEXT_MODEL, TEAM_MODEL_LLAMA_MODEL]),
  maxRequests: positive.max(10), maxInputBytes: positive.max(16_384), maxOutputTokens: positive.max(1024), expiresAt: positive,
}).strict();
export const teamModelFundingInputSchema = fundingBase.extend({ currency: z.literal("USD"), budgetMicroUsd: z.number().int().safe().positive().max(1_000_000) }).strict();
export type TeamModelFundingInput = z.infer<typeof teamModelFundingInputSchema>;
export const teamModelFundingContractSchema = fundingBase.extend({
  issuerId: z.string(), employeeName: z.string(), employeeInstructions: z.string(),
  billing: z.literal("deployment-workers-ai"), audience: z.literal("requesting-member"),
  tools: z.tuple([]), credentialRef: z.null(), money: teamModelMoneyContractSchema.optional(),
});
export type TeamModelFundingContract = z.infer<typeof teamModelFundingContractSchema>;
export const teamModelFundingSchema = z.object({
  id: z.string(), version: positive, digest: hash,
  state: z.enum(["draft", "active", "revoked", "blocked", "unknown"]), contract: teamModelFundingContractSchema,
  reviewExpiresAt: positive, usedRequests: z.number().int().nonnegative(), reservedInputBytes: z.number().int().nonnegative(), reservedOutputTokens: z.number().int().nonnegative(),
  canActivate: z.boolean(), canRevoke: z.boolean(), unavailableReason: z.string().nullable(),
  money: teamModelMoneyStateSchema.optional(),
});
export type TeamModelFunding = z.infer<typeof teamModelFundingSchema>;
export const teamModelTurnInputSchema = z.object({
  grantId: z.string().regex(/^tmf_[a-f0-9]{32}$/), expectedGrantVersion: positive, prompt: z.string().trim().min(1).max(16_384),
  messageIds: z.array(z.string().min(1).max(160)).max(12),
  memoryRefs: z.array(z.object({ id: z.string().regex(/^ctx_[A-Za-z0-9_-]{1,96}$/), version: z.literal(1), sha256: hash }).strict()).max(8),
  requestId: z.string().uuid(),
}).strict().refine((input) => new Set(input.messageIds).size === input.messageIds.length && new Set(input.memoryRefs.map((ref) => ref.id)).size === input.memoryRefs.length, "Choose distinct sources.");
export type TeamModelTurnInput = z.infer<typeof teamModelTurnInputSchema>;
export const teamModelSourceSchema = z.object({ kind: z.enum(["message", "note"]), id: z.string(), author: z.string(), version: positive.nullable(), sha256: hash, body: z.string() });
export type TeamModelSource = z.infer<typeof teamModelSourceSchema>;
export const teamModelTurnSchema = z.object({
  id: z.string(), grantId: z.string(), version: positive, roomId: z.string(), requesterId: z.string(), employeeId: z.string(), model: z.string(),
  requestedPrompt: z.string(), messages: z.array(z.object({ role: z.enum(["system", "user"]), content: z.string() })), sources: z.array(teamModelSourceSchema),
  inputHash: hash, inputBytes: positive, maxOutputTokens: positive, expiresAt: positive,
  status: z.enum(["pending", "approved", "running", "completed", "cancelled", "unknown", "blocked"]),
  output: z.string().nullable(), error: z.string().nullable(), canApprove: z.boolean(), canExecute: z.boolean(), canCancel: z.boolean(),
  cost: teamModelTurnCostSchema.optional(),
});
export type TeamModelTurn = z.infer<typeof teamModelTurnSchema>;
export const teamModelStateResponseSchema = z.object({
  ok: z.literal(true), workspaceId: z.string(), roomId: z.string(), actorId: z.string(), enabled: z.boolean(), model: z.string().nullable(), policyDigest: hash,
  canFund: z.boolean(), unavailableReason: z.string().nullable(),
  actors: z.array(z.object({ userId: z.string(), version: positive })), employees: z.array(z.object({ id: z.string(), name: z.string(), version: positive })),
  grants: z.array(teamModelFundingSchema), turns: z.array(teamModelTurnSchema),
});
export type TeamModelStateResponse = z.infer<typeof teamModelStateResponseSchema>;
export const teamModelFundingResponseSchema = z.object({ ok: z.literal(true), workspaceId: z.string(), roomId: z.string(), grant: teamModelFundingSchema });
export type TeamModelFundingResponse = z.infer<typeof teamModelFundingResponseSchema>;
export const teamModelTurnResponseSchema = z.object({ ok: z.literal(true), workspaceId: z.string(), roomId: z.string(), turn: teamModelTurnSchema });
export type TeamModelTurnResponse = z.infer<typeof teamModelTurnResponseSchema>;
