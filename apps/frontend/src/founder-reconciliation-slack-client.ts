import { z } from "zod";
import { reconciliationSlackDecisionSchema, reconciliationSlackDisclosureSchema, reconciliationSlackDiscoverySchema, reconciliationSlackGrantSchema, reconciliationSlackPrepareSchema, reconciliationSlackReductionSchema, type ReconciliationSlackGrant, type ReconciliationSlackPrepare } from "@shiba/shared";
const base = "/api/founder-reconciliation-slack";
const scope = { workspaceId: z.string(), actorId: z.string() };
const envelope = z.strictObject({ ...scope, grant: reconciliationSlackGrantSchema });
const reductionEnvelope = z.strictObject({ ...scope, grant: reconciliationSlackReductionSchema });
export type ReconciliationSlackPointer = { id: string; digest: string; expiresAt: number };
const identity = (id: string) => /^arsg_[a-f0-9]{32}$/.test(id);
function frozenSchedule(grant: ReconciliationSlackGrant) { const { state: _state, usedComparisons: _used, nextDueAt: _next, ...fixed } = grant.schedule; return fixed; }
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export function reconciliationSlackDeadline(grant: ReconciliationSlackGrant) { return Math.min(grant.expiresAt, grant.reviewExpiresAt, grant.sampleExpiresAt ?? 0, grant.schedule.expiresAt, grant.schedule.hubspotGrantExpiresAt, grant.schedule.stripeGrantExpiresAt, grant.schedule.sourceGrants.hubspot.expiresAt, grant.schedule.sourceGrants.stripe.expiresAt, grant.destination.installation?.expiresAt ?? Number.MAX_SAFE_INTEGER); }
async function bounded(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader(); if (!reader) throw new Error("Response unavailable."); const chunks: Uint8Array[] = []; let size = 0;
  const aborted = new Promise<never>((_, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
  void aborted.catch(() => {});
  try { for (;;) { signal.throwIfAborted(); const part = await Promise.race([reader.read(), aborted]); if (part.done) break; size += part.value.byteLength; if (size > 131072) throw new Error("Response too large."); chunks.push(part.value); }
    const bytes = new Uint8Array(size); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; } return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally { void reader.cancel().catch(() => {}); }
}
export class FounderReconciliationSlackClient {
  constructor(readonly workspaceId: string, readonly actorId: string, private readonly fetcher: typeof fetch = globalThis.fetch) { if (!/^ws_[a-f0-9]{24}$/.test(workspaceId) || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(actorId) || actorId !== actorId.toLowerCase()) throw new Error("Native workspace required."); }
  private async request<T extends { workspaceId: string; actorId: string }>(path: string, schema: z.ZodType<T>, signal: AbortSignal, body?: unknown): Promise<T> {
    signal.throwIfAborted(); const limited = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    const aborted = new Promise<never>((_, reject) => { if (limited.aborted) reject(limited.reason); else limited.addEventListener("abort", () => reject(limited.reason), { once: true }); });
    void aborted.catch(() => {});
    const response = await Promise.race([this.fetcher.call(globalThis, base + path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: limited, headers: { "X-Shiba-Workspace": this.workspaceId, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), aborted]);
    if (!response.ok) throw new Error("Delivery access or outcome is unavailable. Refresh before another decision; nothing is retried automatically.");
    let result: T; try { result = schema.parse(await bounded(response, limited)); } catch (cause) { if (limited.aborted) throw cause; throw new Error("Delivery response could not be verified."); }
    limited.throwIfAborted(); if (result.workspaceId !== this.workspaceId || result.actorId !== this.actorId) throw new Error("Native account or workspace changed."); return result;
  }
  private check(grant: ReconciliationSlackGrant) {
    if (!identity(grant.id) || !grant.destination.installation || grant.usedSends > grant.maxSends || (grant.state === "draft" && grant.ownerId !== this.actorId) || (grant.sampleContent !== null && (new TextEncoder().encode(grant.sampleContent).length > 3500 || !grant.sampleExpiresAt))) throw new Error("Delivery grant or sample is invalid.");
    return grant;
  }
  async discover(signal: AbortSignal) { const result = await this.request("", reconciliationSlackDiscoverySchema, signal); if (result.grants.some((g) => !identity(g.id)) || new Set(result.grants.map((g) => g.id)).size !== result.grants.length || new Set(result.destinations.map((d) => d.linkId)).size !== result.destinations.length) throw new Error("Delivery metadata changed."); return result; }
  async read(id: string, signal: AbortSignal) { if (!identity(id)) throw new Error("Invalid delivery grant."); const result = this.check((await this.request(`/${id}`, envelope, signal)).grant); if (result.id !== id || (result.sampleContent !== null && reconciliationSlackDeadline(result) <= Date.now())) throw new Error("Delivery grant or sample lease changed."); return result; }
  async prepare(input: ReconciliationSlackPrepare, signal: AbortSignal) { const checked = reconciliationSlackPrepareSchema.parse(input), grant = this.check((await this.request("", envelope, signal, checked)).grant);
    if (grant.state !== "draft" || grant.ownerId !== this.actorId || grant.schedule.id !== checked.scheduleId || grant.sampleResultId !== checked.sampleResultId || grant.sampleHash !== checked.sampleHash || grant.destination.roomId !== checked.roomId || grant.destination.linkId !== checked.linkId || grant.maxSends !== checked.maxSends || grant.expiresAt !== checked.expiresAt || !grant.sampleContent || reconciliationSlackDeadline(grant) <= Date.now()) throw new Error("The exact prepared delivery could not be verified."); return grant; }
  async decide(grant: ReconciliationSlackGrant, action: "disclose" | "approve", signal: AbortSignal) {
    if (reconciliationSlackDeadline(grant) <= Date.now() || !grant.sampleContent || (action === "disclose" ? grant.ownerId !== this.actorId || grant.state !== "draft" : grant.ownerId === this.actorId || grant.state !== "disclosed")) throw new Error("Current distinct human review is required.");
    const baseDecision = reconciliationSlackDecisionSchema.parse({ expectedVersion: 1, digest: grant.digest, expiresAt: grant.expiresAt, reviewed: true });
    const body = action === "disclose" ? reconciliationSlackDisclosureSchema.parse({ ...baseDecision, futureReportConsent: "share-future-combined-reconciliation-results-from-this-exact-schedule", audienceConsent: "all-current-and-future-people-with-access-to-selected-slack-channel-thread" }) : baseDecision;
    const next = this.check((await this.request(`/${grant.id}/${action}`, envelope, signal, body)).grant);
    if (next.id !== grant.id || next.digest !== grant.digest || next.ownerId !== grant.ownerId || next.ownerAccountId !== grant.ownerAccountId || next.expiresAt !== grant.expiresAt || next.createdAt !== grant.createdAt || next.reviewExpiresAt !== grant.reviewExpiresAt || next.maxSends !== grant.maxSends || next.renderPolicy !== grant.renderPolicy || next.rendererDigest !== grant.rendererDigest || next.sampleResultId !== grant.sampleResultId || next.sampleHash !== grant.sampleHash || next.sampleContent !== grant.sampleContent || next.sampleExpiresAt !== grant.sampleExpiresAt || !same(next.destination, grant.destination) || !same(frozenSchedule(next), frozenSchedule(grant)) || next.state !== (action === "disclose" ? "disclosed" : "enabled") || (action === "approve" && (next.approvedBy !== this.actorId || next.approvedAt === null)) || reconciliationSlackDeadline(next) <= Date.now()) throw new Error("Exact delivery decision could not be verified.");
    return next;
  }
  async reduce(pointer: ReconciliationSlackPointer, action: "pause" | "revoke", signal: AbortSignal) {
    if (!identity(pointer.id)) throw new Error("Invalid delivery grant.");
    const body = reconciliationSlackDecisionSchema.parse({ expectedVersion: 1, digest: pointer.digest, expiresAt: pointer.expiresAt, reviewed: true });
    const result = (await this.request(`/${pointer.id}/${action}`, reductionEnvelope, signal, body)).grant;
    if (result.id !== pointer.id || result.digest !== pointer.digest || result.state !== (action === "pause" ? "paused" : "revoked")) throw new Error("Reduction was not confirmed."); return result;
  }
}
