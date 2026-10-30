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

/** Stable opaque grouping key; it contains no repository URL or source link. */
export async function artifactIdentity(run: DelegatedRun, path: string): Promise<string> {
  const scope = [run.orgId ?? "", run.queuedBy ?? "", run.repoUrl, path].join("\0");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(scope));
  return `artifact_${digestHex(digest).slice(0, 32)}`;
}

/** Attach immutable run/skill provenance and a version number before the completion event is stored. */
export async function prepareRunArtifacts(
  run: DelegatedRun,
  artifacts: readonly RunDeliverable[],
  allRuns: readonly DelegatedRun[],
  now: number,
): Promise<RunDeliverable[]> {
  const output: RunDeliverable[] = [];
  for (const item of artifacts) {
    const artifactId = await artifactIdentity(run, item.path);
    let version = 1;
    for (const priorRun of allRuns) {
      if (priorRun.runId === run.runId || priorRun.createdAt > run.createdAt) continue;
      for (const prior of priorRun.deliverables ?? []) {
        const priorIdentity = await artifactIdentity(priorRun, prior.path);
        if (priorIdentity === artifactId) version = Math.max(version, (prior.version ?? 0) + 1);
      }
    }
    output.push({
      ...item,
      artifactId,
      version,
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
