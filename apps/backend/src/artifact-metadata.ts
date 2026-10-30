import type { ArtifactReviewStatus, DelegatedRun, RunDeliverable } from "@shiba/shared";

export interface ArtifactReviewInput {
  status: ArtifactReviewStatus;
  note?: string;
}

const reviewStatuses = new Set<ArtifactReviewStatus>([
  "pending_review",
  "approved",
  "changes_requested",
]);

function digestHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Stable opaque grouping key; unrelated tasks never share an artifact family. */
export async function artifactIdentity(
  run: DelegatedRun,
  path: string,
  taskLineageId?: string,
): Promise<string> {
  // Legacy runs without a durable task record migrate as one-run histories.
  // This intentionally avoids grouping unrelated legacy repository-free tasks.
  const lineage = taskLineageId ? `task:${taskLineageId}` : `legacy-run:${run.runId}`;
  const scope = [run.orgId ?? "", run.queuedBy ?? "", lineage, run.repoUrl, path].join("\0");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(scope));
  return `artifact_${digestHex(digest).slice(0, 32)}`;
}

/** Prepare stable identity and provenance; version allocation is a separate synchronous DO commit step. */
export async function prepareRunArtifacts(
  run: DelegatedRun,
  artifacts: readonly RunDeliverable[],
  taskLineageId: string | undefined,
  now: number,
): Promise<RunDeliverable[]> {
  const output: RunDeliverable[] = [];
  for (const item of artifacts) {
    const artifactId = await artifactIdentity(run, item.path, taskLineageId);
    output.push({
      ...item,
      artifactId,
      sourceRunId: run.runId,
      provenance: {
        ...(run.skillPins?.length
          ? {
              skills: run.skillPins.map(({ skillId, version: skillVersion, name }) => ({
                skillId,
                version: skillVersion,
                name,
              })),
            }
          : {}),
        ...(run.customAgentId && run.customAgentVersion
          ? { customAgent: { id: run.customAgentId, version: run.customAgentVersion } }
          : {}),
      },
      review: { status: "pending_review", updatedAt: now },
    });
  }
  return output;
}

/**
 * Allocate versions synchronously against the current DO run projection.
 * Call immediately before the completion transition, with no await between
 * this read and the transition commit. A later-created run that finishes
 * first receives the next version; wall-clock creation order is irrelevant.
 */
export function allocateArtifactVersions(
  run: DelegatedRun,
  prepared: readonly RunDeliverable[],
  allRuns: readonly DelegatedRun[],
  taskLineageId: string | undefined,
  lineageForRun: (candidate: DelegatedRun) => string | undefined,
): RunDeliverable[] {
  return prepared.map((item) => {
    let maxVersion = 0;
    for (const priorRun of allRuns) {
      if (
        priorRun.runId === run.runId ||
        !taskLineageId ||
        lineageForRun(priorRun) !== taskLineageId ||
        (priorRun.orgId ?? "") !== (run.orgId ?? "") ||
        (priorRun.queuedBy ?? "") !== (run.queuedBy ?? "") ||
        priorRun.repoUrl !== run.repoUrl
      ) continue;
      for (const prior of priorRun.deliverables ?? []) {
        if (prior.path === item.path) maxVersion = Math.max(maxVersion, prior.version ?? 1);
      }
    }
    return { ...item, version: maxVersion + 1 };
  });
}

export function parseArtifactReview(value: unknown): ArtifactReviewInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.status !== "string" || !reviewStatuses.has(body.status as ArtifactReviewStatus))
    return null;
  if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 500))
    return null;
  const note =
    body.status === "changes_requested" && typeof body.note === "string"
      ? body.note.trim()
      : undefined;
  if (body.status === "changes_requested" && !note) return null;
  return { status: body.status as ArtifactReviewStatus, ...(note ? { note } : {}) };
}

export function updateArtifactReview(
  run: DelegatedRun,
  index: number,
  input: ArtifactReviewInput,
  now: number,
): DelegatedRun | null {
  const currentDeliverables = run.deliverables;
  const current = currentDeliverables?.[index];
  if (!current || !currentDeliverables || run.status !== "completed") return null;
  const deliverables = currentDeliverables.map((item, itemIndex) =>
    itemIndex === index
      ? {
          ...item,
          review: {
            status: input.status,
            updatedAt: now,
            ...(input.note ? { note: input.note } : {}),
          },
        }
      : item,
  );
  return { ...run, deliverables };
}
