/** Bounded, opt-in workspace deliverables. These checks do not assess semantic quality. */
import { z } from "zod";

export const MAX_DELIVERABLE_BYTES = 16_384;
export const MAX_HTML_DELIVERABLE_BYTES = 524_288;
export const MAX_PDF_DELIVERABLE_BYTES = 10_485_760;
export const MAX_TOTAL_DELIVERABLE_BYTES = 65_536;
/** Budget for html and pdf files, counted apart from the text total. */
export const MAX_TOTAL_LARGE_DELIVERABLE_BYTES = MAX_PDF_DELIVERABLE_BYTES + MAX_HTML_DELIVERABLE_BYTES;
const MAX_OFFICE_AND_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_BINARY_DELIVERABLE_BYTES = 12 * 1024 * 1024;
export const MAX_TOTAL_MEDIA_DELIVERABLE_BYTES = 16 * 1024 * 1024;
export const MAX_EXPECTED_DELIVERABLES = 8;

/** Appended to employee task prompts so dashboards survive the sandboxed viewer. */
export const DELIVERABLE_FORMAT_HINT =
  "For a .html dashboard or report, write one self-contained file: inline CSS and JS, data embedded as a JSON script block, and optionally Chart.js from https://cdn.jsdelivr.net. It is shown in a sandbox with no network access and no other external resources. For a .pdf, write a real PDF file. For .xlsx and .docx, create valid Office Open XML packages; Python's standard-library zipfile and xml.etree.ElementTree are available in the cloud sandbox, so no network or package install is needed. Write images and video in their actual file format; do not rename text.";

type Signature = (bytes: Uint8Array) => boolean;
const magic = (signature: readonly number[], offset = 0): Signature => (bytes) =>
  signature.every((byte, index) => bytes[offset + index] === byte);
const ascii = (text: string, offset = 0): Signature => magic(Array.from(text, (char) => char.charCodeAt(0)), offset);
const zip = magic([0x50, 0x4b, 0x03, 0x04]);
const jpeg = magic([0xff, 0xd8, 0xff]);
const riff = ascii("RIFF");
const webp = ascii("WEBP", 8);
const gif87 = ascii("GIF87a");
const gif89 = ascii("GIF89a");
const ftyp = ascii("ftyp", 4);
const mp4: Signature = (bytes) => {
  if (bytes.length < 16 || !ftyp(bytes)) return false;
  const size = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
  return size >= 16 && size <= bytes.length && size % 4 === 0;
};

export const hasPdfMagic = ascii("%PDF-");

type DeliverableBudget = "text" | "report" | "office-media";
type Format = { mime: string; bytes?: number; budget?: DeliverableBudget; signature?: Signature; inline?: boolean };
const formats: Readonly<Record<string, Format>> = {
  md: { mime: "text/markdown; charset=utf-8" },
  txt: { mime: "text/plain; charset=utf-8" },
  json: { mime: "application/json; charset=utf-8" },
  csv: { mime: "text/csv; charset=utf-8" },
  html: { mime: "text/html; charset=utf-8", bytes: MAX_HTML_DELIVERABLE_BYTES, budget: "report", inline: true },
  pdf: { mime: "application/pdf", bytes: MAX_PDF_DELIVERABLE_BYTES, budget: "report", signature: hasPdfMagic, inline: true },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: MAX_OFFICE_AND_IMAGE_BYTES, budget: "office-media", signature: zip },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: MAX_OFFICE_AND_IMAGE_BYTES, budget: "office-media", signature: zip },
  pptx: { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", bytes: MAX_OFFICE_AND_IMAGE_BYTES, budget: "office-media", signature: zip },
  png: { mime: "image/png", bytes: MAX_OFFICE_AND_IMAGE_BYTES, budget: "office-media", signature: magic([137, 80, 78, 71, 13, 10, 26, 10]), inline: true },
  jpg: { mime: "image/jpeg", bytes: MAX_OFFICE_AND_IMAGE_BYTES, budget: "office-media", signature: jpeg, inline: true },
  jpeg: { mime: "image/jpeg", bytes: MAX_OFFICE_AND_IMAGE_BYTES, budget: "office-media", signature: jpeg, inline: true },
  webp: { mime: "image/webp", bytes: MAX_OFFICE_AND_IMAGE_BYTES, budget: "office-media", signature: (bytes) => riff(bytes) && webp(bytes), inline: true },
  gif: { mime: "image/gif", bytes: MAX_OFFICE_AND_IMAGE_BYTES, budget: "office-media", signature: (bytes) => gif87(bytes) || gif89(bytes), inline: true },
  mp4: { mime: "video/mp4", bytes: MAX_BINARY_DELIVERABLE_BYTES, budget: "office-media", signature: mp4, inline: true },
};

export const DELIVERABLE_MEDIA_TYPES: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(formats).map(([ext, format]) => [ext, format.mime]));

export const deliverableExtension = (path: string) => path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : "";
const formatOf = (path: string) => {
  const extension = deliverableExtension(path);
  return Object.hasOwn(formats, extension) ? formats[extension] : undefined;
};

export const deliverableBudgetLimits: Readonly<Record<DeliverableBudget, number>> = {
  text: MAX_TOTAL_DELIVERABLE_BYTES,
  report: MAX_TOTAL_LARGE_DELIVERABLE_BYTES,
  "office-media": MAX_TOTAL_MEDIA_DELIVERABLE_BYTES,
};
export const deliverableBudget = (path: string): DeliverableBudget => formatOf(path)?.budget ?? "text";
export const canPreviewDeliverableInline = (path: string): boolean => formatOf(path)?.inline === true;
export const hasDeliverableMagic = (path: string, bytes: Uint8Array): boolean => formatOf(path)?.signature?.(bytes) === true;

export function deliverableMediaType(path: string): string | undefined {
  return formatOf(path)?.mime;
}

export function isBinaryDeliverablePath(path: string): boolean {
  return formatOf(path)?.signature !== undefined;
}

export function deliverableByteLimit(path: string): number {
  return formatOf(path)?.bytes ?? MAX_DELIVERABLE_BYTES;
}

export function isSafeDeliverablePath(path: string): boolean {
  if (!path || path.length > 240 || path !== path.trim() || !formatOf(path)) return false;
  return path.split("/").every((part) =>
    part.length > 0 && part === part.trim() && /^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(part),
  );
}

export const expectedDeliverablesSchema = z.array(
  z.string().max(240).refine(isSafeDeliverablePath, "Expected deliverable must be a safe relative non-hidden path with a supported file extension."),
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
  /** UTF-8 text, or base64 for binary formats. */
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
