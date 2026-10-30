import { describe, expect, it } from "vitest";
import type { DelegatedRun, RunDeliverable } from "@shiba/shared";
import {
  artifactIdentity,
  parseArtifactReview,
  prepareRunArtifacts,
  updateArtifactReview,
} from "../src/artifact-metadata.js";

const output: RunDeliverable = {
  path: "reports/brief.md",
  mediaType: "text/markdown",
  bytes: 4,
  sha256: "a".repeat(64),
};
function run(overrides: Partial<DelegatedRun> = {}): DelegatedRun {
  return {
    runId: "run-1",
    sandboxId: "sandbox-1",
    repoUrl: "https://github.com/acme/research",
    task: "write report",
    baseBranch: "main",
    publishPullRequest: false,
    generation: 1,
    status: "completed",
    createdAt: 100,
    updatedAt: 200,
    orgId: "org-a",
    queuedBy: "principal-a",
    ...overrides,
  };
}

describe("durable artifact metadata", () => {
  it("groups stable path identity without exposing its source URL and versions immutable run outputs", async () => {
    const first = run({
      skillPins: [
        {
          skillId: "skill-0123456789abcdef01234567",
          version: 3,
          name: "Research",
          sourceUrl: "https://private.example/skill",
        },
      ],
      customAgentId: "agent-1",
      customAgentVersion: 2,
    });
    const firstOutput = await prepareRunArtifacts(first, [output], [], 210);
    const second = run({ runId: "run-2", sandboxId: "sandbox-2", createdAt: 300, updatedAt: 400 });
    const secondOutput = await prepareRunArtifacts(
      second,
      [output],
      [{ ...first, deliverables: firstOutput }],
      410,
    );
    expect(secondOutput[0]).toMatchObject({
      artifactId: firstOutput[0]!.artifactId,
      version: 2,
      sourceRunId: "run-2",
      review: { status: "pending_review", updatedAt: 410 },
    });
    expect(firstOutput[0]?.provenance).toEqual({
      skills: [{ skillId: "skill-0123456789abcdef01234567", version: 3, name: "Research" }],
      customAgent: { id: "agent-1", version: 2 },
    });
    expect(JSON.stringify(firstOutput)).not.toContain("private.example");
    expect(JSON.stringify(firstOutput)).not.toContain("github.com/acme/research");
  });

  it("keeps identities scoped to the actor, repository and exact relative path", async () => {
    const source = run();
    const id = await artifactIdentity(source, output.path);
    expect(id).toMatch(/^artifact_[a-f0-9]{32}$/);
    expect(await artifactIdentity(run({ queuedBy: "principal-b" }), output.path)).not.toBe(id);
    expect(
      await artifactIdentity(run({ repoUrl: "https://github.com/acme/other" }), output.path),
    ).not.toBe(id);
    expect(await artifactIdentity(source, "reports/other.md")).not.toBe(id);
  });

  it("validates review actions and persists approved or requested-change state on completed runs only", () => {
    const source = run({ deliverables: [output] });
    expect(parseArtifactReview({ status: "approved" })).toEqual({ status: "approved" });
    expect(parseArtifactReview({ status: "changes_requested", note: "  Add sources  " })).toEqual({
      status: "changes_requested",
      note: "Add sources",
    });
    expect(parseArtifactReview({ status: "changes_requested" })).toBeNull();
    expect(parseArtifactReview({ status: "approved", note: "x".repeat(501) })).toBeNull();
    expect(
      updateArtifactReview(source, 0, { status: "approved" }, 500)?.deliverables?.[0]?.review,
    ).toEqual({ status: "approved", updatedAt: 500 });
    expect(
      updateArtifactReview(source, 0, { status: "changes_requested", note: "Add sources" }, 501)
        ?.deliverables?.[0]?.review,
    ).toEqual({ status: "changes_requested", updatedAt: 501, note: "Add sources" });
    expect(
      updateArtifactReview(run({ ...source, status: "running" }), 0, { status: "approved" }, 502),
    ).toBeNull();
    expect(updateArtifactReview(source, 1, { status: "approved" }, 503)).toBeNull();
  });
});
