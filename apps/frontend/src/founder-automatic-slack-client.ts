import {
  AUTOMATIC_SLACK_AUDIENCE_CONSENT, AUTOMATIC_SLACK_FUTURE_CONSENT, AUTOMATIC_SLACK_MAX_TTL_MS, REPORT_SLACK_MAX_BYTES,
  automaticSlackDecisionSchema, automaticSlackDisclosureSchema, automaticSlackPrepareSchema, automaticSlackStateSchema, founderSkillIdSchema,
  type AutomaticSlackDecision, type AutomaticSlackGrant, type AutomaticSlackPrepare, type AutomaticSlackState,
} from "@shiba/shared";
import { teamWorkspaceHeaders } from "./team-workspaces-client";

const canonical = (value: unknown): string => JSON.stringify(value && typeof value === "object"
  ? Array.isArray(value) ? value.map((item) => JSON.parse(canonical(item)))
    : Object.fromEntries(Object.keys(value).sort().map((key) => [key, JSON.parse(canonical((value as Record<string, unknown>)[key]))]))
  : value) ?? "null";
const bytes = (value: string) => new TextEncoder().encode(value);
const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(value))), (part) => part.toString(16).padStart(2, "0")).join("");

export class FounderAutomaticSlackError extends Error {
  constructor(readonly status: number) {
    super([401, 403, 404].includes(status) ? "Current native identity, source ownership or Slack audience access is unavailable. Refresh before continuing."
      : status === 413 ? "The complete qualified report exceeds the supported byte limit. Nothing is split or truncated."
        : "The exact future-delivery outcome is unconfirmed or changed. Refresh current state; no decision or send is retried automatically.");
  }
}

