import {
  REPORT_SLACK_DISCLOSURE_SCOPE, REPORT_SLACK_MAX_BYTES, founderSkillIdSchema, reportSlackDecisionSchema, reportSlackPrepareSchema, reportSlackStateSchema,
  type ReportSlackDecision, type ReportSlackIntent, type ReportSlackPrepare, type ReportSlackState,
} from "@shiba/shared";
import { teamWorkspaceHeaders } from "./team-workspaces-client";

export class ReportSlackRequestError extends Error {
  constructor(readonly status: number) {
    super([401, 403, 404].includes(status) ? "Current source ownership, native account or Slack room permission is unavailable. Refresh before continuing."
      : status === 413 ? "The complete report or review response exceeds its size limit. Nothing is truncated; inspect delivery status before another action."
      : status === 409 ? "The report, audience, approval or delivery outcome changed. Refresh and inspect it before another action."
      : "Report delivery is unavailable or unconfirmed. Refresh its status; do not repeat a send with an unknown outcome.");
    this.name = "ReportSlackRequestError";
  }
}
export class ReportSlackClient {
  private actorId: string | null = null;
  private readonly base: string;
  constructor(readonly workspaceId: string, readonly libraryId: string, readonly reportId: string, private readonly fetcher?: typeof fetch) {
    if (!/^ws_[a-f0-9]{24}$/.test(workspaceId) || !/^[A-Za-z0-9_-]{1,200}$/.test(reportId)) throw new Error("Choose the current report and team workspace.");
    founderSkillIdSchema.parse(libraryId);
    this.base = `/api/founder-skills/${encodeURIComponent(libraryId)}/reports/${encodeURIComponent(reportId)}/slack`;
  }
  private async request(suffix: string, signal: AbortSignal, body?: unknown): Promise<ReportSlackState> {
    signal.throwIfAborted();
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(body === undefined ? 15_000 : 45_000)]);
    const init: RequestInit = { method: body === undefined ? "GET" : "POST", credentials: "same-origin", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store", signal: bounded,
      headers: { ...teamWorkspaceHeaders(this.workspaceId), ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    const response = await (this.fetcher ? this.fetcher(this.base + suffix, init) : globalThis.fetch(this.base + suffix, init));
    bounded.throwIfAborted(); if (!response.ok) throw new ReportSlackRequestError(response.status);
    const reader = response.body?.getReader(); if (!reader) throw new Error("Report delivery response was empty.");
    const bytes = new Uint8Array(262_144); let used = 0, value: unknown;
    try {
      for (;;) { bounded.throwIfAborted(); const part = await reader.read(); if (part.done) break;
        if (used + part.value.length > bytes.length) throw new Error("Report delivery response exceeded its review limit.");
        bytes.set(part.value, used); used += part.value.length;
      }
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used))); }
      catch { throw new Error("Report delivery response could not be verified. Refresh its current status."); }
    } finally { await reader.cancel().catch(() => {}); }
    bounded.throwIfAborted(); const checked = reportSlackStateSchema.safeParse(value);
    if (!checked.success) throw new Error("Report delivery response could not be verified. Refresh its current status.");
    const parsed = checked.data;
    if (parsed.workspaceId !== this.workspaceId || parsed.libraryId !== this.libraryId || parsed.reportId !== this.reportId || this.actorId !== null && parsed.actorId !== this.actorId ||
      new Set(parsed.intents.map((item) => item.id)).size !== parsed.intents.length || new Set(parsed.destinations.map((item) => item.linkId)).size !== parsed.destinations.length) throw new Error("Report delivery response belongs to another account, report or workspace. Reopen this panel.");
    for (const intent of parsed.intents) {
      if (new TextEncoder().encode(intent.content).length > REPORT_SLACK_MAX_BYTES ||
        intent.canDisclose && (intent.status !== "draft" || intent.creatorId !== parsed.actorId) || intent.canApprove && intent.status !== "disclosed" ||
        intent.canCancel && (!["draft", "disclosed"].includes(intent.status) || intent.creatorId !== parsed.actorId)) throw new Error("Report delivery capabilities do not match its current state.");
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(intent.content))), (byte) => byte.toString(16).padStart(2, "0")).join("");
      bounded.throwIfAborted(); if (digest !== intent.contentHash) throw new Error("Report delivery content does not match the reviewed hash.");
    }
    this.actorId = parsed.actorId;
    return parsed;
  }
  async read(signal: AbortSignal): Promise<ReportSlackState> { return this.request("", signal); }
  async prepare(input: ReportSlackPrepare, signal: AbortSignal): Promise<ReportSlackState> {
    const parsed = reportSlackPrepareSchema.parse(input), state = await this.request("/preview", signal, parsed);
    if (!state.intents.some((item) => item.reportHash === parsed.reportHash && item.destination.roomId === parsed.roomId && item.destination.linkId === parsed.linkId && item.expiresAt === parsed.expiresAt)) throw new Error("The prepared delivery does not match your selected report, destination and deadline.");
    return state;
  }
  static decision(intent: ReportSlackIntent): ReportSlackDecision { return { expectedVersion: 1, digest: intent.digest, contentHash: intent.contentHash, expiresAt: intent.expiresAt, reviewed: true }; }
  private acknowledged(state: ReportSlackState, expected: ReportSlackIntent, statuses: ReportSlackIntent["status"][]): ReportSlackState {
    const actual = state.intents.find((item) => item.id === expected.id);
    if (!actual || !statuses.includes(actual.status) ||
      (["version", "digest", "reportHash", "sourceHash", "content", "contentHash", "creatorId", "creatorAccountId", "createdAt", "expiresAt", "disclosureScope"] as const).some((key) => actual[key] !== expected[key]) ||
      JSON.stringify(actual.destination) !== JSON.stringify(expected.destination)) throw new Error("The exact report delivery outcome could not be confirmed. Refresh and inspect it before another action.");
    return state;
  }
  async disclose(intent: ReportSlackIntent, signal: AbortSignal): Promise<ReportSlackState> {
    return this.acknowledged(await this.request(`/intents/${encodeURIComponent(intent.id)}/disclose`, signal, { ...reportSlackDecisionSchema.parse(ReportSlackClient.decision(intent)), disclosureConsent: "share-report-to-configured-slack-thread", audienceConsent: REPORT_SLACK_DISCLOSURE_SCOPE }), intent, ["disclosed"]);
  }
  async approve(intent: ReportSlackIntent, signal: AbortSignal): Promise<ReportSlackState> {
    return this.acknowledged(await this.request(`/intents/${encodeURIComponent(intent.id)}/approve`, signal, reportSlackDecisionSchema.parse(ReportSlackClient.decision(intent))), intent, ["sending", "sent", "blocked", "failed", "unknown"]);
  }
  async cancel(intent: ReportSlackIntent, signal: AbortSignal): Promise<ReportSlackState> {
    return this.acknowledged(await this.request(`/intents/${encodeURIComponent(intent.id)}/cancel`, signal, reportSlackDecisionSchema.parse(ReportSlackClient.decision(intent))), intent, ["cancelled"]);
  }
}
