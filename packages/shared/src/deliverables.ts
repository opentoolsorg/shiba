/** Bounded, opt-in workspace deliverables. These checks do not assess semantic quality. */
import { z } from "zod";

export const MAX_DELIVERABLE_BYTES = 16_384;
export const MAX_HTML_DELIVERABLE_BYTES = 524_288;
export const MAX_PDF_DELIVERABLE_BYTES = 10_485_760;
export const MAX_TOTAL_DELIVERABLE_BYTES = 65_536;
/** Budget for html and pdf files, counted apart from the text total. */
export const MAX_TOTAL_LARGE_DELIVERABLE_BYTES = MAX_PDF_DELIVERABLE_BYTES + MAX_HTML_DELIVERABLE_BYTES;
export const MAX_EXPECTED_DELIVERABLES = 8;

/** Appended to employee task prompts so dashboards survive the sandboxed viewer. */
export const DELIVERABLE_FORMAT_HINT =
  "For a .html dashboard or report, write one self-contained file: inline CSS and JS, data embedded as a JSON script block, and optionally Chart.js from https://cdn.jsdelivr.net. It is shown in a sandbox with no network access and no other external resources. For a .pdf, write a real PDF file.";

/** Single source for every route that serves a deliverable. */
export const DELIVERABLE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  html: "text/html; charset=utf-8",
  pdf: "application/pdf",
};

const extensionOf = (path: string) => path.slice(path.lastIndexOf(".") + 1).toLowerCase();

export function deliverableMediaType(path: string): string | undefined {
  return DELIVERABLE_MEDIA_TYPES[extensionOf(path)];
}

export function isBinaryDeliverablePath(path: string): boolean {
  return extensionOf(path) === "pdf";
}

export function deliverableByteLimit(path: string): number {
  const extension = extensionOf(path);
  return extension === "pdf" ? MAX_PDF_DELIVERABLE_BYTES : extension === "html" ? MAX_HTML_DELIVERABLE_BYTES : MAX_DELIVERABLE_BYTES;
}

/** Magic-bytes check: a renamed text file is not a PDF. */
export function hasPdfMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && [0x25, 0x50, 0x44, 0x46, 0x2d].every((value, index) => bytes[index] === value);
}

export function isSafeDeliverablePath(path: string): boolean {
  if (!path || path.length > 240 || path !== path.trim() || !/\.(?:md|txt|json|csv|html|pdf)$/i.test(path)) return false;
  return path.split("/").every((part) =>
    part.length > 0 && part === part.trim() && /^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(part),
  );
}

export const expectedDeliverablesSchema = z.array(
  z.string().max(240).refine(isSafeDeliverablePath, "Expected deliverable must be a safe relative non-hidden md/txt/json/csv/html/pdf path."),
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
  /** UTF-8 text, or base64 when `encoding` is "base64" (PDF). */
  content: string;
  encoding?: "base64";
}

/** Immutable archive of the explicitly selected ephemeral workspace output directory. */
export interface RunArtifactBundle {
  path: "artifacts.zip";
  mediaType: "application/zip";
  bytes: number;
  sha256: string;
  fileCount: number;
  downloadUrl: string;
  expiresAt: number;
}
