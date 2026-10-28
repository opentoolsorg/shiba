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
}

/** Private durable body; strip from ordinary run HTTP projections. */
export interface RunResultArtifact extends RunDeliverable {
  content: string;
}
