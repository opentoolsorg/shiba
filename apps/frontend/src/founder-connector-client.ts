import {
  founderSkillIdSchema, founderConnectorStateSchema, founderConnectorOptionsSchema, founderConnectorActionsSchema,
  founderConnectorPrepareInputSchema, type FounderConnectorState, type FounderConnectorOptions, type FounderConnectorActions,
  type FounderConnectorPrepareInput, type FounderConnectorPlan, type FounderConnectorOccurrence,
} from "@shiba/shared";
import { teamWorkspaceHeaders } from "./team-workspaces-client";

export class FounderConnectorRequestError extends Error {
  constructor(readonly status: number) {
    super([401, 403, 404].includes(status) ? "Current native workspace access or source permission is unavailable. Refresh before continuing."
      : status === 409 ? "The plan, source or action changed. Refresh and review its current version."
        : status === 503 ? "Scheduled app action reviews are unavailable. Check the integration service configuration."
          : "The scheduled action response could not be verified. Refresh before another change.");
    this.name = "FounderConnectorRequestError";
  }
}
export const canonicalFounderArguments = (value: unknown): string => {
  const sorted = (item: unknown): unknown => Array.isArray(item) ? item.map(sorted) : item && typeof item === "object"
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, sorted((item as Record<string, unknown>)[key])])) : item;
  return JSON.stringify(sorted(value));
};
type Parser<T> = { parse(value: unknown): T };
type Scope = { workspaceId: string; libraryId: string; actorId: string };
async function responseText(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The scheduled action response is empty.");
  const bytes = new Uint8Array(2_097_152);
  let used = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      if (used + chunk.value.byteLength > bytes.length) throw new Error("The action receipt exceeded the review limit. Inspect its state before another action.");
      bytes.set(chunk.value, used); used += chunk.value.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used));
  } finally { await reader.cancel().catch(() => {}); }
}

