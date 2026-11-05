import { founderAutomaticReadReportHash, type FounderAutomaticReadInput, type FounderAutomaticReadGrant, type FounderAutomaticReadState, type FounderAutomaticReadOptions, type FounderAutomaticReadOccurrence, type FounderAutomaticReadReport } from "@shiba/shared";
export const AUTOMATIC_WORKSPACE = `ws_${"a".repeat(24)}`, AUTOMATIC_LIBRARY = "founder-pr-digest";
export const AUTOMATIC_BASE = `/api/founder-skills/${AUTOMATIC_LIBRARY}/automatic-reads`, AUTOMATIC_ACTOR = "owner@example.test";
const runtime = { versionId: "11111111-1111-4111-8111-111111111111", versionTag: "a".repeat(40), manifestDigest: "b".repeat(64), buildDigest: "c".repeat(64), upstreamRevision: "d".repeat(40) };
export const automaticInput = (): FounderAutomaticReadInput => ({ employeeId: "employee-one", employeeVersion: 2, skillId: "skill-one", skillVersion: 3,
  operations: [{ connectionId: "account-github", connectionVersion: 4, operationId: "github.list_pull_requests", arguments: { owner: "fixture", repo: "fixture", perPage: 5, state: "open" } }],
  cadence: "daily", localTime: "09:00", timezone: "UTC", expiresAt: Date.now() + 86_400_000, maxOccurrences: 2, maxCalls: 2, maxCapturedBytes: 65_536, maxBytesPerOccurrence: 32_768, expectedVersion: 0 });
export function automaticOptions(): FounderAutomaticReadOptions {
  return { ok: true, workspaceId: AUTOMATIC_WORKSPACE, libraryId: AUTOMATIC_LIBRARY, actorId: AUTOMATIC_ACTOR, available: true, unavailableReason: null, runtime,
    employees: [{ id: "employee-one", version: 2, name: "Evidence keeper" }], skill: { id: "skill-one", version: 3, name: "Reviewed brief" },
    connections: [{ id: "account-github", scope: "workspace", workspaceId: AUTOMATIC_WORKSPACE, providerKey: "github", version: 4, generation: 3, state: "active", identityLabel: "Fictional GitHub account", authorizationFingerprint: "f".repeat(64), upstreamReady: true, health: "unknown", grantCount: 1 }],
    operations: [{ id: "github.list_pull_requests", service: "github", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, perPage: { type: "integer", maximum: 25 }, state: { enum: ["open", "closed", "all"] } }, required: ["owner", "repo", "perPage", "state"], additionalProperties: false }, inputSchemaHash: "1".repeat(64), executorHash: "2".repeat(64), queryHash: null, maxPages: 1, maxBytes: 32768 }] };
}
export function automaticGrant(input = automaticInput()): FounderAutomaticReadGrant {
  const { expectedVersion: _expected, ...selected } = input;
  return { id: "far-fixture", version: 1, digest: "e".repeat(64), state: "draft", contract: { ...selected, format: "shiba.automatic-read.v1", workspaceId: AUTOMATIC_WORKSPACE, ownerId: AUTOMATIC_ACTOR, ownerAccountId: "native-fixture-owner", employeeName: "Evidence keeper", skillName: "Reviewed brief", recipeSha256: "0".repeat(64), runtime,
    operations: input.operations.map((item) => ({ ...item, providerKey: "github", identityLabel: "Fictional GitHub account", inputSchemaHash: "1".repeat(64), executorHash: "2".repeat(64), queryHash: null, maxPages: 1, maxBytes: 32768 })),
    cron: "0 9 * * *", maxStepMs: 5000, maxOccurrenceMs: 60000, principal: { kind: "schedule", id: "schedule-fixture" }, model: null, destination: "private-dashboard" },
    reviewExpiresAt: Date.now() + 600_000, nextDueAt: Date.now() + 3_600_000, usedOccurrences: 0, reservedCalls: 0, reservedBytes: 0, blockedReason: null, canEnable: true, canPause: false, canResume: false, canRevoke: true };
}
export const automaticState = (grant: FounderAutomaticReadGrant | null = null, occurrences: FounderAutomaticReadOccurrence[] = []): FounderAutomaticReadState => ({ ok: true, workspaceId: AUTOMATIC_WORKSPACE, libraryId: AUTOMATIC_LIBRARY, actorId: AUTOMATIC_ACTOR, available: true, unavailableReason: null, canConfigure: true, grant, occurrences });
export const automaticOccurrence = (grant = automaticGrant()): FounderAutomaticReadOccurrence => ({ id: "fao-fixture", grantId: grant.id, grantVersion: grant.version, principal: grant.contract.principal, scheduledAt: Date.now() - 60_000, expiresAt: Date.now() + 3_600_000, state: "completed", stepCount: 1, completedSteps: 1, canReadReport: true, error: null });
export function automaticReport(occurrence = automaticOccurrence()): FounderAutomaticReadReport {
  const value = { ok: true as const, workspaceId: AUTOMATIC_WORKSPACE, libraryId: AUTOMATIC_LIBRARY, actorId: AUTOMATIC_ACTOR, id: occurrence.id, grantId: occurrence.grantId, grantVersion: occurrence.grantVersion, principal: occurrence.principal, expiresAt: occurrence.expiresAt,
    markdown: "# Scheduled evidence\n\nBounded response. Dataset completeness: unknown. Business success: unverified.\n\n[R1] Fictional GitHub receipt: empty result. No MRR or financial conclusion is computed.",
    json: JSON.stringify({ sourceKind: "standing-scheduled-read", captureCompleteness: "bounded-response", datasetCompleteness: "unknown", businessSuccess: "unverified", sources: [{ citation: "R1", result: [] }] }),
    sourceKind: "standing-scheduled-read" as const, captureCompleteness: "bounded-response" as const, datasetCompleteness: "unknown" as const, businessSuccess: "unverified" as const, canExport: false as const };
  return { ...value, libraryId: AUTOMATIC_LIBRARY, reportHash: founderAutomaticReadReportHash(value) };
}
