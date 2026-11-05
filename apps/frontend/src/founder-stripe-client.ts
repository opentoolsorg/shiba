import { z } from "zod";
import { founderStripeDraftSchema, founderStripeGrantSchema, founderStripeReceiptSchema, type FounderStripeDraft, type FounderStripeGrant, type FounderStripeReceipt } from "@shiba/shared";
import { teamWorkspaceHeaders } from "./team-workspaces-client";

const scope = { workspaceId: z.string(), actorId: z.string() };
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const listSchema = z.object({ ...scope, available: z.boolean(), grants: z.array(founderStripeGrantSchema).max(50) });
const detailSchema = z.object({ ...scope, grant: founderStripeGrantSchema, receipts: z.array(founderStripeReceiptSchema).max(50) });
const decisionSchema = z.object({ ...scope, grant: founderStripeGrantSchema });
const draftSchema = z.object({ ...scope, grant: z.object({ id: z.string().regex(/^fsc_[a-f0-9]{32}$/), digest, fingerprint: digest, state: z.literal("draft") }) });
const reportSchema = z.object({ ...scope, report: z.object({ format: z.literal("shiba.stripe-read-report.v1"), accountId: z.string(), mode: z.enum(["test", "live"]), grantId: z.string(), revision: z.number().int(), contractDigest: digest, apiVersion: z.string(), capturedAt: z.number().int(), capture: z.unknown(), summary: z.unknown() }).passthrough(), digest });
const decision = (grant: FounderStripeGrant) => ({ digest: grant.digest, reviewed: true, readConsent: "allow-exact-scheduled-stripe-reads-and-quota", readOnlyAttestation: "restricted-key-read-only-for-selected-resources" });
const sameSelection = (a: FounderStripeGrant["selection"], b: FounderStripeGrant["selection"]) => a.kind === b.kind && a.createdGte === b.createdGte && a.createdLt === b.createdLt && a.limit === b.limit;
async function readBounded(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new Error("Stripe response unavailable.");
  const parts: Uint8Array[] = []; let size = 0;
  const aborted = new Promise<never>((_resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
  try { for (;;) { signal.throwIfAborted(); const part = await Promise.race([reader.read(), aborted]); if (part.done) break; size += part.value.byteLength; if (size > 1_048_576) throw new Error("Stripe response exceeds the review bound."); parts.push(part.value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally { void reader.cancel().catch(() => {}); }
}
/** Native owner scoped client. It does not retain credentials or retry mutations. */
export class FounderStripeClient {
  constructor(readonly workspaceId: string, readonly actorId: string, private readonly fetcher: typeof fetch = globalThis.fetch) {
    if (!/^ws_[a-f0-9]{24}$/.test(workspaceId) || !actorId) throw new Error("Select a native workspace and account.");
  }
  private async request<T extends { workspaceId: string; actorId: string }>(path: string, schema: z.ZodType<T>, signal: AbortSignal, body?: unknown): Promise<T> {
    signal.throwIfAborted(); const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const aborted = new Promise<never>((_resolve, reject) => { if (bounded.aborted) reject(bounded.reason); else bounded.addEventListener("abort", () => reject(bounded.reason), { once: true }); });
    const response = await Promise.race([this.fetcher.call(globalThis, `/api/founder-stripe-reads${path}`, { method: body === undefined ? "GET" : "POST", signal: bounded, credentials: "same-origin", cache: "no-store", redirect: "error", headers: { ...teamWorkspaceHeaders(this.workspaceId), ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), aborted]);
    bounded.throwIfAborted();
    if (!response.ok) throw new Error(response.status === 503 ? "Stripe reads are unavailable or disabled for this deployment." : "Stripe read state could not be confirmed. Refresh before another action; no request is retried automatically.");
    let value: T;
    try { value = schema.parse(await readBounded(response, bounded)); } catch (error) { if (bounded.aborted) throw error; throw new Error("Stripe response could not be verified within the review bound."); }
    bounded.throwIfAborted();
    if (value.workspaceId !== this.workspaceId || value.actorId !== this.actorId) throw new Error("Stripe response belongs to another workspace or native account.");
    return value;
  }
  async list(signal: AbortSignal) { const value = await this.request("", listSchema, signal); if (new Set(value.grants.map((g) => g.id)).size !== value.grants.length) throw new Error("Duplicate Stripe grants."); return value; }
  async detail(id: string, signal: AbortSignal) { if (!/^fsc_[a-f0-9]{32}$/.test(id)) throw new Error("Invalid Stripe grant."); const value = await this.request(`/${id}`, detailSchema, signal); if (value.grant.id !== id || new Set(value.receipts.map((r) => r.id)).size !== value.receipts.length) throw new Error("Stripe grant identity changed."); return value; }
  async draft(input: FounderStripeDraft, signal: AbortSignal) {
    const result = founderStripeDraftSchema.safeParse(input); if (!result.success) throw new Error("Stripe draft fields do not match the supported restricted read contract.");
    const parsed = result.data; const receipt = await this.request("", draftSchema, signal, parsed); const value = await this.detail(receipt.grant.id, signal); const g = value.grant;
    if (g.state !== "draft" || g.digest !== receipt.grant.digest || g.fingerprint !== receipt.grant.fingerprint || g.accountId !== parsed.accountId || g.mode !== parsed.mode || g.expiresAt !== parsed.expiresAt || g.maxCalls !== parsed.maxCalls || !sameSelection(g.selection, parsed.selection)) throw new Error("Stripe draft did not match the exact selection. Refresh without repeating it.");
    return value;
  }
  async decide(grant: FounderStripeGrant, action: "verify" | "enable" | "revoke", signal: AbortSignal) {
    const value = await this.request(`/${grant.id}/${action}`, decisionSchema, signal, decision(grant)); const g = value.grant;
    if (g.id !== grant.id || g.digest !== grant.digest || g.revision !== grant.revision || g.accountId !== grant.accountId || g.mode !== grant.mode || g.fingerprint !== grant.fingerprint || g.executorDigest !== grant.executorDigest || g.expiresAt !== grant.expiresAt || g.maxCalls !== grant.maxCalls || !sameSelection(g.selection, grant.selection) || g.state !== ({ verify: "verified", enable: "enabled", revoke: "revoked" } as const)[action]) throw new Error("Stripe decision outcome was not confirmed. Refresh without repeating it.");
    return g;
  }
  async report(grant: FounderStripeGrant, receipt: FounderStripeReceipt, signal: AbortSignal) {
    if (receipt.state !== "completed" || receipt.expiresAt <= Date.now() || grant.expiresAt <= Date.now()) throw new Error("Stripe report authority has expired.");
    const value = await this.request(`/${grant.id}/reports/${receipt.id}`, reportSchema, signal); const report = value.report;
    const bytes = new TextEncoder().encode(JSON.stringify(JSON.stringify(report))); const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (n) => n.toString(16).padStart(2, "0")).join("");
    signal.throwIfAborted(); if (hash !== value.digest || report.grantId !== grant.id || report.revision !== grant.revision || report.contractDigest !== grant.digest || report.accountId !== grant.accountId || report.mode !== grant.mode || receipt.expiresAt <= Date.now() || grant.expiresAt <= Date.now()) throw new Error("Stripe report identity or digest could not be verified.");
    return value;
  }
}
