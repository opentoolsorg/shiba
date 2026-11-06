import { type AutomaticSlackGrant, type AutomaticSlackState } from "@shiba/shared";
import { slackInstallationFixture } from "./slack-installations-fixtures";
import { automaticGrant } from "./founder-automatic-fixtures";
import type { AutomaticSlackSample } from "./components/FounderAutomaticSlack";

export const AUTO_SLACK_WORKSPACE = `ws_${"a".repeat(24)}`, AUTO_SLACK_LIBRARY = "founder-pr-digest", AUTO_SLACK_ACTOR = "owner@example.test";
export const AUTO_SLACK_CONTENT = "Scheduled fixed-read evidence. Captures are bounded; dataset completeness is unknown and business success is unverified.\n\n[R1] Fictional empty result. &lt;!channel&gt; is neutralized.";
export function automaticSlackSample(): AutomaticSlackSample { return { readGrantId: "far-fixture", readGrantVersion: 2, sampleOccurrenceId: "fao-fixture", sampleReportHash: "a".repeat(64), expiresAt: Date.now() + 3_600_000, readGrantExpiresAt: Date.now() + 28 * 86_400_000 }; }
export function automaticSlackGrant(): AutomaticSlackGrant {
  const installation = slackInstallationFixture().installations[0]!;
  const { state: _state, digest: _digest, activationExpiresAt: _deadline, createdAt: _created, canActivate: _activate, canRefresh: _refresh, canRevoke: _revoke, ...snapshot } = installation;
  const sample = automaticSlackSample();
  return { id: "asgr-fixture", version: 1, digest: "b".repeat(64), readGrantId: sample.readGrantId, readGrantVersion: sample.readGrantVersion, readGrantDigest: "c".repeat(64), ownerId: AUTO_SLACK_ACTOR, ownerAccountId: snapshot.ownerAccountId,
    readContract: { ...automaticGrant().contract, ownerAccountId: snapshot.ownerAccountId },
    destination: { roomId: "room-fixture", roomTitle: "Fictional evidence room", linkId: "link-fixture", teamId: snapshot.teamId, channelId: "C123", threadTs: "123.456", ownerId: AUTO_SLACK_ACTOR, roomAudienceIds: [AUTO_SLACK_ACTOR, "approver@example.test"], installation: snapshot },
    renderPolicy: "complete-qualified-markdown.v1", maxBytes: 3500, disclosureScope: "all-people-with-access-to-selected-slack-channel-thread", futureAudienceScope: "all-current-and-future-people-with-access-to-selected-slack-channel-thread",
    sampleOccurrenceId: sample.sampleOccurrenceId, sampleReportHash: sample.sampleReportHash, sampleContent: AUTO_SLACK_CONTENT, sampleExpiresAt: sample.expiresAt, state: "draft", createdAt: Date.now(), expiresAt: Date.now() + 1_800_000, reviewExpiresAt: Date.now() + 600_000,
    approvedAt: null, approvedByUserId: null, maxSends: 2, usedSends: 0, errorCode: null, canDisclose: true, canApprove: false, canPause: false, canRevoke: true };
}
export function automaticSlackState(grant: AutomaticSlackGrant | null = automaticSlackGrant(), actorId = AUTO_SLACK_ACTOR): AutomaticSlackState {
  const destination = grant?.destination ?? automaticSlackGrant().destination;
  return { ok: true, workspaceId: AUTO_SLACK_WORKSPACE, libraryId: AUTO_SLACK_LIBRARY, actorId, available: true, unavailableReason: null, destinations: actorId === AUTO_SLACK_ACTOR ? [destination] : [], grants: grant ? [grant] : [], deliveries: [] };
}
