import { z } from "zod";
import { stableHash } from "./approvals.js";

export const TEAM_MODEL_TEXT_OPERATION = "text-generation";
export const TEAM_MODEL_MONEY_VERSION = "shiba.team-cost.v2";
export const TEAM_MODEL_MAX_BUDGET_MICRO_USD = 1_000_000;
export const TEAM_MODEL_PRICE_REFERENCE = {
  version: TEAM_MODEL_MONEY_VERSION, model: "@cf/zai-org/glm-4.7-flash",
  sourceVerifiedOn: "2026-11-05", inputContextTokens: 131_072,
  inputMicroUsdPerMillionTokens: 60_500, outputMicroUsdPerMillionTokens: 400_400,
  kind: "shiba-authorization-estimate", currency: "USD",
} as const;
export const TEAM_MODEL_LLAMA_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";
export const TEAM_MODEL_LLAMA_PRICE_REFERENCE = { ...TEAM_MODEL_PRICE_REFERENCE, model: TEAM_MODEL_LLAMA_MODEL,
  inputContextTokens: 32_000, inputMicroUsdPerMillionTokens: 152_000, outputMicroUsdPerMillionTokens: 287_000 } as const;
export function teamModelPriceReference(model: string) {
  if (model === TEAM_MODEL_PRICE_REFERENCE.model) return TEAM_MODEL_PRICE_REFERENCE;
  if (model === TEAM_MODEL_LLAMA_MODEL) return TEAM_MODEL_LLAMA_PRICE_REFERENCE;
  throw new Error("Unsupported model.");
}
const integer = z.number().int().safe().nonnegative();
const positive = integer.positive();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const teamModelPriceQuoteSchema = z.object({
  operation: z.literal(TEAM_MODEL_TEXT_OPERATION).optional(),
  version: z.literal(TEAM_MODEL_MONEY_VERSION), model: z.enum([TEAM_MODEL_PRICE_REFERENCE.model, TEAM_MODEL_LLAMA_MODEL]),
  sourceVerifiedOn: z.literal(TEAM_MODEL_PRICE_REFERENCE.sourceVerifiedOn), inputContextTokens: z.number().int().positive(),
  inputMicroUsdPerMillionTokens: z.number().int().positive(), outputMicroUsdPerMillionTokens: z.number().int().positive(),
  kind: z.literal("shiba-authorization-estimate"), currency: z.literal("USD"),
  id: z.string().regex(/^tmq_[a-f0-9]{32}$/), createdAt: positive, dispatchUntil: positive, digest,
}).strict();
export type TeamModelPriceQuote = z.infer<typeof teamModelPriceQuoteSchema>;
export const teamModelMoneyContractSchema = z.object({
  currency: z.literal("USD"), budgetMicroUsd: positive.max(TEAM_MODEL_MAX_BUDGET_MICRO_USD),
  maximumDebitPerCallMicroUsd: positive, quote: teamModelPriceQuoteSchema,
}).strict();
export type TeamModelMoneyContract = z.infer<typeof teamModelMoneyContractSchema>;
export const teamModelMoneyStateSchema = z.object({
  currency: z.literal("USD"), authorizedDebitMicroUsd: integer, remainingBudgetMicroUsd: integer,
  reportedQuotedMicroUsd: integer, unknownReservedMicroUsd: integer,
  /** Volatile authorization headroom; a concurrent dispatch can consume it. */
  capacity: z.object({
    requesterLimitMicroUsd: positive, requesterReservedMicroUsd: integer, requesterRemainingMicroUsd: integer,
    requesterCanReserveNext: z.boolean(), workspaceLimitMicroUsd: positive, workspaceCanReserveNext: z.boolean(),
    // Workspace totals are only disclosed to a current deployment funding issuer.
    workspaceReservedMicroUsd: integer.optional(), workspaceRemainingMicroUsd: integer.optional(),
  }).strict().optional(),
}).strict();
export type TeamModelMoneyState = z.infer<typeof teamModelMoneyStateSchema>;
export const teamModelTurnCostSchema = z.object({
  currency: z.literal("USD"), maximumDebitMicroUsd: positive, quoteDigest: digest, dispatchUntil: positive,
  authorizedDebitMicroUsd: integer, reportedQuotedMicroUsd: integer.nullable(),
  state: z.enum(["not-dispatched", "held", "confirmed", "unknown"]),
}).strict().refine((value) => value.state === "not-dispatched"
  ? value.authorizedDebitMicroUsd === 0 && value.reportedQuotedMicroUsd === null
  : value.authorizedDebitMicroUsd === value.maximumDebitMicroUsd && (value.state === "confirmed"
    ? value.reportedQuotedMicroUsd !== null && value.reportedQuotedMicroUsd <= value.authorizedDebitMicroUsd
    : value.reportedQuotedMicroUsd === null), "Invalid quoted authorization receipt.");
