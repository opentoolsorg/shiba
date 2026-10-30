import { describe, expect, it } from "vitest";
import type { DelegatedRun, RunDeliverable } from "@shiba/shared";
import {
  allocateArtifactVersions,
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
    const lineageId = "task-root-1";
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
    const preparedFirst = await prepareRunArtifacts(first, [output], lineageId, 210);
    const firstOutput = allocateArtifactVersions(first, preparedFirst, [], lineageId, () => undefined);
    const second = run({ runId: "run-2", sandboxId: "sandbox-2", createdAt: 300, updatedAt: 400 });
    const preparedSecond = await prepareRunArtifacts(second, [output], lineageId, 410);
    const secondOutput = allocateArtifactVersions(
      second,
      preparedSecond,
      [{ ...first, deliverables: firstOutput }],
      lineageId,
      () => lineageId,
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

  it("scopes identities to the logical task, actor, repository and exact relative path", async () => {
    const source = run({ repoUrl: "" });
    const id = await artifactIdentity(source, output.path, "task-a");
    expect(id).toMatch(/^artifact_[a-f0-9]{32}$/);
    expect(await artifactIdentity(run({ repoUrl: "" }), output.path, "task-b")).not.toBe(id);
    expect(await artifactIdentity(run({ repoUrl: "" }), output.path, "task-a")).toBe(id);
    expect(await artifactIdentity(run({ queuedBy: "principal-b", repoUrl: "" }), output.path, "task-a")).not.toBe(id);
    expect(
      await artifactIdentity(run({ repoUrl: "https://github.com/acme/other" }), output.path, "task-a"),
    ).not.toBe(id);
    expect(await artifactIdentity(source, "reports/other.md", "task-a")).not.toBe(id);
    // Legacy artifacts without durable task lineage remain run-local by design.
    expect(await artifactIdentity(source, output.path)).not.toBe(await artifactIdentity(run({ runId: "run-2", repoUrl: "" }), output.path));
  });

  it("allocates unique increasing versions in completion order despite reversed creation order", async () => {
    const lineageId = "task-out-of-order";
    const older = run({ runId: "created-first", createdAt: 100, repoUrl: "" });
    const newer = run({ runId: "created-second", createdAt: 200, repoUrl: "" });
    const [preparedOlder, preparedNewer] = await Promise.all([
      prepareRunArtifacts(older, [output], lineageId, 300),
      prepareRunArtifacts(newer, [output], lineageId, 400),
    ]);
    const persisted: DelegatedRun[] = [];
    // Newer task attempt completes first; synchronous allocation+append is
    // the same critical section used before the DO completion transition.
    const newerCommitted = allocateArtifactVersions(newer, preparedNewer!, persisted, lineageId, () => lineageId);
    persisted.push({ ...newer, status: "completed", deliverables: newerCommitted });
    const olderCommitted = allocateArtifactVersions(older, preparedOlder!, persisted, lineageId, () => lineageId);
    persisted.push({ ...older, status: "completed", deliverables: olderCommitted });
    expect(newerCommitted[0]?.version).toBe(1);
    expect(olderCommitted[0]?.version).toBe(2);
    expect(new Set(persisted.flatMap((candidate) => candidate.deliverables?.map((item) => item.version))).size).toBe(2);
  });

  it("keeps legacy stored versions as a baseline when task lineage is recovered", async () => {
    const lineageId = "migrated-task";
    const legacy = run({ runId: "legacy-run", repoUrl: "", deliverables: [{ ...output, artifactId: "artifact_old", version: 3 }] });
    const next = run({ runId: "new-run", repoUrl: "" });
    const prepared = await prepareRunArtifacts(next, [output], lineageId, 500);
    const allocated = allocateArtifactVersions(next, prepared, [legacy], lineageId, () => lineageId);
    expect(allocated[0]?.version).toBe(4);
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
