import { formatMicroUsd, type TeamModelFunding, type TeamModelTurn } from "@shiba/shared";

export const TEAM_MODEL_COST_DISCLOSURE = "This is an application budget at a reviewed reference quote, not a Cloudflare invoice cap or a payment transaction. Provider price changes and rounding, account or provider fees, taxes, Workers, D1, R2 and other infrastructure charges are excluded. Free allocations and cache discounts are not assumed. Full reservations are never released or refunded here.";

export function TeamModelMoneyDetails({ grant }: { grant: TeamModelFunding }) {
  const money = grant.contract.money;
  if (!money) return <p className="mt-2 text-xs">Legacy allowance: no USD budget was approved. New model calls require a fresh funding review. Existing output still requires current source access.</p>;
  return <div className="mt-2 grid gap-2 text-xs">
    <p>Quoted USD budget {formatMicroUsd(money.budgetMicroUsd)} · maximum permanent debit {formatMicroUsd(money.maximumDebitPerCallMicroUsd)} per call.</p>
    {grant.money && <p>Authorized debit {formatMicroUsd(grant.money.authorizedDebitMicroUsd)} · remaining authorization {formatMicroUsd(grant.money.remainingBudgetMicroUsd)} · unknown reserved amount {formatMicroUsd(grant.money.unknownReservedMicroUsd)}. Provider-reported usage at this quote: {formatMicroUsd(grant.money.reportedQuotedMicroUsd)} (informational, no refund).</p>}
    <p>Dispatch quote expires {new Date(money.quote.dispatchUntil).toLocaleString()}. It reserves all {money.quote.inputContextTokens.toLocaleString()} input-context tokens plus the chosen maximum output. Rates: $0.0605 per million input tokens and $0.4004 per million output tokens, rounded upward to microUSD per component.</p>
    <p className="break-all font-mono text-[10px]">Quote {money.quote.id} · {money.quote.digest}</p>
    <p>{TEAM_MODEL_COST_DISCLOSURE}</p>
    <p><a className="underline" href="https://developers.cloudflare.com/workers-ai/platform/pricing/" target="_blank" rel="noreferrer">Cloudflare pricing reference</a> · checked {money.quote.sourceVerifiedOn}. Shiba does not lock the provider's price.</p>
  </div>;
}
export function TeamModelTurnMoney({ turn }: { turn: TeamModelTurn }) {
  if (!turn.cost) return null;
  return <p className="mt-2 text-xs">This exact turn authorizes at most {formatMicroUsd(turn.cost.maximumDebitMicroUsd)} at quote {turn.cost.quoteDigest.slice(0, 12)}. Permanent debit {formatMicroUsd(turn.cost.authorizedDebitMicroUsd)} · receipt {turn.cost.state}. {turn.cost.reportedQuotedMicroUsd === null ? "Usage unconfirmed." : `Provider-reported quoted usage ${formatMicroUsd(turn.cost.reportedQuotedMicroUsd)} is informational.`} Unknown or invalid usage blocks more work; no automatic retry, release or refund.</p>;
}