export type TeamModelTurnCost = z.infer<typeof teamModelTurnCostSchema>;

/** No floating-point money, free-tier allowance or cache discount. */
export function teamModelQuotedCostMicroUsd(inputTokens: number, outputTokens: number, model: string = TEAM_MODEL_PRICE_REFERENCE.model): number {
  const reference = teamModelPriceReference(model);
  if (![inputTokens, outputTokens].every((value) => Number.isSafeInteger(value) && value >= 0) || inputTokens > reference.inputContextTokens || outputTokens > 1024) throw new Error("Unsupported token bound.");
  const ceil = (amount: bigint) => (amount + 999_999n) / 1_000_000n;
  return Number(ceil(BigInt(inputTokens) * BigInt(reference.inputMicroUsdPerMillionTokens)) + ceil(BigInt(outputTokens) * BigInt(reference.outputMicroUsdPerMillionTokens)));
}
export function teamModelMaximumDebitMicroUsd(outputTokens: number, model: string = TEAM_MODEL_PRICE_REFERENCE.model): number {
  return teamModelQuotedCostMicroUsd(teamModelPriceReference(model).inputContextTokens, outputTokens, model);
}
export function teamModelPriceQuoteDigest(quote: Omit<TeamModelPriceQuote, "digest">): string {
  return stableHash([quote.version, quote.model, quote.sourceVerifiedOn, quote.inputContextTokens,
    quote.inputMicroUsdPerMillionTokens, quote.outputMicroUsdPerMillionTokens, quote.kind, quote.currency,
    quote.id, quote.createdAt, quote.dispatchUntil, ...(quote.operation === undefined ? [] : [quote.operation])]);
}
export function isTeamModelMoneyContract(value: unknown, maxOutputTokens: number): value is TeamModelMoneyContract {
  const parsed = teamModelMoneyContractSchema.safeParse(value);
  if (!parsed.success || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 1024) return false;
  const { digest: actual, ...quote } = parsed.data.quote;
  const reference = teamModelPriceReference(quote.model);
  return quote.inputContextTokens === reference.inputContextTokens && quote.inputMicroUsdPerMillionTokens === reference.inputMicroUsdPerMillionTokens && quote.outputMicroUsdPerMillionTokens === reference.outputMicroUsdPerMillionTokens && quote.dispatchUntil > quote.createdAt && quote.dispatchUntil <= quote.createdAt + 900_000 &&
    teamModelPriceQuoteDigest(quote) === actual && parsed.data.maximumDebitPerCallMicroUsd === teamModelMaximumDebitMicroUsd(maxOutputTokens, quote.model);
}
export function formatMicroUsd(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid USD amount.");
  return `$${Math.floor(value / 1_000_000)}.${String(value % 1_000_000).padStart(6, "0")}`;
}
export function parseMicroUsd(value: string): number | null {
  if (!/^(?:0|1)(?:\.[0-9]{1,6})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const amount = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0"));
  return amount > 0 && amount <= TEAM_MODEL_MAX_BUDGET_MICRO_USD ? amount : null;
}
