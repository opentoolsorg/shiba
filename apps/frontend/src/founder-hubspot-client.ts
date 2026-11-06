import { z } from "zod";
import { founderHubSpotDraftSchema, founderHubSpotGrantSchema, founderHubSpotReceiptSchema, type FounderHubSpotDraft, type FounderHubSpotGrant, type FounderHubSpotReceipt } from "@shiba/shared";
import { teamWorkspaceHeaders } from "./team-workspaces-client";

const scope = { workspaceId: z.string(), actorId: z.string() };
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const listSchema = z.object({ ...scope, available: z.boolean(), grants: z.array(founderHubSpotGrantSchema).max(50) });
const detailSchema = z.object({ ...scope, grant: founderHubSpotGrantSchema, receipts: z.array(founderHubSpotReceiptSchema).max(50) });
const decisionSchema = z.object({ ...scope, grant: founderHubSpotGrantSchema });
const draftSchema = z.object({ ...scope, grant: z.object({ id: z.string().regex(/^fhc_[a-f0-9]{32}$/), digest, fingerprint: digest, state: z.literal("draft") }) });
const reportContent = z.object({ format: z.literal("shiba.hubspot-read-report.v1"), accountId: z.string(), grantId: z.string(), revision: z.number().int(), contractDigest: digest, executorDigest: digest, apiVersion: z.literal("crm-v3"), currency: z.string(), timezoneName: z.string(), capturedAt: z.number().int(), capturedBytes: z.number().int().nonnegative().max(32768), notice: z.string(), capture: z.object({ records: z.array(z.object({ dealId: z.string(), properties: z.record(z.string(), z.string().max(500).nullable()) })).max(25), selection: founderHubSpotDraftSchema.shape.selection, captureCompleteness: z.literal("bounded-response"), datasetCompleteness: z.literal("unknown"), businessSuccess: z.literal("unverified") }) });
const reportSchema = z.object({ ...scope, report: z.unknown(), digest });
const decision = (grant: FounderHubSpotGrant) => ({ digest: grant.digest, reviewed: true, readConsent: "allow-exact-daily-hubspot-reads-and-quota", credentialAttestation: "creator-attests-token-appropriate-for-hubspot-deals-read" });
const sameSelection = (a: FounderHubSpotGrant["selection"], b: FounderHubSpotGrant["selection"]) => a.dealIds.length === b.dealIds.length && a.dealIds.every((id, i) => id === b.dealIds[i]) && a.invoiceIdProperty === b.invoiceIdProperty && a.paidAmountProperty === b.paidAmountProperty && a.currencyProperty === b.currencyProperty;
async function readBounded(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new Error("HubSpot response unavailable.");
  const parts: Uint8Array[] = []; let size = 0;
  const aborted = new Promise<never>((_resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
  try { for (;;) { signal.throwIfAborted(); const part = await Promise.race([reader.read(), aborted]); if (part.done) break; size += part.value.byteLength; if (size > 1_048_576) throw new Error("HubSpot response exceeds the review bound."); parts.push(part.value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally { void reader.cancel().catch(() => {}); }
}
/** Native owner scoped client. It does not retain credentials or retry mutations. */
export class FounderHubSpotClient {
  constructor(readonly workspaceId: string, readonly actorId: string, private readonly fetcher: typeof fetch = globalThis.fetch) {
    if (!/^ws_[a-f0-9]{24}$/.test(workspaceId) || !actorId) throw new Error("Select a native workspace and account.");
  }
  private async request<T extends { workspaceId: string; actorId: string }>(path: string, schema: z.ZodType<T>, signal: AbortSignal, body?: unknown): Promise<T> {
    signal.throwIfAborted(); const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const aborted = new Promise<never>((_resolve, reject) => { if (bounded.aborted) reject(bounded.reason); else bounded.addEventListener("abort", () => reject(bounded.reason), { once: true }); });
    const response = await Promise.race([this.fetcher.call(globalThis, `/api/founder-hubspot-reads${path}`, { method: body === undefined ? "GET" : "POST", signal: bounded, credentials: "same-origin", cache: "no-store", redirect: "error", headers: { ...teamWorkspaceHeaders(this.workspaceId), ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), aborted]);
    bounded.throwIfAborted();
    if (!response.ok) throw new Error(response.status === 503 ? "HubSpot reads are unavailable or disabled for this deployment." : "HubSpot read state could not be confirmed. Refresh before another action; no request is retried automatically.");
    let value: T;
    try { value = schema.parse(await readBounded(response, bounded)); } catch (error) { if (bounded.aborted) throw error; throw new Error("HubSpot response could not be verified within the review bound."); }
    bounded.throwIfAborted();
    if (value.workspaceId !== this.workspaceId || value.actorId !== this.actorId) throw new Error("HubSpot response belongs to another workspace or native account.");
    return value;
  }
  async list(signal: AbortSignal) { const value = await this.request("", listSchema, signal); if (new Set(value.grants.map((g) => g.id)).size !== value.grants.length) throw new Error("Duplicate HubSpot grants."); return value; }
  async detail(id: string, signal: AbortSignal) { if (!/^fhc_[a-f0-9]{32}$/.test(id)) throw new Error("Invalid HubSpot grant."); const value = await this.request(`/${id}`, detailSchema, signal); if (value.grant.id !== id || new Set(value.receipts.map((r) => r.id)).size !== value.receipts.length) throw new Error("HubSpot grant identity changed."); return value; }
  async draft(input: FounderHubSpotDraft, signal: AbortSignal) {
    const result = founderHubSpotDraftSchema.safeParse(input); if (!result.success) throw new Error("HubSpot draft fields do not match the supported bounded read contract.");
    const parsed = result.data; const receipt = await this.request("", draftSchema, signal, parsed); const value = await this.detail(receipt.grant.id, signal); const g = value.grant;
    if (g.state !== "draft" || g.expiresAt <= Date.now() || g.digest !== receipt.grant.digest || g.fingerprint !== receipt.grant.fingerprint || g.accountId !== parsed.accountId || g.expiresAt !== parsed.expiresAt || g.maxCalls !== parsed.maxCalls || !sameSelection(g.selection, parsed.selection)) throw new Error("HubSpot draft did not match the exact selection. Refresh without repeating it.");
    return value;
  }
  async decide(grant: FounderHubSpotGrant, action: "verify" | "enable" | "revoke", signal: AbortSignal) {
    const value = await this.request(`/${grant.id}/${action}`, decisionSchema, signal, decision(grant)); const g = value.grant;
    if (g.id !== grant.id || (action !== "verify" && (g.digest !== grant.digest || g.currency !== grant.currency || g.timezoneName !== grant.timezoneName)) || g.revision !== grant.revision || g.accountId !== grant.accountId || g.fingerprint !== grant.fingerprint || g.executorDigest !== grant.executorDigest || g.expiresAt !== grant.expiresAt || g.maxCalls !== grant.maxCalls || !sameSelection(g.selection, grant.selection) || (action === "verify" && (!g.currency || !g.timezoneName || g.digest === grant.digest || g.usedCalls !== grant.usedCalls + 1)) || g.state !== ({ verify: "verified", enable: "enabled", revoke: "revoked" } as const)[action] || (action !== "revoke" && g.expiresAt <= Date.now())) throw new Error("HubSpot decision outcome was not confirmed. Refresh without repeating it.");
    return g;
  }
  async report(grant: FounderHubSpotGrant, receipt: FounderHubSpotReceipt, signal: AbortSignal) {
    if (!/^fhr_[a-f0-9]{32}$/.test(receipt.id) || !/^fhc_[a-f0-9]{32}$/.test(grant.id) || !["enabled", "exhausted"].includes(grant.state) || receipt.state !== "completed" || receipt.expiresAt <= Date.now() || grant.expiresAt <= Date.now()) throw new Error("HubSpot report authority has expired.");
    const value = await this.request(`/${grant.id}/reports/${receipt.id}`, reportSchema, signal); const parsed = reportContent.safeParse(value.report); if (!parsed.success) throw new Error("HubSpot report shape could not be verified."); const report = parsed.data;
    const bytes = new TextEncoder().encode(JSON.stringify(JSON.stringify(value.report))); const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (n) => n.toString(16).padStart(2, "0")).join("");
    signal.throwIfAborted(); if (hash !== value.digest || report.grantId !== grant.id || report.revision !== grant.revision || report.contractDigest !== grant.digest || report.accountId !== grant.accountId || report.currency !== grant.currency || report.timezoneName !== grant.timezoneName || report.executorDigest !== grant.executorDigest || !sameSelection(report.capture.selection, grant.selection) || report.capture.records.length > grant.selection.dealIds.length || new Set(report.capture.records.map((r) => r.dealId)).size !== report.capture.records.length || report.capture.records.some((r) => !grant.selection.dealIds.includes(r.dealId) || Object.keys(r.properties).sort().join(",") !== [grant.selection.invoiceIdProperty, grant.selection.paidAmountProperty, grant.selection.currencyProperty].sort().join(",")) || receipt.expiresAt <= Date.now() || grant.expiresAt <= Date.now()) throw new Error("HubSpot report identity or digest could not be verified.");
    return { ...value, report };
  }
}
