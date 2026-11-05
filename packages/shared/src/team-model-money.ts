import { z } from "zod";
import { stableHash } from "./approvals.js";

export const TEAM_MODEL_MONEY_VERSION = "shiba.team-cost.v2";
export const TEAM_MODEL_MAX_BUDGET_MICRO_USD = 1_000_000;
export const TEAM_MODEL_PRICE_REFERENCE = {
  version: TEAM_MODEL_MONEY_VERSION, model: "@cf/zai-org/glm-4.7-flash",
  sourceVerifiedOn: "2026-11-05", inputContextTokens: 131_072,
  inputMicroUsdPerMillionTokens: 60_500, outputMicroUsdPerMillionTokens: 400_400,
  kind: "shiba-authorization-estimate", currency: "USD",
} as const;
const integer = z.number().int().safe().nonnegative();
const positive = integer.positive();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const teamModelPriceQuoteSchema = z.object({
  version: z.literal(TEAM_MODEL_MONEY_VERSION), model: z.literal(TEAM_MODEL_PRICE_REFERENCE.model),
  sourceVerifiedOn: z.literal(TEAM_MODEL_PRICE_REFERENCE.sourceVerifiedOn), inputContextTokens: z.literal(131_072),
  inputMicroUsdPerMillionTokens: z.literal(60_500), outputMicroUsdPerMillionTokens: z.literal(400_400),
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
export function teamModelQuotedCostMicroUsd(inputTokens: number, outputTokens: number): number {
  if (![inputTokens, outputTokens].every((value) => Number.isSafeInteger(value) && value >= 0) || inputTokens > 131_072 || outputTokens > 1024) throw new Error("Unsupported token bound.");
  const ceil = (amount: bigint) => (amount + 999_999n) / 1_000_000n;
  return Number(ceil(BigInt(inputTokens) * 60_500n) + ceil(BigInt(outputTokens) * 400_400n));
}
export function teamModelMaximumDebitMicroUsd(outputTokens: number): number {
  return teamModelQuotedCostMicroUsd(131_072, outputTokens);
}
export function teamModelPriceQuoteDigest(quote: Omit<TeamModelPriceQuote, "digest">): string {
  return stableHash([quote.version, quote.model, quote.sourceVerifiedOn, quote.inputContextTokens,
    quote.inputMicroUsdPerMillionTokens, quote.outputMicroUsdPerMillionTokens, quote.kind, quote.currency,
    quote.id, quote.createdAt, quote.dispatchUntil]);
}
export function isTeamModelMoneyContract(value: unknown, maxOutputTokens: number): value is TeamModelMoneyContract {
  const parsed = teamModelMoneyContractSchema.safeParse(value);
  if (!parsed.success || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 1024) return false;
  const { digest: actual, ...quote } = parsed.data.quote;
  return quote.dispatchUntil > quote.createdAt && quote.dispatchUntil <= quote.createdAt + 900_000 &&
    teamModelPriceQuoteDigest(quote) === actual && parsed.data.maximumDebitPerCallMicroUsd === teamModelMaximumDebitMicroUsd(maxOutputTokens);
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
