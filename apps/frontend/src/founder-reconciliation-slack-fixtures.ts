import type { ReconciliationSlackGrant } from "@shiba/shared";
import { standingComparison } from "./founder-reconciliation-schedules-fixtures";
import { slackInstallationFixture } from "./slack-installations-fixtures";
export const SLACK_RECON_WORKSPACE = `ws_${"a".repeat(24)}`, SLACK_RECON_OWNER = "owner@example.test", SLACK_RECON_MANAGER = "manager@example.test";
export function reconciliationSlackFixture() {
  const { state: _state, digest: _digest, activationExpiresAt: _activation, createdAt: _created, canActivate: _activate, canRefresh: _refresh, canRevoke: _revoke, ...installation } = slackInstallationFixture().installations[0]!;
  const destination = { roomId: "room-one", roomTitle: "Evidence room", linkId: "link-one", teamId: installation.teamId, channelId: "C123", threadTs: "123.456", ownerId: SLACK_RECON_OWNER, roomAudienceIds: [SLACK_RECON_OWNER, SLACK_RECON_MANAGER], installation };
  const schedule = { ...standingComparison(), state: "enabled" as const }, now = Date.now();
  const grant: ReconciliationSlackGrant = { id: `arsg_${"a".repeat(32)}`, sourceKind: "reconciliation-schedule.v1", version: 1, digest: "a".repeat(64), ownerId: SLACK_RECON_OWNER, ownerAccountId: installation.ownerAccountId, schedule, destination, sampleResultId: `frr_${"b".repeat(32)}`, sampleHash: "c".repeat(64), sampleContent: "Qualified captured rows: incomplete; business unverified.", sampleExpiresAt: now + 60000, renderPolicy: "reconciliation-qualified-rows.v1", rendererDigest: "f".repeat(64), futureAudience: "all-current-and-future-people-with-access-to-selected-slack-channel-thread", maxBytes: 3500, state: "draft", createdAt: now, expiresAt: now + 3600000, reviewExpiresAt: now + 60000, approvedAt: null, approvedBy: null, maxSends: 2, usedSends: 0 };
  return { grant, destination, sample: { scheduleId: schedule.id, sampleResultId: grant.sampleResultId, sampleHash: grant.sampleHash, expiresAt: now + 60000, scheduleExpiresAt: schedule.expiresAt } };
}
