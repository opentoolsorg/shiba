/** Deterministic capture checks; these do not assess a document's semantic quality. */
import {
  expectedDeliverablesSchema,
  MAX_DELIVERABLE_BYTES,
  MAX_TOTAL_DELIVERABLE_BYTES,
  type RunDeliverable,
  type RunResultArtifact,
} from "@shiba/shared";
import type { Env } from "./env.js";

interface CapturedFile {
  path: string;
  content: string | null;
  encoding: "utf8" | "base64";
}

function mediaType(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const types: Record<string, string> = {
    md: "text/markdown; charset=utf-8",
    txt: "text/plain; charset=utf-8",
    json: "application/json; charset=utf-8",
    csv: "text/csv; charset=utf-8",
  };
  return types[extension]!;
}

function containsBinaryControl(content: string): boolean {
  for (let index = 0; index < content.length; index++) {
    const code = content.charCodeAt(index);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

/** Only the approved paths become artifacts, in the approved order. */
export async function verifyExpectedDeliverables(
  expected: string[] | undefined,
  files: readonly CapturedFile[],
): Promise<RunResultArtifact[]> {
  if (expected === undefined) return [];
  const parsed = expectedDeliverablesSchema.safeParse(expected);
  if (!parsed.success) throw new Error("Invalid expected deliverable paths.");
  const artifacts: RunResultArtifact[] = [];
  let totalBytes = 0;
  for (const path of parsed.data) {
    const matches = files.filter((file) => file.path === path);
    if (matches.length !== 1) {
      throw new Error(`Deliverable ${path} must have exactly one complete captured file; found ${matches.length}.`);
    }
    const file = matches[0]!;
    if (file.encoding !== "utf8" || file.content === null) {
      throw new Error(`Deliverable ${path} must be a complete UTF-8 file.`);
    }
    const content = file.content;
    if (!content.trim()) throw new Error(`Deliverable ${path} is empty.`);
    const encoded = new TextEncoder().encode(content);
    if (new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(encoded) !== content || containsBinaryControl(content)) {
      throw new Error(`Deliverable ${path} contains binary or invalid UTF-8 text.`);
    }
    if (encoded.byteLength > MAX_DELIVERABLE_BYTES) {
      throw new Error(`Deliverable ${path} exceeds ${MAX_DELIVERABLE_BYTES} bytes; refusing truncated output.`);
    }
    totalBytes += encoded.byteLength;
    if (totalBytes > MAX_TOTAL_DELIVERABLE_BYTES) {
      throw new Error(`Deliverables exceed ${MAX_TOTAL_DELIVERABLE_BYTES} bytes in total.`);
    }
    if (path.toLowerCase().endsWith(".json")) {
      try { JSON.parse(content); } catch {
        throw new Error(`Deliverable ${path} is not valid JSON.`);
      }
    }
    const digest = await crypto.subtle.digest("SHA-256", encoded);
    const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    artifacts.push({ path, mediaType: mediaType(path), bytes: encoded.byteLength, sha256, content });
  }
  return artifacts;
}

/** The HTTP layer derives this key only after resolving an owned run's manifest. */
export function deliverableStorageKey(sandboxId: string, sha256: string, index: number): string {
  if (!sandboxId || !/^[a-f0-9]{64}$/.test(sha256) || !Number.isInteger(index) || index < 0 || index >= 8) {
    throw new Error("Invalid deliverable storage identity.");
  }
  return `run-deliverables/${encodeURIComponent(sandboxId)}/${index}-${sha256}`;
}

/** Bodies stay in private object storage; run/transcript envelopes carry metadata only. */
export async function persistRunDeliverables(
  env: Pick<Env, "ATTACHMENTS">,
  sandboxId: string,
  artifacts: readonly RunResultArtifact[],
): Promise<RunDeliverable[]> {
  if (artifacts.length === 0) return [];
  if (!env.ATTACHMENTS || typeof env.ATTACHMENTS.put !== "function") {
    throw new Error("Deliverable storage is not configured.");
  }
  // Recheck at the durable boundary: a caller cannot supply forged hashes,
  // byte counts, MIME types, or over-cap bodies as supposedly verified data.
  const verified = await verifyExpectedDeliverables(
    artifacts.map((artifact) => artifact.path),
    artifacts.map((artifact) => ({ path: artifact.path, content: artifact.content, encoding: "utf8" })),
  );
  for (let index = 0; index < verified.length; index++) {
    const checked = verified[index]!;
    const provided = artifacts[index]!;
    if (checked.sha256 !== provided.sha256 || checked.bytes !== provided.bytes || checked.mediaType !== provided.mediaType) {
      throw new Error(`Deliverable ${checked.path} metadata does not match its captured bytes.`);
    }
  }
  const metadata: RunDeliverable[] = [];
  for (const [index, artifact] of verified.entries()) {
    const { content, ...item } = artifact;
    const stored = await env.ATTACHMENTS.put(deliverableStorageKey(sandboxId, artifact.sha256, index), content, {
      httpMetadata: { contentType: artifact.mediaType },
    });
    if (!stored) throw new Error(`Deliverable ${artifact.path} could not be stored.`);
    metadata.push(item);
  }
  return metadata;
}
