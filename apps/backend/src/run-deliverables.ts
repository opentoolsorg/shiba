/** Deterministic capture checks; these do not assess a document's semantic quality. */
import {
  deliverableByteLimit,
  deliverableBudget,
  deliverableBudgetLimits,
  deliverableExtension,
  deliverableMediaType,
  expectedDeliverablesSchema,
  hasDeliverableMagic,
  isBinaryDeliverablePath,
  type RunDeliverable,
  type RunResultArtifact,
  type RunArtifactBundle,
} from "@shiba/shared";
import type { Env } from "./env.js";
import { assertWorkspaceArtifactConfiguration, createArtifactDownloadUrl, type ArtifactDownloadClaims } from "./artifact-download.js";
import { prepareWorkspaceArchive } from "./workspace-archive.js";

export interface CapturedFile {
  path: string;
  content: string | null;
  encoding: "utf8" | "base64";
}

export const MAX_WORKSPACE_ARTIFACT_FILES = 64;
export const MAX_WORKSPACE_ARTIFACT_BYTES = 1_048_576;
export const MAX_WORKSPACE_ARTIFACT_TOTAL_BYTES = 8_388_608;
export const MAX_WORKSPACE_ARCHIVE_BYTES = MAX_WORKSPACE_ARTIFACT_TOTAL_BYTES + MAX_WORKSPACE_ARTIFACT_FILES * 600 + 22;

/** Archive names never follow hidden paths, parent traversal or platform-specific separators. */
export function isWorkspaceArtifactPath(path: string): boolean {
  return path.startsWith("out/") && path.length <= 240 && path === path.trim() &&
    path.split("/").every((part) => part === part.trim() && /^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(part));
}

function artifactBytes(file: CapturedFile): Uint8Array<ArrayBuffer> {
  if (file.content === null) throw new Error(`Artifact ${file.path} was not captured completely.`);
  if (file.encoding === "utf8") {
    if (file.content.length > MAX_WORKSPACE_ARTIFACT_BYTES) throw new Error(`Artifact ${file.path} exceeds its byte limit.`);
    const bytes = new TextEncoder().encode(file.content);
    if (new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) !== file.content) {
      throw new Error(`Artifact ${file.path} contains invalid Unicode.`);
    }
    return bytes;
  }
  if (file.content.length > Math.ceil(MAX_WORKSPACE_ARTIFACT_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) {
    throw new Error(`Artifact ${file.path} has malformed or excessive byte transport.`);
  }
  const raw = atob(file.content);
  if (btoa(raw) !== file.content) throw new Error(`Artifact ${file.path} has noncanonical byte transport.`);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

/** Deterministic ZIP store format. Bounded entries avoid ZIP64 and decompression expansion. */
function prepareCapturedWorkspaceArchive(files: readonly CapturedFile[]) {
  const selected = files.filter((file) => file.path.startsWith("out/"));
  if (selected.length > MAX_WORKSPACE_ARTIFACT_FILES) throw new Error("Workspace artifact file count exceeds its limit.");
  const names = new Set<string>();
  let totalBytes = 0;
  const entries = selected.map((file) => {
    if (!isWorkspaceArtifactPath(file.path)) throw new Error("Workspace artifact path is unsafe.");
    const name = file.path.slice(4);
    if (names.has(name.toLowerCase())) throw new Error("Workspace artifact paths must be unique.");
    names.add(name.toLowerCase());
    const bytes = artifactBytes(file);
    if (bytes.byteLength > MAX_WORKSPACE_ARTIFACT_BYTES) throw new Error(`Artifact ${file.path} exceeds its byte limit.`);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_WORKSPACE_ARTIFACT_TOTAL_BYTES) throw new Error("Workspace artifact bytes exceed their total limit.");
    return { name, bytes };
  }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  return prepareWorkspaceArchive(entries, MAX_WORKSPACE_ARCHIVE_BYTES);
}

/** Buffered adapter for callers that need bytes; persistence uses the stream directly. */
export function workspaceArtifactArchive(files: readonly CapturedFile[]): { bytes: Uint8Array<ArrayBuffer>; fileCount: number } {
  const archive = prepareCapturedWorkspaceArchive(files);
  const bytes = new Uint8Array(archive.byteLength);
  let offset = 0;
  for (const chunk of archive.chunks()) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, fileCount: archive.fileCount };
}

export function workspaceArchiveStorageKey(scope: string, sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(scope) || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid workspace archive identity.");
  return `run-archives/${scope}/${sha256}.zip`;
}

