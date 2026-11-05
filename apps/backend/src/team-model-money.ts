import { TEAM_MODEL_TEXT_OPERATION, TEAM_MODEL_PRICE_REFERENCE, TEAM_MODEL_LLAMA_MODEL, teamModelPriceReference, teamModelPriceQuoteDigest, teamModelMaximumDebitMicroUsd, teamModelQuotedCostMicroUsd, isTeamModelMoneyContract,
  type TeamModelMoneyContract } from "@shiba/shared";
import { hashToolArgs } from "./mcp-gateway.js";

export class TeamModelMoneyError extends Error { constructor(readonly code: string) { super(code); } }

export const TEAM_MODEL_MONEY_SCHEMA = `CREATE TABLE IF NOT EXISTS team_model_money_ledger (
  turn_id TEXT PRIMARY KEY,grant_id TEXT NOT NULL,workspace_id TEXT NOT NULL,input_hash TEXT NOT NULL,quote_digest TEXT NOT NULL,
  reserved_micro_usd INTEGER NOT NULL CHECK(reserved_micro_usd>0 AND reserved_micro_usd<=8341),
  state TEXT NOT NULL CHECK(state IN ('held','confirmed','unknown')),reported_micro_usd INTEGER,
  receipt_hash TEXT,receipt_json TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
  CHECK(reported_micro_usd IS NULL OR (reported_micro_usd>=0 AND reported_micro_usd<=reserved_micro_usd)))`;
export function prepareTeamModelMoney(budgetMicroUsd: number, maxOutputTokens: number, expiresAt: number, now = Date.now(), model: string = TEAM_MODEL_PRICE_REFERENCE.model): TeamModelMoneyContract {
  const quote = { ...teamModelPriceReference(model), operation: TEAM_MODEL_TEXT_OPERATION as typeof TEAM_MODEL_TEXT_OPERATION, id: `tmq_${crypto.randomUUID().replaceAll("-", "")}`, createdAt: now, dispatchUntil: Math.min(now + 900_000, expiresAt) };
  const money = { currency: "USD" as const, budgetMicroUsd, maximumDebitPerCallMicroUsd: teamModelMaximumDebitMicroUsd(maxOutputTokens, model), quote: { ...quote, digest: teamModelPriceQuoteDigest(quote) } };
  if (!isTeamModelMoneyContract(money, maxOutputTokens)) throw new TeamModelMoneyError("team_model_money_contract_invalid");
  return money;
}
export function requireTeamModelMoney(value: unknown, maxOutputTokens: number, now = Date.now(), expectedModel?: string): TeamModelMoneyContract {
  if (!isTeamModelMoneyContract(value, maxOutputTokens) || (expectedModel !== undefined && value.quote.model !== expectedModel)) throw new TeamModelMoneyError("team_model_budget_upgrade_required");
  if (now < value.quote.createdAt || now >= value.quote.dispatchUntil) throw new TeamModelMoneyError("team_model_price_quote_expired");
  return value;
}
export interface TeamModelUsageReceipt { hash: string; json: string; quotedMicroUsd: number }
/** Usage is a response from this one AI binding call, not an invoice or a refund receipt. */
export async function teamModelUsageReceipt(value: unknown, inputHash: string, maximumOutputTokens: number, model: string = TEAM_MODEL_PRICE_REFERENCE.model, bindingRequestId = ""): Promise<TeamModelUsageReceipt> {
  if (!value || typeof value !== "object") throw new Error("team_model_usage_unknown");
  const response = value as { id?: unknown; model?: unknown; usage?: unknown };
  if ((model === TEAM_MODEL_PRICE_REFERENCE.model && (typeof response.id !== "string" || !response.id || response.id.length > 200 || response.model !== model)) || (model === TEAM_MODEL_LLAMA_MODEL && ((response.model !== undefined && response.model !== model) || (response.id !== undefined && (typeof response.id !== "string" || !response.id || response.id.length > 200)) || !bindingRequestId)) || !response.usage || typeof response.usage !== "object") throw new Error("team_model_usage_unknown");
  const usage = response.usage as Record<string, unknown>;
  const prompt = usage.prompt_tokens, completion = usage.completion_tokens, total = usage.total_tokens;
  if (![prompt, completion, total].every((count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0) ||
    (prompt as number) < 1 || (prompt as number) > teamModelPriceReference(model).inputContextTokens || (completion as number) > maximumOutputTokens || total !== (prompt as number) + (completion as number)) throw new Error("team_model_usage_unknown");
  const quotedMicroUsd = teamModelQuotedCostMicroUsd(prompt as number, completion as number, model);
  const receipt = model === TEAM_MODEL_LLAMA_MODEL
    ? { requestedModel: model, bindingRequestId, providerCompletionId: response.id ?? null, providerModel: response.model ?? null, inputHash, promptTokens: prompt, completionTokens: completion, totalTokens: total, quotedMicroUsd }
    : { completionId: response.id, model: response.model, inputHash, promptTokens: prompt, completionTokens: completion, totalTokens: total, quotedMicroUsd };
  const boundReceipt = { ...receipt, operation: TEAM_MODEL_TEXT_OPERATION };
  return { hash: await hashToolArgs(boundReceipt), json: JSON.stringify(boundReceipt), quotedMicroUsd };
}
export const teamModelLedgerDebitSql = (grant: string) => `COALESCE((SELECT SUM(reserved_micro_usd) FROM team_model_money_ledger WHERE grant_id=${grant}),0)`;
