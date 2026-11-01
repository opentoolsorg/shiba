/** Bounded, opt-in workspace deliverables. These checks do not assess semantic quality. */
import { z } from "zod";

export const MAX_DELIVERABLE_BYTES = 16_384;
export const MAX_TOTAL_DELIVERABLE_BYTES = 65_536;
export const MAX_EXPECTED_DELIVERABLES = 8;

export function isSafeDeliverablePath(path: string): boolean {
  if (!path || path.length > 240 || path !== path.trim() || !/\.(?:md|txt|json|csv)$/i.test(path)) return false;
  return path.split("/").every((part) =>
    part.length > 0 && part === part.trim() && /^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(part),
  );
}

export const expectedDeliverablesSchema = z.array(
  z.string().max(240).refine(isSafeDeliverablePath, "Expected deliverable must be a safe relative non-hidden md/txt/json/csv path."),
).max(MAX_EXPECTED_DELIVERABLES).refine(
  (paths) => new Set(paths.map((path) => path.toLowerCase())).size === paths.length,
  "Expected deliverable paths must be unique, including on case-insensitive filesystems.",
);

export interface RunDeliverable {
  path: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  /** Stable logical output identity within the owning run store. */
  artifactId?: string;
  /** Monotonic version for this artifact identity; legacy rows omit it. */
  version?: number;
  /** Run that produced these immutable bytes. */
  sourceRunId?: string;
  provenance?: ArtifactProvenance;
  review?: ArtifactReview;
}

export interface ArtifactProvenance {
  onboarding?: { draftTaskId: string; version: number; sources: Array<{ id: string; version: number; sha256: string }> };
  skills?: Array<{ skillId: string; version: number; name: string }>;
  customAgent?: { id: string; version: number };
}

export type ArtifactReviewStatus = "pending_review" | "approved" | "changes_requested";
export interface ArtifactReview {
  status: ArtifactReviewStatus;
  /** Monotonic compare-and-set version. Missing on pre-CAS stored records. */
  revision?: number;
  updatedAt?: number;
  note?: string;
}

/** Private durable body; strip from ordinary run HTTP projections. */
export interface RunResultArtifact extends RunDeliverable {
  content: string;
}