export async function persistWorkspaceArchive(
  env: Pick<Env, "ARTIFACTS" | "ARTIFACT_SIGNING_KEY" | "WORKER_HOSTNAME">,
  identity: { ownerId: string; runId: string; sandboxId: string },
  files: readonly CapturedFile[],
  now = Date.now(),
  signal?: AbortSignal,
): Promise<RunArtifactBundle> {
  signal?.throwIfAborted();
  if (!identity.ownerId || !identity.runId || !identity.sandboxId ||
      Object.values(identity).some((part) => part.length > 512)) throw new Error("Workspace archive requires an owned run identity.");
  assertWorkspaceArtifactConfiguration(env);
  const archive = prepareCapturedWorkspaceArchive(files);
  const { sha256 } = archive;
  const scopeBytes = new TextEncoder().encode(JSON.stringify([identity.ownerId, identity.runId, identity.sandboxId]));
  const scope = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", scopeBytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const claims: ArtifactDownloadClaims = { version: 1, scope, sha256, bytes: archive.byteLength, fileCount: archive.fileCount, issuedAt: now, expiresAt: now + 7 * 24 * 60 * 60 * 1000 };
  // Sign before persisting. Missing signing configuration cannot leave orphaned output behind.
  const downloadUrl = await createArtifactDownloadUrl(env, claims);
  signal?.throwIfAborted();
  const transfer = new AbortController();
  const transferSignal = signal ? AbortSignal.any([signal, transfer.signal]) : transfer.signal;
  const { readable, writable } = new FixedLengthStream(archive.byteLength);
  const pumping = archive.writeTo(writable, transferSignal);
  // Observe producer failures immediately, including while R2 is still consuming the body.
  void pumping.catch((error: unknown) => transfer.abort(error));
  try {
    const stored = await env.ARTIFACTS.put(workspaceArchiveStorageKey(scope, sha256), readable, {
      httpMetadata: { contentType: "application/zip", contentDisposition: 'attachment; filename="artifacts.zip"' },
      customMetadata: { scope, sha256, bytes: String(claims.bytes), fileCount: String(claims.fileCount) },
      sha256,
    });
    if (!stored) throw new Error("Workspace archive could not be stored.");
    await pumping;
    transferSignal.throwIfAborted();
  } catch (error) {
    transfer.abort(error);
    await readable.cancel(error).catch(() => {});
    await pumping.catch(() => {});
    throw error;
  }
  return { path: "artifacts.zip", mediaType: "application/zip", bytes: claims.bytes, sha256, fileCount: claims.fileCount, downloadUrl, expiresAt: claims.expiresAt };
}

function mediaType(path: string): string {
  return deliverableMediaType(path)!;
}

function base64Bytes(content: string): Uint8Array<ArrayBuffer> | null {
  if (content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) return null;
  const raw = atob(content);
  if (btoa(raw) !== content) return null;
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
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
  const totals = { text: 0, report: 0, "office-media": 0 };
  for (const path of parsed.data) {
    const matches = files.filter((file) => file.path === path);
    if (matches.length !== 1) {
      throw new Error(`Deliverable ${path} must have exactly one complete captured file; found ${matches.length}.`);
    }
    const file = matches[0]!;
    let encoded: Uint8Array<ArrayBuffer>;
    let content: string;
    let encoding: "base64" | undefined;
    const limit = deliverableByteLimit(path);
    if (isBinaryDeliverablePath(path)) {
      if (file.content !== null && file.content.length > Math.ceil(limit / 3) * 4) {
        throw new Error(`Deliverable ${path} exceeds ${limit} bytes; refusing truncated output.`);
      }
      const bytes = file.encoding === "base64" && file.content !== null ? base64Bytes(file.content) : null;
      if (!bytes || !hasDeliverableMagic(path, bytes)) throw new Error(`Deliverable ${path} is not a valid ${deliverableExtension(path).toUpperCase()} file.`);
      encoded = bytes;
      content = file.content!;
      encoding = "base64";
    } else {
      if (file.encoding !== "utf8" || file.content === null) {
        throw new Error(`Deliverable ${path} must be a complete UTF-8 file.`);
      }
      content = file.content;
      if (!content.trim()) throw new Error(`Deliverable ${path} is empty.`);
      encoded = new TextEncoder().encode(content);
      if (new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(encoded) !== content || containsBinaryControl(content)) {
        throw new Error(`Deliverable ${path} contains binary or invalid UTF-8 text.`);
      }
    }
    if (encoded.byteLength > limit) throw new Error(`Deliverable ${path} exceeds ${limit} bytes; refusing truncated output.`);
    const budget = deliverableBudget(path);
    totals[budget] += encoded.byteLength;
    if (totals[budget] > deliverableBudgetLimits[budget]) {
      const label = budget === "report" ? "HTML and PDF deliverables" : budget === "office-media" ? "Office and media deliverables" : "Deliverables";
      throw new Error(`${label} exceed ${deliverableBudgetLimits[budget]} bytes in total.`);
    }
    if (path.toLowerCase().endsWith(".json")) {
      try { JSON.parse(content); } catch {
        throw new Error(`Deliverable ${path} is not valid JSON.`);
      }
    }
    const digest = await crypto.subtle.digest("SHA-256", encoded);
    const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    artifacts.push({ path, mediaType: mediaType(path), bytes: encoded.byteLength, sha256, content, ...(encoding ? { encoding } : {}) });
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
    artifacts.map((artifact) => ({ path: artifact.path, content: artifact.content, encoding: artifact.encoding ?? "utf8" })),
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
    const { content, encoding, ...item } = artifact;
    const body = encoding === "base64" ? base64Bytes(content)! : content;
    const stored = await env.ATTACHMENTS.put(deliverableStorageKey(sandboxId, artifact.sha256, index), body, {
      httpMetadata: { contentType: artifact.mediaType },
    });
    if (!stored) throw new Error(`Deliverable ${artifact.path} could not be stored.`);
    metadata.push(item);
  }
  return metadata;
}
