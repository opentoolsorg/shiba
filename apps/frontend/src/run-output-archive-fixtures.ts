import { stableHash, stableJson, type JsonValue, type RunOutputArchivePage, type RunOutputArchiveDirectory } from "@shiba/shared";
export const OUTPUT_ARCHIVE_ID = "a".repeat(64), OUTPUT_RUN = "agent-tool:fixture", OUTPUT_SESSION = "default";
export function archiveFixture() {
  const expiresAt = Date.now() + 60_000, reservationDigest = "b".repeat(64), jobId = "c".repeat(64);
  const scope = { ok: true as const, actorId: "owner@example.test", ownerAccountId: "native-owner" };
  const event = { ordinal: 1, eventId: "11111111-1111-4111-8111-111111111111", roomSequence: 7, sourceSequence: 1,
    event: { kind: "terminal" as const, stream: "stdout" as const, data: "Private sanitized retained prefix\n" }, createdAt: Date.now(), chainDigest: "" };
  const previousChainDigest = stableHash(["shiba.output-archive-chain.v1", reservationDigest]);
  event.chainDigest = stableHash([previousChainDigest, [OUTPUT_ARCHIVE_ID, event.ordinal, event.eventId, event.roomSequence, event.sourceSequence, stableJson(event.event as unknown as JsonValue), event.createdAt]]);
  const page: RunOutputArchivePage = { ...scope, sessionId: OUTPUT_SESSION, runId: OUTPUT_RUN, archiveId: OUTPUT_ARCHIVE_ID, jobId, reservationDigest, state: "incomplete", reason: "original_container_unavailable_tail_unknown",
    expiresAt, previousChainDigest, chainDigest: event.chainDigest, acknowledgedThrough: 1, lastObservedSource: 1, eventCount: 1, byteCount: 4096,
    finalExitCode: null, incompleteTail: true, tailUpperBound: null, after: 0, nextCursor: 1, hasMore: false, events: [event] };
  const directory: RunOutputArchiveDirectory = { ...scope, archives: [{ id: OUTPUT_ARCHIVE_ID, sessionId: OUTPUT_SESSION, runId: OUTPUT_RUN, jobId, expiresAt }] };
  return { directory, page };
}
