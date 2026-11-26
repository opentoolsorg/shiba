import assert from "node:assert/strict";
import { test } from "node:test";
import { startResearchRoomFixture } from "./research-room-fixture.mjs";

test("invited reviewer can review exact private brief revisions, then loses room and artifact access", { timeout: 180_000 }, async () => {
  const fixture = await startResearchRoomFixture();
  const { owner, reviewer, reviewerMember, research, first, roomPath, request, claim } = fixture;
  try {
    assert.equal(first.handoff.parentHandoffId, research.handoff.handoffId);
    const firstPath = `${first.artifactPath}/review`;
    const ownerView = await request(owner, firstPath);
    const reviewerView = await request(reviewer, firstPath);
    assert.deepEqual(reviewerView, ownerView);
    const note = "Add a recommendation and explicitly separate the five-seat price gap.";
    const decide = (actor, route, revision, decision = {}) => request(actor, route, {
      body: { status: "approved", expectedRevision: revision, ...decision },
    });
    await decide(reviewer, firstPath, reviewerView.review.revision, { status: "changes_requested", note });
    await request(owner, firstPath, {
      body: { status: "approved", expectedRevision: ownerView.review.revision }, status: 409,
    });
    const second = await fixture.revise();
    assert.equal(second.handoff.parentHandoffId, first.handoff.handoffId);
    const secondPath = `${second.artifactPath}/review`;
    const current = await request(reviewer, secondPath);
    assert.notEqual(current.artifact.artifactId, reviewerView.artifact.artifactId);
    const approved = await decide(reviewer, secondPath, current.review.revision);
    assert.equal(approved.deliverable.artifactId, current.artifact.artifactId);
    assert.equal(approved.deliverable.version, current.artifact.version);
    assert.equal(approved.deliverable.review.status, "approved");
    assert.equal((await request(owner, firstPath)).review.status, "changes_requested");
    assert.deepEqual((await request(owner, roomPath)).slackDeliveryIntents, []);
    assert.equal((await claim()).envelope, null, "Review never dispatches or publishes work");
    await request(owner, `${roomPath}/members/${encodeURIComponent(reviewerMember.actorId)}`, { method: "DELETE" });
    await request(reviewer, roomPath, { status: 404 });
    await request(reviewer, second.artifactPath, { status: 404 });
    await request(reviewer, secondPath, { status: 404 });
    assert.equal((await request(owner, secondPath)).review.status, "approved");
  } finally {
    await fixture.stop();
  }
});
