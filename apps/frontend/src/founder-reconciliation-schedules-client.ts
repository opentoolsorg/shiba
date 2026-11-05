import { z } from "zod";
import { founderReconciliationScheduleSchema, founderReconciliationScheduleInputSchema, founderReconciliationScheduledResultSchema, founderReconciliationScheduledReportSchema, type FounderReconciliationSchedule, type FounderReconciliationScheduleInput } from "@shiba/shared";
import { teamWorkspaceHeaders } from "./team-workspaces-client";

const base = "/api/founder-reconciliation-schedules";
const hash = z.string().regex(/^[a-f0-9]{64}$/), id = z.string().regex(/^frs_[a-f0-9]{32}$/);
const scope = { workspaceId: z.string(), actorId: z.string() };
const metadata = z.object({ id, digest: hash, state: founderReconciliationScheduleSchema.shape.state, expiresAt: z.number().int() });
const list = z.object({ ...scope, available: z.boolean(), schedules: z.array(metadata).max(50) });
const full = z.object({ ...scope, schedule: founderReconciliationScheduleSchema });
const detail = full.extend({ results: z.array(founderReconciliationScheduledResultSchema).max(50) });
const reduced = z.object({ ...scope, schedule: metadata.omit({ expiresAt: true }) });
const result = z.object({ ...scope, report: z.unknown(), digest: hash });
export type ReconciliationScheduleMetadata = z.infer<typeof metadata>;
export type ReconciliationScheduledResult = z.infer<typeof founderReconciliationScheduledResultSchema>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted(); let release = () => {};
  const cancelled = new Promise<never>((_, reject) => { const stop = () => reject(signal.reason); signal.addEventListener("abort", stop, { once: true }); release = () => signal.removeEventListener("abort", stop); });
  try { return await Promise.race([work, cancelled]); } finally { release(); }
}
async function body(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new Error("Private response unavailable.");
  const chunks: Uint8Array[] = []; let total = 0;
  try { for (;;) { const next = await abortable(reader.read(), signal); if (next.done) break; total += next.value.byteLength; if (total > 1_048_576) throw new Error("Response exceeds the private read bound."); chunks.push(next.value); }
    const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    signal.throwIfAborted(); return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally { void reader.cancel().catch(() => {}); }
}

export class FounderReconciliationSchedulesClient {
  constructor(readonly workspaceId: string, readonly actorId: string, private readonly fetcher: typeof fetch = globalThis.fetch) {
    if (!/^ws_[a-f0-9]{24}$/.test(workspaceId) || !actorId) throw new Error("Select a native workspace and account.");
  }
  private async request<T extends { workspaceId: string; actorId: string }>(path: string, schema: z.ZodType<T>, signal: AbortSignal, input?: unknown): Promise<T> {
    signal.throwIfAborted(); const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const response = await abortable(this.fetcher.call(globalThis, `${base}${path}`, { method: input === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", redirect: "error", signal: bounded, headers: { ...teamWorkspaceHeaders(this.workspaceId), ...(input === undefined ? {} : { "Content-Type": "application/json" }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }), bounded);
    if (!response.ok) throw new Error("Future comparison authority is unavailable or changed. Refresh before another action; nothing is retried automatically.");
    let value: T; try { value = schema.parse(await body(response, bounded)); } catch (cause) { if (bounded.aborted) throw cause; throw new Error("Private comparison response could not be verified."); }
    bounded.throwIfAborted(); if (value.workspaceId !== this.workspaceId || value.actorId !== this.actorId) throw new Error("Response belongs to another native account or workspace."); return value;
  }
  private valid(schedule: FounderReconciliationSchedule) {
    if (schedule.usedComparisons > schedule.maxComparisons || schedule.expiresAt <= Date.now() || schedule.expiresAt > schedule.sourceGrants.hubspot.expiresAt || schedule.expiresAt > schedule.sourceGrants.stripe.expiresAt || schedule.sourceGrants.hubspot.id !== schedule.sampleSources.hubspot.grantId || schedule.sourceGrants.stripe.id !== schedule.sampleSources.stripe.grantId || schedule.sourceGrants.hubspot.revision !== schedule.sampleSources.hubspot.grantVersion || schedule.sourceGrants.stripe.revision !== schedule.sampleSources.stripe.grantRevision) throw new Error("Standing comparison bounds changed or expired.");
    return schedule;
  }
  async list(signal: AbortSignal) { const value = await this.request("", list, signal); if (new Set(value.schedules.map((s) => s.id)).size !== value.schedules.length) throw new Error("Duplicate comparison metadata."); return value; }
  async read(scheduleId: string, signal: AbortSignal) {
    id.parse(scheduleId); const value = await this.request(`/${scheduleId}`, detail, signal); this.valid(value.schedule);
    if (value.schedule.id !== scheduleId || new Set(value.results.map((r) => r.id)).size !== value.results.length || value.results.some((r) => r.scheduleId !== scheduleId)) throw new Error("Standing comparison identity changed."); return value;
  }
  async prepare(input: FounderReconciliationScheduleInput, signal: AbortSignal) {
    const checked = founderReconciliationScheduleInputSchema.parse(input), value = await this.request("", full, signal, checked), s = this.valid(value.schedule);
    if (s.state !== "draft" || s.sampleId !== checked.comparisonId || s.expiresAt !== checked.expiresAt || s.maxComparisons !== checked.maxComparisons || s.maxSkewMinutes !== checked.maxSkewMinutes || s.cutoffAt !== null || s.usedComparisons !== 0) throw new Error("Prepared standing contract differs from the selected bounds."); return s;
  }
  async enable(schedule: FounderReconciliationSchedule, signal: AbortSignal) {
    this.valid(schedule); if (schedule.state !== "draft" || schedule.reviewExpiresAt <= Date.now()) throw new Error("The exact standing review has expired or changed.");
    const value = await this.request(`/${id.parse(schedule.id)}/enable`, full, signal, { digest: schedule.digest, reviewed: true, consent: "allow-future-private-reconciliation-comparisons" }), s = this.valid(value.schedule);
    if (s.id !== schedule.id || s.digest !== schedule.digest || s.state !== "enabled" || s.cutoffAt === null || s.cutoffAt > Date.now() || s.expiresAt !== schedule.expiresAt || s.maxComparisons !== schedule.maxComparisons || s.maxSkewMinutes !== schedule.maxSkewMinutes || s.executorDigest !== schedule.executorDigest || s.sampleHash !== schedule.sampleHash || s.sampleId !== schedule.sampleId || s.reviewExpiresAt !== schedule.reviewExpiresAt || !same(s.sourceGrants, schedule.sourceGrants) || !same(s.mapping, schedule.mapping) || !same(s.sampleSources, schedule.sampleSources)) throw new Error("Standing consent outcome was not confirmed. Refresh without repeating it."); return s;
  }
  async reduce(schedule: Pick<ReconciliationScheduleMetadata, "id" | "digest">, action: "pause" | "revoke", signal: AbortSignal) {
    const value = await this.request(`/${id.parse(schedule.id)}/${action}`, reduced, signal, { digest: hash.parse(schedule.digest) });
    if (value.schedule.id !== schedule.id || value.schedule.digest !== schedule.digest || value.schedule.state !== (action === "pause" ? "paused" : "revoked")) throw new Error("Reduction was not confirmed. Refresh without repeating it."); return value.schedule;
  }
  async report(schedule: FounderReconciliationSchedule, receipt: ReconciliationScheduledResult, signal: AbortSignal) {
    this.valid(schedule); if (!/^frr_[a-f0-9]{32}$/.test(receipt.id) || receipt.scheduleId !== schedule.id || receipt.state !== "completed" || receipt.expiresAt <= Date.now() || !receipt.reportHash || schedule.cutoffAt === null || schedule.state === "revoked") throw new Error("Scheduled result is unavailable or expired.");
    const value = await this.request(`/${schedule.id}/results/${receipt.id}`, result, signal), parsed = founderReconciliationScheduledReportSchema.safeParse(value.report);
    if (!parsed.success) throw new Error("Scheduled report shape could not be verified."); const report = parsed.data;
    const text = JSON.stringify([report.format, receipt.id, receipt.expiresAt, JSON.stringify(value.report)]), actual = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (n) => n.toString(16).padStart(2, "0")).join("");
    const h = report.sources.hubspot, s = report.sources.stripe, original = schedule.sampleSources;
    signal.throwIfAborted();
    if (actual !== value.digest || actual !== receipt.reportHash || report.id !== receipt.id || report.scheduleId !== schedule.id || report.scheduleDigest !== schedule.digest || report.principal.id !== `schedule:${schedule.id}` || !same(report.sourceGrants, schedule.sourceGrants) || !same(report.mapping, schedule.mapping) || h.grantId !== original.hubspot.grantId || h.grantVersion !== original.hubspot.grantVersion || h.accountId !== original.hubspot.accountId || h.currency !== original.hubspot.currency || h.timezoneName !== original.hubspot.timezoneName || h.executorHash !== original.hubspot.executorHash || h.manifestDigest !== original.hubspot.manifestDigest || !same(h.dealIds, original.hubspot.dealIds) || h.occurrenceId === original.hubspot.occurrenceId || s.receiptId === original.stripe.receiptId || s.grantId !== original.stripe.grantId || s.grantRevision !== original.stripe.grantRevision || s.accountId !== original.stripe.accountId || s.mode !== original.stripe.mode || s.executorDigest !== original.stripe.executorDigest || s.createdGte !== original.stripe.createdGte || s.createdLt !== original.stripe.createdLt || h.capturedAt <= schedule.cutoffAt || s.capturedAt <= schedule.cutoffAt || Math.abs(h.capturedAt - s.capturedAt) > schedule.maxSkewMinutes * 60000 || Date.now() >= Math.min(receipt.expiresAt, schedule.expiresAt, h.expiresAt, s.expiresAt)) throw new Error("Scheduled report source, consent, lease or digest changed.");
    return { report, digest: value.digest, expiresAt: Math.min(receipt.expiresAt, schedule.expiresAt, h.expiresAt, s.expiresAt) };
  }
}
