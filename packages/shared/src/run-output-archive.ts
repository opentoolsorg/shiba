import { z } from "zod";

/** Resource reservation, never a model billing or process-resurrection grant. */
export const RUN_OUTPUT_ARCHIVE_V1 = {
  version: 1, maxBytes: 8 * 1024 * 1024, maxEvents: 8_192,
  sourceMaxBytes: 4 * 1024 * 1024, sourceMaxFrames: 4_096,
  roomMaxBytes: 16 * 1024 * 1024, roomMaxArchives: 2,
  ownerMaxBytes: 32 * 1024 * 1024, ownerMaxArchives: 4,
} as const;
export const RUN_OUTPUT_ARCHIVE_MAX_LEASE_MS = 24 * 60 * 60_000;
export const runOutputArchivePolicySchema = z.strictObject({
  version: z.literal(1), maxBytes: z.literal(RUN_OUTPUT_ARCHIVE_V1.maxBytes), maxEvents: z.literal(8_192),
  sourceMaxBytes: z.literal(RUN_OUTPUT_ARCHIVE_V1.sourceMaxBytes), sourceMaxFrames: z.literal(4_096),
  roomMaxBytes: z.literal(RUN_OUTPUT_ARCHIVE_V1.roomMaxBytes), roomMaxArchives: z.literal(2),
  ownerMaxBytes: z.literal(RUN_OUTPUT_ARCHIVE_V1.ownerMaxBytes), ownerMaxArchives: z.literal(4),
  audience: z.literal("original-native-owner"),
  ownerAccountId: z.string().min(1).max(200),
  expiresAt: z.number().int().positive(),
});
export type RunOutputArchivePolicy = z.infer<typeof runOutputArchivePolicySchema>;
export function newRunOutputArchivePolicy(now: number, ownerAccountId: string): RunOutputArchivePolicy {
  return { ...RUN_OUTPUT_ARCHIVE_V1, audience: "original-native-owner", ownerAccountId, expiresAt: now + RUN_OUTPUT_ARCHIVE_MAX_LEASE_MS };
}
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const summary = z.object({ id: hash, sessionId: z.string().min(1).max(128), runId: z.string().min(1).max(200), jobId: hash, expiresAt: z.number().int().positive() });
const scope = { ok: z.literal(true), actorId: z.string().min(1).max(320), ownerAccountId: z.string().min(1).max(200) };
export const runOutputArchiveDirectorySchema = z.object({ ...scope, archives: z.array(summary).max(4) });
export type RunOutputArchiveDirectory = z.infer<typeof runOutputArchiveDirectorySchema>;
export const runOutputArchivePageSchema = z.object({ ...scope, sessionId: summary.shape.sessionId, runId: summary.shape.runId,
  archiveId: hash, jobId: hash, reservationDigest: hash, state: z.enum(["admitted", "active", "complete", "incomplete"]), reason: z.string().max(200).nullable(),
  expiresAt: z.number().int().positive(), previousChainDigest: hash, chainDigest: hash,
  acknowledgedThrough: z.number().int().min(0).max(4096), lastObservedSource: z.number().int().min(0).max(4096),
  eventCount: z.number().int().min(0).max(8192), byteCount: z.number().int().min(0).max(RUN_OUTPUT_ARCHIVE_V1.maxBytes),
  finalExitCode: z.number().int().nullable(), incompleteTail: z.boolean(), tailUpperBound: z.number().int().min(0).max(4096).nullable(),
  after: z.number().int().min(0).max(8192), nextCursor: z.number().int().min(0).max(8192), hasMore: z.boolean(),
  events: z.array(z.object({ ordinal: z.number().int().min(1).max(8192), eventId: z.string().uuid(), roomSequence: z.number().int().positive(),
    sourceSequence: z.number().int().min(0).max(4096), event: z.strictObject({ kind: z.literal("terminal"), stream: z.enum(["stdout", "stderr"]), data: z.string().max(4000) }),
    createdAt: z.number().int().positive(), chainDigest: hash })).max(32),
});
export type RunOutputArchivePage = z.infer<typeof runOutputArchivePageSchema>;
