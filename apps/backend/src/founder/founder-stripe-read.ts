/** Fixed Stripe response contracts. This module has no credential, fetch, route or scheduler access. */
export const FOUNDER_STRIPE_API_VERSION = "2025-10-29.clover";
export type StripeReadKind = "invoices" | "balance_transactions";
export interface StripeReadSelection { kind: StripeReadKind; createdGte: number; createdLt: number; limit: number }
export interface StripeBalanceRow { id: string; created: number; currency: string; amount: number; fee: number; net: number; type: string; source: string | null }
export interface StripeInvoiceRow { id: string; created: number; currency: string; amountPaid: number; status: string | null; livemode: boolean }
const obj = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("stripe_read_invalid_shape"); return v as Record<string, unknown>; };
const integer = (v: unknown): number => { if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new Error("stripe_read_invalid_shape"); return v; };
const str = (v: unknown, pattern: RegExp): string => { if (typeof v !== "string" || !pattern.test(v)) throw new Error("stripe_read_invalid_shape"); return v; };
const identifier = (v: unknown, prefix: string) => str(v, new RegExp(`^${prefix}_[A-Za-z0-9]{1,200}$`));
/** Explicit fixed date interval, one page and no caller-supplied origin, URL, headers or query. */
export function founderStripeReadUrl(input: StripeReadSelection): string {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join(",") !== "createdGte,createdLt,kind,limit" || !["invoices", "balance_transactions"].includes(input.kind) || !Number.isSafeInteger(input.createdGte) || !Number.isSafeInteger(input.createdLt) || input.createdGte < 0 || input.createdLt <= input.createdGte || input.createdLt - input.createdGte > 31 * 86400 || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 25) throw new Error("stripe_read_selection_invalid");
  const url = new URL(`https://api.stripe.com/v1/${input.kind}`);
  url.searchParams.set("created[gte]", String(input.createdGte)); url.searchParams.set("created[lt]", String(input.createdLt)); url.searchParams.set("limit", String(input.limit));
  return url.href;
}
/** Project only accounting fields; caller must validate the bounded HTTP body before calling. */
export function projectFounderStripeRead(input: StripeReadSelection, wire: unknown, mode: "live" | "test") {
  founderStripeReadUrl(input);
  if (mode !== "live" && mode !== "test") throw new Error("stripe_read_invalid_shape");
  const page = obj(wire);
  if (page.object !== "list" || typeof page.has_more !== "boolean" || !Array.isArray(page.data) || page.data.length > input.limit) throw new Error("stripe_read_invalid_shape");
  const ids = new Set<string>();
  const rows = page.data.map((value): StripeBalanceRow | StripeInvoiceRow => {
    const row = obj(value), created = integer(row.created), currency = str(row.currency, /^[a-z]{3}$/);
    if (created < input.createdGte || created >= input.createdLt) throw new Error("stripe_read_outside_selection");
    if (input.kind === "invoices") {
      const id = identifier(row.id, "in");
      if (row.object !== "invoice" || typeof row.livemode !== "boolean" || row.livemode !== (mode === "live") || !(row.status === null || typeof row.status === "string" && /^(draft|open|paid|uncollectible|void)$/.test(row.status))) throw new Error("stripe_read_invalid_shape");
      if (ids.has(id)) throw new Error("stripe_read_duplicate"); ids.add(id);
      return { id, created, currency, amountPaid: integer(row.amount_paid), status: row.status as string | null, livemode: row.livemode };
    }
    const id = identifier(row.id, "txn"), amount = integer(row.amount), fee = integer(row.fee), net = integer(row.net);
    if (row.object !== "balance_transaction" || BigInt(amount) - BigInt(fee) !== BigInt(net) || !(row.source === null || typeof row.source === "string" && /^[A-Za-z0-9_]{1,200}$/.test(row.source))) throw new Error("stripe_read_invalid_shape");
    if (ids.has(id)) throw new Error("stripe_read_duplicate"); ids.add(id);
    return { id, created, currency, amount, fee, net, type: str(row.type, /^[a-z_]{1,100}$/), source: row.source as string | null };
  });
  return { kind: input.kind, interval: { createdGte: input.createdGte, createdLt: input.createdLt }, hasMore: page.has_more, rows, captureCompleteness: "bounded-response" as const, datasetCompleteness: "unknown" as const, businessSuccess: "unverified" as const };
}
/** Only calculate the arithmetic of captured balance rows, in minor units and separately per currency. */
export function summarizeFounderStripeBalance(rows: readonly StripeBalanceRow[]) {
  if (rows.length > 25) throw new Error("stripe_read_invalid_shape");
  const seen = new Set<string>(), groups = new Map<string, { amount: bigint; fee: bigint; net: bigint; count: number }>();
  for (const row of rows) {
    identifier(row.id, "txn"); str(row.currency, /^[a-z]{3}$/); const amount = BigInt(integer(row.amount)), fee = BigInt(integer(row.fee)), net = BigInt(integer(row.net));
    if (seen.has(row.id) || amount - fee !== net) throw new Error("stripe_read_invalid_shape"); seen.add(row.id);
    const group = groups.get(row.currency) ?? { amount: 0n, fee: 0n, net: 0n, count: 0 }; group.amount += amount; group.fee += fee; group.net += net; group.count++; groups.set(row.currency, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, value]) => ({ currency, count: value.count, amountMinor: value.amount.toString(), feeMinor: value.fee.toString(), netMinor: value.net.toString() }));
}
