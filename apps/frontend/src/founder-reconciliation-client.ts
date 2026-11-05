import { z } from "zod";
import { founderReconciliationDraftSchema, founderReconciliationInputSchema, founderReconciliationReportSchema, founderStripeGrantSchema, founderStripeReceiptSchema, founderHubSpotGrantSchema, founderHubSpotReceiptSchema, type FounderReconciliationDraft, type FounderReconciliationInput } from "@shiba/shared";
import { teamWorkspaceHeaders } from "./team-workspaces-client";
const scope = { workspaceId: z.string(), actorId: z.string() };
const base = "/api/founder-reconciliations";
const hubspotList = z.object({ ...scope, available: z.boolean(), grants: z.array(founderHubSpotGrantSchema).max(50) });
const hubspotDetail = z.object({ ...scope, grant: founderHubSpotGrantSchema, receipts: z.array(founderHubSpotReceiptSchema).max(50) });
const stripeList = z.object({ ...scope, available: z.boolean(), grants: z.array(founderStripeGrantSchema).max(50) });
const stripeDetail = z.object({ ...scope, grant: founderStripeGrantSchema, receipts: z.array(founderStripeReceiptSchema).max(50) });
const metadata = z.object({ id: z.string().regex(/^frc_[a-f0-9]{32}$/), digest: z.string().regex(/^[a-f0-9]{64}$/), state: z.enum(["draft", "completed", "revoked"]), expiresAt: z.number().int() });
export type ReconciliationMetadata = z.infer<typeof metadata>;
const listSchema = z.object({ ...scope, drafts: z.array(metadata).max(50) });
const revokeSchema = z.object({ ...scope, draft: metadata.omit({ expiresAt: true }) });
const draftSchema = z.object({ ...scope, draft: founderReconciliationDraftSchema });
const resultSchema = z.object({ ...scope, draft: founderReconciliationDraftSchema, report: z.unknown() });
const rollingMetricSchema = z.enum(["invoice-paid-snapshot", "mrr", "churn"]);
export type RollingMetric = z.infer<typeof rollingMetricSchema>;
const rollingSelectionSchema = z.object({ asOf: z.number().int().nonnegative().max(253402300799), periodDays: z.number().int().min(1).max(28), metric: rollingMetricSchema });
export type RollingSelection = z.infer<typeof rollingSelectionSchema>;
const rollingReportSchema = z.object({
  format: z.literal("shiba.founder-reconciliation.rolling-view.v1"),
  sourceReportId: z.string(), sourceReportHash: z.string(), sourceExecutorDigest: z.string(),
  sources: founderReconciliationReportSchema.shape.sources, mapping: founderReconciliationReportSchema.shape.mapping,
  provenance: z.object({ reviewDigest: z.string(), reportId: z.string(), reportHash: z.string(), executorDigest: z.string() }),
  selectedMetric: rollingMetricSchema,
  metricAvailability: z.object({ status: z.enum(["qualified", "unavailable"]), missingDataReasons: z.array(z.string()).max(30) }),
  completeness: z.object({ reasons: z.array(z.string()).max(30), statusCounts: z.record(z.string(), z.number().int().nonnegative()), captureSkewMs: z.number().int().nonnegative(), sourceAgesMs: z.object({ hubspot: z.number().int().nonnegative(), stripe: z.number().int().nonnegative() }) }),
  period: z.object({ timezone: z.literal("UTC"), durationSeconds: z.number().int().positive(), basis: z.literal("stripe-invoice-created-unix-seconds"), createdGte: z.number().int(), createdLt: z.number().int(), periodDays: z.number().int().min(1).max(28), boundary: z.literal("inclusive-start-exclusive-end") }),
  metricDefinition: z.string(), rows: founderReconciliationReportSchema.shape.rows, unassignedRows: founderReconciliationReportSchema.shape.rows,
  outsidePeriodRowCount: z.number().int().nonnegative(), perCurrency: founderReconciliationReportSchema.shape.perCurrency,
  notice: z.string(), datasetCompleteness: z.literal("unknown"), businessSuccess: z.literal("unverified"),
});
export type RollingReport = z.infer<typeof rollingReportSchema>;
async function bounded(response: Response, signal: AbortSignal) { const reader = response.body?.getReader(); if (!reader) throw new Error("Private response unavailable."); const chunks: Uint8Array[] = []; let size = 0;
  const abort = new Promise<never>((_, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
  try { for (;;) { const item = await Promise.race([reader.read(), abort]); if (item.done) break; size += item.value.byteLength; if (size > 1_048_576) throw new Error("Response exceeds bound."); chunks.push(item.value); }
    const bytes = new Uint8Array(size); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; } return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally { void reader.cancel().catch(() => {}); }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export class FounderReconciliationClient {
  constructor(readonly workspaceId: string, readonly actorId: string, private readonly fetcher: typeof fetch = globalThis.fetch) { if (!/^ws_[a-f0-9]{24}$/.test(workspaceId) || !actorId) throw new Error("Select a native account and workspace."); }
  private async request<T extends { workspaceId: string; actorId: string }>(path: string, schema: z.ZodType<T>, signal: AbortSignal, body?: unknown) {
    signal.throwIfAborted(); const limited = AbortSignal.any([signal, AbortSignal.timeout(30_000)]); const abort = new Promise<never>((_, reject) => { if (limited.aborted) reject(limited.reason); else limited.addEventListener("abort", () => reject(limited.reason), { once: true }); });
    const response = await Promise.race([this.fetcher.call(globalThis, path, { method: body === undefined ? "GET" : "POST", signal: limited, credentials: "same-origin", cache: "no-store", redirect: "error", headers: { ...teamWorkspaceHeaders(this.workspaceId), ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), abort]);
    if (!response.ok) throw new Error("Private reconciliation source or action is unavailable. Refresh before another action; no request is retried automatically.");
    let value: T; try { value = schema.parse(await bounded(response, limited)); } catch (cause) { if (limited.aborted) throw cause; throw new Error("Private reconciliation response could not be verified."); }
    limited.throwIfAborted(); if (value.workspaceId !== this.workspaceId || value.actorId !== this.actorId) throw new Error("Response belongs to another native workspace or account."); return value;
  }
  async sources(signal: AbortSignal) { const [hubspot, stripe] = await Promise.all([this.request("/api/founder-hubspot-reads", hubspotList, signal), this.request("/api/founder-stripe-reads", stripeList, signal)]); return { hubspot, stripe }; }
  async hubspotReceipts(id: string, signal: AbortSignal) { if (!/^fhc_[a-f0-9]{32}$/.test(id)) throw new Error("Invalid HubSpot source grant."); const value = await this.request(`/api/founder-hubspot-reads/${id}`, hubspotDetail, signal); if (value.grant.id !== id) throw new Error("HubSpot source grant changed."); return value; }
  async stripeReceipts(id: string, signal: AbortSignal) { if (!/^fsc_[a-f0-9]{32}$/.test(id)) throw new Error("Invalid source grant."); const value = await this.request(`/api/founder-stripe-reads/${id}`, stripeDetail, signal); if (value.grant.id !== id) throw new Error("Source grant changed."); return value; }
  async list(signal: AbortSignal) { const value = await this.request(base, listSchema, signal); if (new Set(value.drafts.map((d) => d.id)).size !== value.drafts.length) throw new Error("Duplicate comparison metadata."); return value; }
  private async verifyReport(draft: FounderReconciliationDraft, raw: unknown, signal: AbortSignal) {
    if (raw === null && draft.state !== "completed") return null;
    const parsed = founderReconciliationReportSchema.safeParse(raw); if (!parsed.success) throw new Error("Comparison report shape could not be verified."); const report = parsed.data;
    const data = JSON.stringify(["shiba.founder-reconciliation.report.v1", draft.id, draft.expiresAt, JSON.stringify(raw)]);
    const actual = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data))), (n) => n.toString(16).padStart(2, "0")).join("");
    signal.throwIfAborted(); if (draft.state !== "completed" || draft.expiresAt <= Date.now() || draft.sources.hubspot.expiresAt <= Date.now() || draft.sources.stripe.expiresAt <= Date.now() || actual !== draft.reportHash || report.id !== draft.id || !same(report.sources, draft.sources) || !same(report.mapping, draft.mapping)) throw new Error("Report identity, source authority or digest changed."); return report;
  }
  async detail(id: string, signal: AbortSignal) { if (!/^frc_[a-f0-9]{32}$/.test(id)) throw new Error("Invalid draft."); const value = await this.request(`${base}/${id}`, resultSchema, signal); if (value.draft.id !== id) throw new Error("Draft identity changed."); return { draft: value.draft, report: await this.verifyReport(value.draft, value.report, signal) }; }
  async draft(input: FounderReconciliationInput, signal: AbortSignal) { const checked = founderReconciliationInputSchema.safeParse(input); if (!checked.success) throw new Error("Comparison mapping is unsupported."); const parsed = checked.data, value = await this.request(base, draftSchema, signal, parsed), d = value.draft;
    if (d.state !== "draft" || d.expiresAt <= Date.now() || d.sources.hubspot.expiresAt <= Date.now() || d.sources.stripe.expiresAt <= Date.now() || d.expiresAt !== parsed.expiresAt || !same(d.mapping, parsed.mapping) || d.sources.hubspot.grantId !== parsed.hubspot.grantId || d.sources.hubspot.grantVersion !== parsed.hubspot.grantVersion || d.sources.hubspot.occurrenceId !== parsed.hubspot.occurrenceId || d.sources.hubspot.sourceOrdinal !== parsed.hubspot.sourceOrdinal || d.sources.stripe.grantId !== parsed.stripe.grantId || d.sources.stripe.receiptId !== parsed.stripe.receiptId || d.expiresAt > d.sources.hubspot.expiresAt || d.expiresAt > d.sources.stripe.expiresAt) throw new Error("Draft differs from selected sources or expires after them."); return d; }
  async revoke(draft: Pick<ReconciliationMetadata, "id" | "digest">, signal: AbortSignal) {
    if (!/^frc_[a-f0-9]{32}$/.test(draft.id)) throw new Error("Invalid draft.");
    const value = await this.request(`${base}/${draft.id}/revoke`, revokeSchema, signal, { digest: draft.digest });
    if (value.draft.id !== draft.id || value.draft.digest !== draft.digest || value.draft.state !== "revoked") throw new Error("Revocation was not confirmed."); return value;
  }
  async compose(draft: FounderReconciliationDraft, signal: AbortSignal) {
    if (draft.expiresAt <= Date.now() || draft.sources.hubspot.expiresAt <= Date.now() || draft.sources.stripe.expiresAt <= Date.now()) throw new Error("Source or draft expired.");
    const value = await this.request(`${base}/${draft.id}/compose`, resultSchema, signal, { digest: draft.digest, reviewed: true, consent: "compare-exact-captured-receipts" });
    if (value.draft.id !== draft.id || value.draft.digest !== draft.digest || !same(value.draft.sources, draft.sources) || !same(value.draft.mapping, draft.mapping) || value.draft.expiresAt !== draft.expiresAt || value.draft.state !== "completed") throw new Error("Exact comparison decision was not confirmed.");
    return { draft: value.draft, report: await this.verifyReport(value.draft, value.report, signal) };
  }
  async rolling(draft: FounderReconciliationDraft, selection: RollingSelection, signal: AbortSignal) {
    const input = rollingSelectionSchema.parse(selection), now = Date.now();
    const validAuthority = () => draft.state === "completed" && draft.reportHash && draft.expiresAt > Date.now() && draft.sources.hubspot.expiresAt > Date.now() && draft.sources.stripe.expiresAt > Date.now();
    if (!validAuthority()) throw new Error("Completed reviewed capture authority is unavailable or expired.");
    if (draft.sources.hubspot.capturedAt > now || draft.sources.stripe.capturedAt > now || input.asOf > Math.floor(now / 1000) || input.asOf > draft.sources.stripe.createdLt || input.asOf - input.periodDays * 86400 < draft.sources.stripe.createdGte) throw new Error("UTC period must be contained within the capture and cannot be in the future.");
    const value = await this.request(`${base}/${draft.id}/rolling`, z.object({ ...scope, report: rollingReportSchema }), signal, { digest: draft.digest, reviewed: true, consent: "filter-captured-invoice-created-window-not-revenue-mrr-or-churn", ...input });
    const report = value.report;
    if (!validAuthority() || report.sourceReportId !== draft.id || report.sourceReportHash !== draft.reportHash || report.sourceExecutorDigest !== draft.executorDigest || !same(report.sources, draft.sources) || !same(report.mapping, draft.mapping) || !same(report.provenance, { reviewDigest: draft.digest, reportId: draft.id, reportHash: draft.reportHash, executorDigest: draft.executorDigest }) || report.selectedMetric !== input.metric || report.period.createdLt !== input.asOf || report.period.createdGte !== input.asOf - input.periodDays * 86400 || report.period.periodDays !== input.periodDays || report.period.durationSeconds !== input.periodDays * 86400) throw new Error("Exact rolling period, metric or source provenance changed.");
    if (input.metric === "invoice-paid-snapshot" ? report.metricAvailability.status !== "qualified" || report.metricAvailability.missingDataReasons.length !== 0 : report.metricAvailability.status !== "unavailable" || report.metricAvailability.missingDataReasons.length === 0 || report.perCurrency.length !== 0) throw new Error("Metric availability could not be verified.");
    return report;
  }

}
