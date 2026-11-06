import { runOutputArchiveDirectorySchema, runOutputArchivePageSchema, stableHash, stableJson,
  type RunOutputArchiveDirectory, type RunOutputArchivePage, type JsonValue } from "@shiba/shared";

export class RunOutputArchiveClient {
  private actor: string | null = null;
  private account: string | null = null;
  private records = new Map<string, RunOutputArchiveDirectory["archives"][number]>();
  constructor(readonly runId: string, readonly sessionId: string, private readonly fetcher?: typeof fetch) {}
  private async request(path: string, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted(); const bounded = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    const init: RequestInit = { method: "GET", credentials: "same-origin", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer", signal: bounded };
    const response = await (this.fetcher ? this.fetcher(path, init) : globalThis.fetch(path, init));
    bounded.throwIfAborted(); if (!response.ok) throw new Error("Current native archive access is unavailable. Refresh before continuing.");
    const reader = response.body?.getReader(); if (!reader) throw new Error("The output archive response was empty.");
    const bytes = new Uint8Array(1_048_576); let used = 0;
    try {
      for (;;) { bounded.throwIfAborted(); const next = await reader.read(); if (next.done) break;
        if (used + next.value.length > bytes.length) throw new Error("The output archive page exceeded its safe bound.");
        bytes.set(next.value, used); used += next.value.length;
      }
      bounded.throwIfAborted(); return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)));
    } finally { await reader.cancel().catch(() => {}); }
  }
  private scope(value: { actorId: string; ownerAccountId: string }): void {
    if (this.actor !== null && this.actor !== value.actorId || this.account !== null && this.account !== value.ownerAccountId) throw new Error("The native archive account changed. Reopen this run.");
    this.actor = value.actorId; this.account = value.ownerAccountId;
  }
  async directory(signal: AbortSignal): Promise<RunOutputArchiveDirectory["archives"]> {
    const value = runOutputArchiveDirectorySchema.parse(await this.request("/api/run-output-archives", signal)); this.scope(value);
    const matches = value.archives.filter((item) => item.runId === this.runId && item.sessionId === this.sessionId && item.expiresAt > Date.now());
    if (matches.length > 1) throw new Error("The exact run archive identity could not be verified.");
    this.records = new Map(matches.map((item) => [item.id, item]));
    return matches;
  }
  async page(id: string, signal: AbortSignal, previous?: RunOutputArchivePage): Promise<RunOutputArchivePage> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid output archive identity.");
    const selected = this.records.get(id);
    if (!selected || selected.expiresAt <= Date.now()) throw new Error("Select the current approved run archive before reading it.");
    const after = previous?.nextCursor ?? 0;
    const value = runOutputArchivePageSchema.parse(await this.request(`/api/run-output-archives/${id}?after=${after}`, signal)); this.scope(value);
    if (value.archiveId !== id || value.runId !== this.runId || value.sessionId !== this.sessionId || value.jobId !== selected.jobId || value.expiresAt !== selected.expiresAt || value.after !== after || value.expiresAt <= Date.now() ||
      value.acknowledgedThrough > value.lastObservedSource || value.nextCursor !== after + value.events.length || value.nextCursor > value.eventCount || value.hasMore !== (value.nextCursor < value.eventCount) || value.hasMore && value.events.length === 0 ||
      value.state === "complete" && (value.incompleteTail || value.finalExitCode === null || value.tailUpperBound !== value.lastObservedSource || value.acknowledgedThrough !== value.lastObservedSource) ||
      value.state !== "complete" && (!value.incompleteTail || value.tailUpperBound !== null || value.finalExitCode !== null)) throw new Error("The archive cursor, lease or source outcome could not be verified.");
    let chain = previous?.events.at(-1)?.chainDigest ?? previous?.previousChainDigest ?? stableHash(["shiba.output-archive-chain.v1", value.reservationDigest]);
    if (previous && (previous.archiveId !== id || previous.reservationDigest !== value.reservationDigest || previous.jobId !== value.jobId || previous.expiresAt !== value.expiresAt ||
      previous.eventCount > value.eventCount || previous.acknowledgedThrough > value.acknowledgedThrough) || value.previousChainDigest !== chain) throw new Error("The archive sequence changed. Refresh the retained prefix.");
    for (let index = 0; index < value.events.length; index++) {
      const event = value.events[index]!;
      if (event.ordinal !== after + index + 1 || event.sourceSequence > value.lastObservedSource) throw new Error("The output archive contains a sequence gap.");
      const entry: JsonValue[] = [id, event.ordinal, event.eventId, event.roomSequence, event.sourceSequence, stableJson(event.event as unknown as JsonValue), event.createdAt];
      chain = stableHash([chain, entry]);
      if (event.chainDigest !== chain) throw new Error("The output archive bytes do not match their retained checkpoint.");
    }
    if (!value.hasMore && chain !== value.chainDigest) throw new Error("The output archive frontier could not be verified.");
    signal.throwIfAborted();
    if (value.expiresAt <= Date.now()) throw new Error("The private archive lease expired during verification.");
    return value;
  }

  /** Read and verify a stable projection, then recheck its final page's authority. */
  async exportSnapshot(id: string, signal: AbortSignal) {
    const events: RunOutputArchivePage["events"] = [];
    let previous: RunOutputArchivePage | undefined, lastPrevious: RunOutputArchivePage | undefined;
    let first: RunOutputArchivePage | undefined, page: RunOutputArchivePage;
    const sameFrontier = (a: RunOutputArchivePage, b: RunOutputArchivePage) =>
      a.chainDigest === b.chainDigest && a.eventCount === b.eventCount && a.byteCount === b.byteCount &&
      a.acknowledgedThrough === b.acknowledgedThrough && a.lastObservedSource === b.lastObservedSource &&
      a.state === b.state && a.reason === b.reason && a.finalExitCode === b.finalExitCode &&
      a.incompleteTail === b.incompleteTail && a.tailUpperBound === b.tailUpperBound;
    do {
      lastPrevious = previous;
      page = await this.page(id, signal, previous);
      first ??= page;
      if (!sameFrontier(first, page)) throw new Error("The archive changed while exporting. Refresh and try again.");
      events.push(...page.events);
      previous = page;
    } while (page.hasMore);
    const checked = await this.page(id, signal, lastPrevious);
    if (!sameFrontier(first, checked) || checked.hasMore || checked.nextCursor !== page.nextCursor || checked.previousChainDigest !== page.previousChainDigest)
      throw new Error("The archive changed while exporting. Refresh and try again.");
    signal.throwIfAborted();
    if (first.expiresAt <= Date.now()) throw new Error("The archive lease expired during export.");
    return { format: "shiba-retained-output-v1" as const, archiveId: first.archiveId, jobId: first.jobId,
      sessionId: first.sessionId, runId: first.runId, expiresAt: first.expiresAt, reservationDigest: first.reservationDigest,
      chainDigest: first.chainDigest, state: first.state, reason: first.reason, acknowledgedThrough: first.acknowledgedThrough,
      lastObservedSource: first.lastObservedSource, finalExitCode: first.finalExitCode, incompleteTail: first.incompleteTail,
      tailUpperBound: first.tailUpperBound, eventCount: first.eventCount, byteCount: first.byteCount, events };
  }
}