/** A separate, explicit standing-disclosure contract. Reading never starts OAuth or sends a message. */
export class FounderAutomaticSlackClient {
  private readonly base: string;
  constructor(readonly workspaceId: string, readonly libraryId: string, readonly actorId: string, private readonly fetcher?: typeof fetch) {
    if (!/^ws_[a-f0-9]{24}$/.test(workspaceId) || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(actorId) || actorId !== actorId.toLowerCase()) throw new Error("Select the current native account and workspace.");
    founderSkillIdSchema.parse(libraryId); this.base = `/api/founder-skills/${encodeURIComponent(libraryId)}/automatic-slack`;
  }
  private async request(suffix: string, signal: AbortSignal, body?: unknown): Promise<AutomaticSlackState> {
    signal.throwIfAborted(); const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const init: RequestInit = { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: bounded,
      headers: { ...teamWorkspaceHeaders(this.workspaceId), ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    const response = await (this.fetcher ? this.fetcher(this.base + suffix, init) : globalThis.fetch(this.base + suffix, init));
    bounded.throwIfAborted(); if (!response.ok) throw new FounderAutomaticSlackError(response.status);
    const reader = response.body?.getReader(); if (!reader) throw new Error("Future-delivery status is empty.");
    const buffer = new Uint8Array(524_288); let used = 0, parsed: AutomaticSlackState;
    try {
      for (;;) { bounded.throwIfAborted(); const part = await reader.read(); if (part.done) break;
        if (used + part.value.length > buffer.length) throw new Error("Future-delivery status exceeds its review limit.");
        buffer.set(part.value, used); used += part.value.length;
      }
      const checked = automaticSlackStateSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, used))));
      if (!checked.success) throw new Error("Future-delivery status could not be verified."); parsed = checked.data;
    } catch (cause) { if (bounded.aborted) throw cause; throw new Error("Future-delivery status could not be verified. Refresh current access."); }
    finally { await reader.cancel().catch(() => {}); }
    bounded.throwIfAborted();
    if (parsed.workspaceId !== this.workspaceId || parsed.libraryId !== this.libraryId || parsed.actorId !== this.actorId ||
      new Set(parsed.grants.map((item) => item.id)).size !== parsed.grants.length || new Set(parsed.deliveries.map((item) => item.id)).size !== parsed.deliveries.length ||
      new Set(parsed.destinations.map((item) => item.linkId)).size !== parsed.destinations.length) throw new Error("Future-delivery status belongs to another account, source or workspace.");
    for (const destination of [...parsed.destinations, ...parsed.grants.map((item) => item.destination)]) {
      if (!destination.installation || destination.installation.workspaceId !== this.workspaceId || destination.installation.teamId !== destination.teamId ||
        destination.installation.ownerId !== destination.ownerId || !destination.installation.scopes.includes("chat:write")) throw new Error("A current owned managed Slack installation is required. Legacy bot credentials are unavailable here.");
    }
    for (const grant of parsed.grants) {
      if (grant.readContract.workspaceId !== this.workspaceId || grant.readContract.ownerId !== grant.ownerId || grant.readContract.ownerAccountId !== grant.ownerAccountId || grant.destination.installation?.ownerAccountId !== grant.ownerAccountId || grant.destination.ownerId !== grant.ownerId ||
        grant.expiresAt > grant.readContract.expiresAt || grant.destination.installation.expiresAt !== null && grant.expiresAt > grant.destination.installation.expiresAt ||
        grant.usedSends > grant.maxSends || (grant.sampleContent === null) !== (grant.sampleExpiresAt === null) || grant.sampleContent !== null && bytes(grant.sampleContent).length > REPORT_SLACK_MAX_BYTES ||
        grant.canDisclose && (grant.state !== "draft" || grant.ownerId !== this.actorId || grant.sampleContent === null) ||
        grant.canApprove && (grant.state !== "disclosed" || grant.ownerId === this.actorId || grant.sampleContent === null) ||
        grant.canPause && (grant.state !== "enabled" || grant.ownerId !== this.actorId) ||
        grant.canRevoke && grant.ownerId !== this.actorId) throw new Error("Future-delivery capabilities do not match the current human authority and state.");
    }
    for (const delivery of parsed.deliveries) {
      if (!parsed.grants.some((item) => item.id === delivery.grantId) || bytes(delivery.content).length > REPORT_SLACK_MAX_BYTES || await hash(delivery.content) !== delivery.contentHash) throw new Error("The exact delivered report bytes or standing grant could not be verified.");
      bounded.throwIfAborted();
    }
    return parsed;
  }
  read(signal: AbortSignal): Promise<AutomaticSlackState> { return this.request("", signal); }
  async prepare(input: AutomaticSlackPrepare, signal: AbortSignal): Promise<AutomaticSlackState> {
    const checked = automaticSlackPrepareSchema.parse(input), now = Date.now();
    if (checked.expiresAt <= now || checked.expiresAt > now + AUTOMATIC_SLACK_MAX_TTL_MS) throw new Error("Choose a future-delivery expiry within 28 days.");
    const result = await this.request("/preview", signal, checked);
    if (!result.grants.some((item) => item.state === "draft" && item.ownerId === this.actorId && item.readGrantId === checked.readGrantId && item.readGrantVersion === checked.readGrantVersion &&
      item.sampleOccurrenceId === checked.sampleOccurrenceId && item.sampleReportHash === checked.sampleReportHash && item.destination.roomId === checked.roomId && item.destination.linkId === checked.linkId &&
      item.maxSends === checked.maxSends && item.expiresAt === checked.expiresAt && item.sampleContent !== null)) throw new Error("The saved future-delivery draft differs from the selected sample, destination or limits.");
    return result;
  }
  static decision(grant: AutomaticSlackGrant): AutomaticSlackDecision {
    return automaticSlackDecisionSchema.parse({ expectedVersion: grant.version, digest: grant.digest, expiresAt: grant.expiresAt, reviewed: true });
  }
  async decide(grant: AutomaticSlackGrant, action: "disclose" | "approve" | "pause" | "revoke", signal: AbortSignal): Promise<AutomaticSlackState> {
    const body = action === "disclose" ? automaticSlackDisclosureSchema.parse({ ...FounderAutomaticSlackClient.decision(grant), futureReportConsent: AUTOMATIC_SLACK_FUTURE_CONSENT, audienceConsent: AUTOMATIC_SLACK_AUDIENCE_CONSENT }) : FounderAutomaticSlackClient.decision(grant);
    const result = await this.request(`/grants/${encodeURIComponent(grant.id)}/${action}`, signal, body), next = result.grants.find((item) => item.id === grant.id);
    const states = action === "disclose" ? ["disclosed"] : action === "approve" ? ["enabled", "blocked", "exhausted"] : action === "pause" ? ["paused"] : ["revoked"];
    if (!next || !states.includes(next.state) ||
      (["version", "digest", "readGrantId", "readGrantVersion", "readGrantDigest", "ownerId", "ownerAccountId", "renderPolicy", "maxBytes", "disclosureScope", "futureAudienceScope", "sampleOccurrenceId", "sampleReportHash", "createdAt", "expiresAt", "reviewExpiresAt", "maxSends"] as const).some((key) => next[key] !== grant[key]) ||
      canonical(next.destination) !== canonical(grant.destination) || canonical(next.readContract) !== canonical(grant.readContract) || (["disclose", "approve"].includes(action) && (next.sampleContent !== grant.sampleContent || next.sampleExpiresAt !== grant.sampleExpiresAt))) throw new Error("The exact future-delivery decision could not be confirmed. Refresh without repeating it.");
    return result;
  }
}