/** No provider token, automatic retry or inferred execution permission is part of this client. */
export class FounderConnectorClient {
  private actorId: string | null = null;
  private readonly base: string;
  constructor(readonly workspaceId: string, readonly libraryId: string, private readonly fetcher?: typeof fetch) {
    if (!/^ws_[a-f0-9]{24}$/.test(workspaceId)) throw new Error("Choose a team workspace for scheduled app action review.");
    founderSkillIdSchema.parse(libraryId);
    this.base = `/api/founder-skills/${encodeURIComponent(libraryId)}/connector-job`;
  }
  private async request<T extends Scope>(suffix: string, schema: Parser<T>, signal: AbortSignal, body?: unknown): Promise<T> {
    signal.throwIfAborted();
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(body === undefined ? 10_000 : 45_000)]);
    const send = this.fetcher;
    const init: RequestInit = { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", redirect: "error", signal: boundedSignal,
      headers: { ...teamWorkspaceHeaders(this.workspaceId), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    const response = await (send ? send(this.base + suffix, init) : globalThis.fetch(this.base + suffix, init));
    boundedSignal.throwIfAborted();
    if (!response.ok) throw new FounderConnectorRequestError(response.status);
    const text = await responseText(response, boundedSignal);
    boundedSignal.throwIfAborted();
    let value: T;
    try { value = schema.parse(JSON.parse(text)); } catch { throw new Error("The scheduled action receipt could not be verified. Refresh before another action."); }
    if (value.workspaceId !== this.workspaceId || value.libraryId !== this.libraryId || (this.actorId !== null && value.actorId !== this.actorId)) throw new Error("The action response belongs to another account or workspace. Reopen this panel.");
    this.actorId = value.actorId;
    return value;
  }
  private validateState(value: FounderConnectorState): FounderConnectorState {
    const plan = value.plan;
    if (plan && (plan.contract.workspaceId !== this.workspaceId || plan.contract.libraryId !== this.libraryId || plan.contract.ownerId !== value.actorId)) throw new Error("The plan does not belong to this native account and workspace.");
    if ((!plan && value.occurrences.length > 0) || new Set(value.occurrences.map((item) => item.id)).size !== value.occurrences.length ||
      value.occurrences.some((item) => !plan || item.planId !== plan.id || item.planVersion > plan.version ||
        (item.planVersion < plan.version && (item.approval !== null || item.canPrepare || item.canDecide || item.canExecute || !["completed", "failed", "unknown", "expired", "cancelled", "denied"].includes(item.status))) ||
        (item.approval !== null && (item.approval.requesterId !== plan.contract.ownerId || item.approval.employeeId !== plan.contract.employeeId ||
          item.approval.employeeVersion !== plan.contract.employeeVersion || item.approval.connectionId !== plan.contract.connectionId || item.approval.connectionVersion !== plan.contract.connectionVersion ||
          item.approval.actionId !== plan.contract.actionId || canonicalFounderArguments(item.approval.arguments) !== canonicalFounderArguments(plan.contract.arguments))))) throw new Error("A scheduled occurrence or action receipt does not match the exact plan.");
    return value;
  }
  async read(signal: AbortSignal): Promise<FounderConnectorState> { return this.validateState(await this.request("", founderConnectorStateSchema, signal)); }
  async options(signal: AbortSignal): Promise<FounderConnectorOptions> {
    const value = await this.request("/options", founderConnectorOptionsSchema, signal);
    if (value.connections.some((item) => item.workspaceId !== this.workspaceId || item.scope !== "workspace") || new Set(value.connections.map((item) => item.id)).size !== value.connections.length) throw new Error("The available account scope could not be verified.");
    return value;
  }
  async actions(connectionId: string, employeeId: string, employeeVersion: number, query: string, signal: AbortSignal): Promise<FounderConnectorActions> {
    const params = new URLSearchParams({ connectionId, employeeId, employeeVersion: String(employeeVersion), q: query });
    const value = await this.request(`/actions?${params}`, founderConnectorActionsSchema, signal);
    if (value.connectionId !== connectionId || value.employeeId !== employeeId || value.employeeVersion !== employeeVersion) throw new Error("The action directory belongs to another account or employee version.");
    return value;
  }
  async prepare(input: FounderConnectorPrepareInput, signal: AbortSignal): Promise<FounderConnectorState> {
    const parsed = founderConnectorPrepareInputSchema.parse(input);
    if (new TextEncoder().encode(canonicalFounderArguments(parsed.arguments)).length > 16_000) throw new Error("Action arguments exceed 16,000 bytes.");
    const value = this.validateState(await this.request("", founderConnectorStateSchema, signal, parsed)), contract = value.plan?.contract;
    if (!value.plan || value.plan.state !== "draft" || value.plan.version !== input.expectedVersion + 1 || !contract ||
      ["employeeId", "employeeVersion", "skillId", "skillVersion", "connectionId", "connectionVersion", "actionId", "cadence", "localTime", "weekday", "timezone", "expiresAt"].some((key) => contract[key as keyof typeof contract] !== input[key as keyof FounderConnectorPrepareInput]) ||
      canonicalFounderArguments(contract.arguments) !== canonicalFounderArguments(input.arguments)) throw new Error("The prepared plan does not match your exact configuration. Refresh before enabling it.");
    return value;
  }
  async decidePlan(action: "enable" | "pause" | "resume" | "revoke", plan: Pick<FounderConnectorPlan, "id" | "version" | "digest">, signal: AbortSignal): Promise<FounderConnectorState> {
    const value = this.validateState(await this.request(`/${action}`, founderConnectorStateSchema, signal, { expectedVersion: plan.version, digest: plan.digest, reviewed: true }));
    const record = value.plan ?? value.stalePlan, state = action === "revoke" ? "revoked" : action === "pause" ? "paused" : "enabled";
    if (!record || record.id !== plan.id || record.version !== plan.version + 1 || record.state !== state) throw new Error("The exact schedule change could not be confirmed. Refresh before another change.");
    return value;
  }
  private occurrenceInput(plan: FounderConnectorPlan, occurrence: FounderConnectorOccurrence) {
    if (occurrence.planId !== plan.id || occurrence.planVersion !== plan.version) throw new Error("Refresh this occurrence before requesting work.");
    return { expectedVersion: plan.version, digest: plan.digest, occurrenceDigest: occurrence.digest };
  }
  async prepareOccurrence(plan: FounderConnectorPlan, occurrence: FounderConnectorOccurrence, signal: AbortSignal): Promise<FounderConnectorState> {
    if (!occurrence.canPrepare || occurrence.status !== "pending" || occurrence.expiresAt <= Date.now()) throw new Error("This occurrence cannot request an action.");
    const value = this.validateState(await this.request(`/occurrences/${encodeURIComponent(occurrence.id)}/prepare`, founderConnectorStateSchema, signal, this.occurrenceInput(plan, occurrence)));
    const receipt = value.occurrences.find((item) => item.id === occurrence.id);
    if (!receipt || receipt.requestId !== occurrence.requestId || receipt.digest !== occurrence.digest || !["awaiting-approval", "unknown"].includes(receipt.status)) throw new Error("The exact occurrence request could not be confirmed. Refresh before another action.");
    return value;
  }
  async decideOccurrence(plan: FounderConnectorPlan, occurrence: FounderConnectorOccurrence, approved: boolean, signal: AbortSignal): Promise<FounderConnectorState> {
    if (!occurrence.canDecide || !occurrence.approval?.canDecide || occurrence.approval.status !== "pending" || occurrence.expiresAt <= Date.now()) throw new Error("There is no exact action request you may review.");
    const value = this.validateState(await this.request(`/occurrences/${encodeURIComponent(occurrence.id)}/decision`, founderConnectorStateSchema, signal, {
      ...this.occurrenceInput(plan, occurrence), approvalId: occurrence.approval.id, inputHash: occurrence.approval.inputHash, approved }));
    const receipt = value.occurrences.find((item) => item.id === occurrence.id)?.approval;
    if (!receipt || receipt.id !== occurrence.approval.id || receipt.inputHash !== occurrence.approval.inputHash || receipt.status !== (approved ? "approved" : "denied")) throw new Error("The exact human decision could not be confirmed. Refresh before another action.");
    return value;
  }
  async executeOccurrence(plan: FounderConnectorPlan, occurrence: FounderConnectorOccurrence, signal: AbortSignal): Promise<FounderConnectorState> {
    if (!occurrence.canExecute || !occurrence.approval?.canExecute || occurrence.approval.status !== "approved" || occurrence.approval.requesterId !== this.actorId || occurrence.expiresAt <= Date.now()) throw new Error("There is no approved action you may execute.");
    const value = this.validateState(await this.request(`/occurrences/${encodeURIComponent(occurrence.id)}/execute`, founderConnectorStateSchema, signal, {
      ...this.occurrenceInput(plan, occurrence), approvalId: occurrence.approval.id, inputHash: occurrence.approval.inputHash }));
    const receipt = value.occurrences.find((item) => item.id === occurrence.id)?.approval;
    if (!receipt || receipt.id !== occurrence.approval.id || receipt.inputHash !== occurrence.approval.inputHash || !["executing", "completed", "failed", "unknown"].includes(receipt.status)) throw new Error("The execution receipt could not be confirmed. Inspect its state before another action.");
    return value;
  }
}
