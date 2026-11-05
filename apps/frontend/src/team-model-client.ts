import { teamModelStateResponseSchema, teamModelFundingResponseSchema, teamModelTurnResponseSchema,
  type TeamModelStateResponse, type TeamModelFundingResponse, type TeamModelTurnResponse, type TeamModelFundingInput, type TeamModelTurnInput } from "@shiba/shared";

const canonical = (value: unknown): string => JSON.stringify(value && typeof value === "object"
  ? Array.isArray(value) ? value.map((item) => JSON.parse(canonical(item))) : Object.fromEntries(Object.keys(value).sort().map((key) => [key, JSON.parse(canonical((value as Record<string, unknown>)[key]))])) : value) ?? "null";
type Funding = TeamModelFundingResponse["grant"];
type Turn = TeamModelTurnResponse["turn"];
export type TeamModelTurnDraft = Omit<TeamModelTurnInput, "grantId" | "expectedGrantVersion">;
export class TeamModelRequestError extends Error {
  constructor(readonly status: number) {
    super([401, 403, 404].includes(status) ? "Team model access or source authority changed. Refresh before continuing."
      : status === 409 ? "The funding, source or turn version changed. Refresh before another decision."
      : "Team model sessions are unavailable. Ask the deployment operator to check the configured feature.");
  }
}
export const teamModelAccessLost = (cause: unknown) => cause instanceof TeamModelRequestError && [401, 403, 404].includes(cause.status);

/** Every result remains bound to an explicit workspace, room and native actor. */
export class TeamModelClient {
  constructor(readonly workspaceId: string, readonly roomId: string, readonly actorId: string,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {
    if (!/^ws_[a-f0-9]{24}$/.test(workspaceId) || !roomId || roomId.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(actorId) || actorId !== actorId.toLowerCase()) throw new Error("Select a current native account and team room.");
  }
  private async request<T extends { workspaceId: string; roomId: string }>(path: string, schema: { parse(value: unknown): T }, signal: AbortSignal, body?: unknown): Promise<T> {
    signal.throwIfAborted();
    const response = await this.fetcher(`/api/team-model-sessions${path}`, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", redirect: "error", signal,
      headers: { "X-Shiba-Workspace": this.workspaceId, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    signal.throwIfAborted();
    if (!response.ok) throw new TeamModelRequestError(response.status);
    let result: T;
    try { result = schema.parse(await response.json()); } catch { throw new Error("The team model response could not be verified. Refresh before continuing."); }
    signal.throwIfAborted();
    if (result.workspaceId !== this.workspaceId || result.roomId !== this.roomId) throw new Error("The team model response belongs to another workspace or room.");
    return result;
  }
  async state(signal: AbortSignal): Promise<TeamModelStateResponse> {
    const body = await this.request(`/state?${new URLSearchParams({ roomId: this.roomId })}`, teamModelStateResponseSchema, signal);
    if (body.actorId !== this.actorId || body.grants.some((grant) => grant.contract.roomId !== this.roomId) || body.turns.some((turn) => turn.roomId !== this.roomId || turn.requesterId !== this.actorId)) throw new Error("The team model state belongs to another account.");
    return body;
  }
  async prepareFunding(input: Omit<TeamModelFundingInput, "roomId">, signal: AbortSignal): Promise<Funding> {
    const { grant } = await this.request("/funding/prepare", teamModelFundingResponseSchema, signal, { roomId: this.roomId, ...input });
    const fields: Array<keyof Omit<TeamModelFundingInput, "roomId">> = ["employeeId", "employeeVersion", "memberId", "memberVersion", "model", "maxRequests", "maxInputBytes", "maxOutputTokens", "expiresAt"];
    if (grant.contract.roomId !== this.roomId || grant.contract.issuerId !== this.actorId || fields.some((key) => grant.contract[key] !== input[key]) || grant.state !== "draft") throw new Error("The exact funding contract could not be verified.");
    return grant;
  }
  private fundingReceipt(next: Funding, previous: Funding): Funding {
    if (next.id !== previous.id || next.digest !== previous.digest || next.version < previous.version || canonical(next.contract) !== canonical(previous.contract)) throw new Error("The exact funding receipt could not be verified.");
    return next;
  }
  async activateFunding(grant: Funding, signal: AbortSignal): Promise<Funding> {
    const body = await this.request(`/funding/${encodeURIComponent(grant.id)}/activate`, teamModelFundingResponseSchema, signal, { expectedVersion: grant.version, digest: grant.digest, billingConsent: true, reviewed: true });
    return this.fundingReceipt(body.grant, grant);
  }
  async revokeFunding(grant: Funding, signal: AbortSignal): Promise<Funding> {
    const body = await this.request(`/funding/${encodeURIComponent(grant.id)}/revoke`, teamModelFundingResponseSchema, signal, { expectedVersion: grant.version });
    return this.fundingReceipt(body.grant, grant);
  }
  async prepareTurn(grant: Funding, input: TeamModelTurnDraft, signal: AbortSignal): Promise<Turn> {
    const { turn } = await this.request("/turns/prepare", teamModelTurnResponseSchema, signal, { grantId: grant.id, expectedGrantVersion: grant.version, ...input });
    const selectedMessages = [...input.messageIds].sort(), messages = turn.sources.filter((source) => source.kind === "message").map((source) => source.id).sort();
    const notes = turn.sources.filter((source) => source.kind === "note");
    if (turn.roomId !== this.roomId || turn.requesterId !== this.actorId || turn.grantId !== grant.id || turn.employeeId !== grant.contract.employeeId || turn.model !== grant.contract.model ||
      turn.requestedPrompt !== input.prompt || turn.inputBytes > grant.contract.maxInputBytes || turn.maxOutputTokens !== grant.contract.maxOutputTokens || turn.expiresAt > grant.contract.expiresAt ||
      JSON.stringify(messages) !== JSON.stringify(selectedMessages) || notes.length !== input.memoryRefs.length || input.memoryRefs.some((ref) => !notes.some((note) => note.id === ref.id && note.version === ref.version && note.sha256 === ref.sha256))) throw new Error("The exact prompt, model and source receipt could not be verified.");
    return turn;
  }
  private turnReceipt(next: Turn, previous: Turn): Turn {
    if (next.id !== previous.id || next.roomId !== this.roomId || next.requesterId !== this.actorId || next.grantId !== previous.grantId || next.inputHash !== previous.inputHash || next.model !== previous.model || next.employeeId !== previous.employeeId || next.version < previous.version) throw new Error("The exact team model turn receipt could not be verified. Inspect its outcome before another action.");
    return next;
  }
  async approveTurn(turn: Turn, signal: AbortSignal): Promise<Turn> {
    const body = await this.request(`/turns/${encodeURIComponent(turn.id)}/approve`, teamModelTurnResponseSchema, signal, { expectedVersion: turn.version, inputHash: turn.inputHash, reviewed: true });
    return this.turnReceipt(body.turn, turn);
  }
  async executeTurn(turn: Turn, signal: AbortSignal): Promise<Turn> {
    const body = await this.request(`/turns/${encodeURIComponent(turn.id)}/execute`, teamModelTurnResponseSchema, signal, { expectedVersion: turn.version, inputHash: turn.inputHash });
    return this.turnReceipt(body.turn, turn);
  }
  async cancelTurn(turn: Turn, signal: AbortSignal): Promise<Turn> {
    const body = await this.request(`/turns/${encodeURIComponent(turn.id)}/cancel`, teamModelTurnResponseSchema, signal, { expectedVersion: turn.version });
    return this.turnReceipt(body.turn, turn);
  }
}
