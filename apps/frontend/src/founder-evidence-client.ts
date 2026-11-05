import {
  founderSkillIdSchema, founderEvidenceOptionsSchema, founderEvidencePreviewSchema, founderEvidenceRecordSchema,
  founderEvidenceListSchema, founderEvidenceRevokeResponseSchema, founderEvidenceInputSchema, founderEvidenceReportHash,
  type FounderEvidenceOptions, type FounderEvidenceInput, type FounderEvidencePreview, type FounderEvidenceRecord,
  type FounderEvidenceReceiptRef, type FounderEvidenceSummary,
} from "@shiba/shared";
import { teamWorkspaceHeaders } from "./team-workspaces-client";

type Scope = { workspaceId: string; libraryId: string; actorId: string };
type Parser<T> = { parse(value: unknown): T };
export class FounderEvidenceRequestError extends Error {
  constructor(readonly status: number) {
    super([401, 403, 404].includes(status) ? "Current native workspace or receipt access is unavailable. Refresh before continuing."
      : status === 409 ? "The selected receipts, source versions or report changed. Refresh and preview again."
        : status === 413 ? "The selected stored excerpts exceed the report limit. Select fewer receipts. Nothing was truncated."
          : "The evidence response could not be verified. Inspect current state before another change.");
    this.name = "FounderEvidenceRequestError";
  }
}
async function text(response: Response, signal: AbortSignal, limit = 1_048_576): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The evidence response is empty.");
  const bytes = new Uint8Array(limit); let used = 0;
  try {
    for (;;) {
      signal.throwIfAborted(); const chunk = await reader.read(); if (chunk.done) break;
      if (used + chunk.value.length > limit) throw new Error("The evidence response exceeds the review limit.");
      bytes.set(chunk.value, used); used += chunk.value.length;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used));
  } finally { await reader.cancel().catch(() => {}); }
}
function refs(values: readonly FounderEvidenceReceiptRef[]): string {
  return JSON.stringify(values.map(({ approvalId, inputHash, resultDigest }) => ({ approvalId, inputHash, resultDigest })).sort((a, b) => a.approvalId < b.approvalId ? -1 : a.approvalId > b.approvalId ? 1 : 0));
}

