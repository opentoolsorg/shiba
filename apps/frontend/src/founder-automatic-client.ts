import {
  FOUNDER_AUTOMATIC_READ_MAX_LIFETIME_MS, founderSkillIdSchema, founderAutomaticReadInputSchema, founderAutomaticReadStateSchema,
  founderAutomaticReadOptionsSchema, founderAutomaticReadReportSchema, founderAutomaticReadReportHash,
  type FounderAutomaticReadInput, type FounderAutomaticReadState, type FounderAutomaticReadOptions,
  type FounderAutomaticReadGrant, type FounderAutomaticReadReport, type FounderAutomaticReadOccurrence,
} from "@shiba/shared";
import { teamWorkspaceHeaders } from "./team-workspaces-client";

type Scope = { workspaceId: string; libraryId: string; actorId: string };
type Pointer = Pick<FounderAutomaticReadGrant, "id" | "version" | "digest"> & { contract?: FounderAutomaticReadGrant["contract"] };
const canonical = (value: unknown): string => JSON.stringify(value && typeof value === "object" ? Array.isArray(value) ? value.map((item) => JSON.parse(canonical(item))) : Object.fromEntries(Object.keys(value).sort().map((key) => [key, JSON.parse(canonical((value as Record<string, unknown>)[key]))])) : value) ?? "null";
export class FounderAutomaticRequestError extends Error {
  constructor(readonly status: number) {
    super([401, 403, 404].includes(status) ? "Current native workspace, source or scheduled-read access is unavailable. Refresh before continuing."
      : status === 409 ? "The exact scheduled-read grant, source or runtime version changed. Refresh and review again."
        : status === 413 ? "This report or configuration exceeds the supported byte bound. Nothing was silently truncated."
          : "The scheduled-read outcome could not be confirmed. Refresh current state; no request is retried automatically.");
  }
}
async function responseText(response: Response, signal: AbortSignal, limit = 1_048_576) {
  const reader = response.body?.getReader(); if (!reader) throw new Error("The scheduled-read response is empty.");
  const chunks: Uint8Array[] = []; let used = 0;
  try { for (;;) { signal.throwIfAborted(); const next = await reader.read(); if (next.done) break; used += next.value.byteLength;
    if (used > limit) throw new Error("The scheduled-read response exceeds the review limit."); chunks.push(next.value); }
    const bytes = new Uint8Array(used); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally { await reader.cancel().catch(() => {}); }
}
/** Separate standing-read authority. Nothing here calls a provider or starts a schedule on mount. */
export class FounderAutomaticClient {
  private actorId: string | null = null;
  private readonly base: string;
  constructor(readonly workspaceId: string, readonly libraryId: string, private readonly fetcher?: typeof fetch) {
    if (!/^ws_[a-f0-9]{24}$/.test(workspaceId)) throw new Error("Select a team workspace for scheduled reads.");
    founderSkillIdSchema.parse(libraryId); this.base = `/api/founder-skills/${encodeURIComponent(libraryId)}/automatic-reads`;
  }
  private async fetch(suffix: string, signal: AbortSignal, body?: unknown) {
    signal.throwIfAborted(); const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const init: RequestInit = { method: body === undefined ? "GET" : "POST", signal: bounded, credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: { ...teamWorkspaceHeaders(this.workspaceId), ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    const send = this.fetcher, response = await (send ? send(this.base + suffix, init) : globalThis.fetch(this.base + suffix, init));
    bounded.throwIfAborted(); if (!response.ok) throw new FounderAutomaticRequestError(response.status);
    return { response, signal: bounded };
  }
  private async request<T extends Scope>(suffix: string, schema: { parse(value: unknown): T }, signal: AbortSignal, body?: unknown): Promise<T> {
    const result = await this.fetch(suffix, signal, body); let value: T;
    try { value = schema.parse(JSON.parse(await responseText(result.response, result.signal))); }
    catch (cause) { if (result.signal.aborted) throw cause; throw new Error("The exact scheduled-read response could not be verified."); }
    result.signal.throwIfAborted();
    if (value.workspaceId !== this.workspaceId || value.libraryId !== this.libraryId || (this.actorId !== null && value.actorId !== this.actorId)) throw new Error("The scheduled-read response belongs to another native account or workspace.");
    this.actorId = value.actorId; return value;
  }
  private verifyState(state: FounderAutomaticReadState) {
    const grant = state.grant;
    if (grant && (grant.contract.workspaceId !== this.workspaceId || grant.contract.ownerId !== state.actorId || grant.contract.principal.kind !== "schedule" ||
      state.occurrences.some((item) => item.grantId !== grant.id || item.principal.id !== grant.contract.principal.id))) throw new Error("The scheduled-read grant or principal belongs to another owner.");
    if (new Set(state.occurrences.map((item) => item.id)).size !== state.occurrences.length) throw new Error("Duplicate scheduled occurrences could not be verified.");
    return state;
  }
  async state(signal: AbortSignal) { return this.verifyState(await this.request("", founderAutomaticReadStateSchema, signal)); }
  async options(signal: AbortSignal): Promise<FounderAutomaticReadOptions> {
    const value = await this.request("/options", founderAutomaticReadOptionsSchema, signal);
    if (value.connections.some((item) => item.workspaceId !== this.workspaceId) || new Set(value.connections.map((item) => item.id)).size !== value.connections.length || new Set(value.operations.map((item) => item.id)).size !== value.operations.length) throw new Error("The scheduled-read source directory does not match this workspace.");
    return value;
  }
  async configure(input: FounderAutomaticReadInput, signal: AbortSignal): Promise<FounderAutomaticReadState> {
    const parsed = founderAutomaticReadInputSchema.parse(input), now = Date.now();
    if (parsed.expiresAt <= now || parsed.expiresAt > now + FOUNDER_AUTOMATIC_READ_MAX_LIFETIME_MS) throw new Error("Choose an explicit scheduled-read expiry within 28 days.");
    const value = this.verifyState(await this.request("", founderAutomaticReadStateSchema, signal, parsed)), grant = value.grant;
    const fields = ["employeeId", "employeeVersion", "skillId", "skillVersion", "cadence", "localTime", "weekday", "timezone", "expiresAt", "maxOccurrences", "maxCalls", "maxCapturedBytes", "maxBytesPerOccurrence"] as const;
    if (!grant || grant.state !== "draft" || !grant.canEnable || fields.some((key) => grant.contract[key] !== parsed[key]) ||
      canonical(grant.contract.operations.map(({ connectionId, connectionVersion, operationId, arguments: args }) => ({ connectionId, connectionVersion, operationId, arguments: args }))) !== canonical(parsed.operations)) throw new Error("The saved read draft does not match the exact selected sources, arguments and limits.");
    return value;
  }
  async decide(pointer: Pointer, action: "enable" | "pause" | "resume" | "revoke", signal: AbortSignal): Promise<FounderAutomaticReadState> {
    const consent = action === "enable" || action === "resume";
    const value = this.verifyState(await this.request(`/${action}`, founderAutomaticReadStateSchema, signal, { expectedVersion: pointer.version, digest: pointer.digest, reviewed: true,
      ...(consent ? { readConsent: "allow-exact-scheduled-read-operations-and-bounded-provider-calls", quotaConsent: "provider-requests-may-use-account-quota-or-incur-charges" } : {}) }));
    const next = value.grant?.id === pointer.id ? value.grant : value.staleGrant?.id === pointer.id ? value.staleGrant : null;
    if (!next || next.version !== pointer.version + 1 || (pointer.contract && "contract" in next && canonical(next.contract) !== canonical(pointer.contract)) || (action === "revoke" ? next.state !== "revoked" : action === "pause" ? next.state !== "paused" : next.state !== "enabled")) throw new Error("The exact scheduled-read decision was not confirmed. Refresh without repeating it.");
    return value;
  }
  private verifyReport(report: FounderAutomaticReadReport, occurrence: FounderAutomaticReadOccurrence) {
    if (report.id !== occurrence.id || report.grantId !== occurrence.grantId || report.grantVersion !== occurrence.grantVersion || report.principal.id !== occurrence.principal.id || report.expiresAt <= Date.now() ||
      founderAutomaticReadReportHash(report) !== report.reportHash || new TextEncoder().encode(report.markdown + report.json).byteLength > 524_288) throw new Error("The scheduled evidence report identity, exact bytes or expiry could not be verified.");
    return report;
  }
  async report(occurrence: FounderAutomaticReadOccurrence, signal: AbortSignal) {
    if (!occurrence.canReadReport) throw new Error("Current report source authority is required.");
    return this.verifyReport(await this.request(`/occurrences/${encodeURIComponent(occurrence.id)}/report`, founderAutomaticReadReportSchema, signal), occurrence);
  }
  async download(report: FounderAutomaticReadReport, occurrence: FounderAutomaticReadOccurrence, format: "markdown" | "json", signal: AbortSignal) {
    this.verifyReport(report, occurrence);
    const result = await this.fetch(`/occurrences/${encodeURIComponent(occurrence.id)}/report/download?format=${format}`, signal);
    const value = await responseText(result.response, result.signal, 524_288); result.signal.throwIfAborted(); this.verifyReport(report, occurrence);
    if (value !== (format === "markdown" ? report.markdown : report.json)) throw new Error("The scheduled report download differs from the reviewed bytes.");
    return value;
  }
}