/** Private authenticated reads only. This client never invokes an app, model or automatic download. */
export class FounderEvidenceClient {
  private actorId: string | null = null;
  private readonly base: string;
  constructor(readonly workspaceId: string, readonly libraryId: string, private readonly fetcher?: typeof fetch) {
    if (!/^ws_[a-f0-9]{24}$/.test(workspaceId)) throw new Error("Select a team workspace for private evidence reports.");
    founderSkillIdSchema.parse(libraryId);
    this.base = `/api/founder-skills/${encodeURIComponent(libraryId)}/reports`;
  }
  private async fetch(suffix: string, signal: AbortSignal, body?: unknown) {
    signal.throwIfAborted(); const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const init: RequestInit = { method: body === undefined ? "GET" : "POST", signal: bounded, credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: { ...teamWorkspaceHeaders(this.workspaceId), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    const send = this.fetcher;
    const response = await (send ? send(this.base + suffix, init) : globalThis.fetch(this.base + suffix, init));
    bounded.throwIfAborted();
    if (!response.ok) throw new FounderEvidenceRequestError(response.status);
    return { response, signal: bounded };
  }
  private async request<T extends Scope>(suffix: string, schema: Parser<T>, signal: AbortSignal, body?: unknown): Promise<T> {
    const result = await this.fetch(suffix, signal, body);
    let value: T;
    try { value = schema.parse(JSON.parse(await text(result.response, result.signal))); }
    catch (cause) { if (result.signal.aborted) throw cause; throw new Error("The evidence response could not be verified. Refresh before continuing."); }
    result.signal.throwIfAborted();
    if (value.workspaceId !== this.workspaceId || value.libraryId !== this.libraryId || (this.actorId !== null && value.actorId !== this.actorId)) throw new Error("The evidence response belongs to another native account or workspace.");
    this.actorId = value.actorId; return value;
  }
  private verify<T extends FounderEvidencePreview>(value: T): T {
    if (value.workspaceId !== this.workspaceId || value.libraryId !== this.libraryId || (this.actorId !== null && value.actorId !== this.actorId) ||
      founderEvidenceReportHash(value) !== value.reportHash || value.expiresAt <= Date.now() ||
      value.receipts.some((receipt) => receipt.employeeId !== value.employeeId || receipt.employeeVersion !== value.employeeVersion ||
        (receipt.contextExpiresAt !== null && value.expiresAt > receipt.contextExpiresAt))) throw new Error("The exact evidence content, source lease or hash could not be verified.");
    try { const json: unknown = JSON.parse(value.json); if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("invalid_json"); }
    catch { throw new Error("The evidence JSON could not be verified."); }
    return value;
  }
  async options(signal: AbortSignal, employee?: { id: string; version: number }): Promise<FounderEvidenceOptions> {
    const suffix = employee ? `?${new URLSearchParams({ employeeId: employee.id, employeeVersion: String(employee.version) })}` : "";
    const value = await this.request(`/options${suffix}`, founderEvidenceOptionsSchema, signal);
    if (new Set(value.receipts.map((item) => item.approvalId)).size !== value.receipts.length || value.receipts.some((item) => !employee || item.employeeId !== employee.id || item.employeeVersion !== employee.version)) throw new Error("The receipt directory does not match the selected employee version.");
    return value;
  }
  async list(signal: AbortSignal) {
    const value = await this.request("", founderEvidenceListSchema, signal);
    if (new Set(value.reports.map((item) => item.id)).size !== value.reports.length) throw new Error("Duplicate private report records could not be verified.");
    return value;
  }
  async preview(input: FounderEvidenceInput, signal: AbortSignal): Promise<FounderEvidencePreview> {
    const parsed = founderEvidenceInputSchema.parse(input);
    if (parsed.expiresAt <= Date.now() || parsed.expiresAt > Date.now() + 86_400_000) throw new Error("Choose an absolute expiry within the next 24 hours.");
    const value = this.verify(await this.request("/preview", founderEvidencePreviewSchema, signal, parsed));
    if (!value.canCreate || ["employeeId", "employeeVersion", "skillId", "skillVersion"].some((key) => value[key as keyof FounderEvidencePreview] !== input[key as keyof FounderEvidenceInput]) ||
      refs(value.receipts) !== refs(input.receipts) || value.expiresAt > input.expiresAt) throw new Error("The evidence preview does not match your selected source receipts.");
    return value;
  }
  async create(input: FounderEvidenceInput, preview: FounderEvidencePreview, requestId: string, signal: AbortSignal): Promise<FounderEvidenceRecord> {
    this.verify(preview);
    founderEvidenceInputSchema.parse(input);
    if (!preview.canCreate || refs(preview.receipts) !== refs(input.receipts) || preview.expiresAt > input.expiresAt ||
      ["employeeId", "employeeVersion", "skillId", "skillVersion"].some((key) => preview[key as keyof FounderEvidencePreview] !== input[key as keyof FounderEvidenceInput])) throw new Error("Review the exact current preview before creating a report.");
    const value = this.verify(await this.request("", founderEvidenceRecordSchema, signal, { ...input, expectedReportHash: preview.reportHash, requestId }));
    if (value.reportHash !== preview.reportHash || value.manifestDigest !== preview.manifestDigest || value.markdown !== preview.markdown || value.json !== preview.json ||
      value.state !== "active" || !value.canRead || refs(value.receipts) !== refs(preview.receipts)) throw new Error("The created report does not match the reviewed evidence bytes.");
    return value;
  }
  async read(id: string, signal: AbortSignal, expectedHash?: string): Promise<FounderEvidenceRecord> {
    const value = this.verify(await this.request(`/${encodeURIComponent(id)}`, founderEvidenceRecordSchema, signal));
    if (value.id !== id || (expectedHash && value.reportHash !== expectedHash) || value.state !== "active" || !value.canRead) throw new Error("The private report identity or read permission could not be verified.");
    return value;
  }
  async revoke(report: Pick<FounderEvidenceSummary, "id" | "reportHash">, signal: AbortSignal): Promise<FounderEvidenceSummary> {
    const value = await this.request(`/${encodeURIComponent(report.id)}/revoke`, founderEvidenceRevokeResponseSchema, signal, { expectedReportHash: report.reportHash });
    if (value.report.id !== report.id || value.report.reportHash !== report.reportHash || value.report.state !== "revoked" || value.report.canRead) throw new Error("The exact report revocation could not be confirmed.");
    return value.report;
  }
  async download(report: FounderEvidenceRecord, format: "markdown" | "json", signal: AbortSignal): Promise<string> {
    this.verify(report);
    if (!report.canRead || report.state !== "active") throw new Error("Current private read permission is required.");
    const result = await this.fetch(`/${encodeURIComponent(report.id)}/download?format=${format}`, signal);
    const value = await text(result.response, result.signal, 262_144);
    result.signal.throwIfAborted(); this.verify(report);
    if (value !== (format === "markdown" ? report.markdown : report.json)) throw new Error("The downloaded bytes do not match the exact private report.");
    return value;
  }
}
