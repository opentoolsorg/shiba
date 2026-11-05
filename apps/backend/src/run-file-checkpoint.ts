import { z } from "zod";
import {
  expectedDeliverablesSchema, MAX_DELIVERABLE_BYTES, MAX_TOTAL_DELIVERABLE_BYTES, redactSecrets,
} from "@shiba/shared";
import { runtimeIdentity } from "./runtime-recovery.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(512);
const MAX_LEASE_MS = 86_400_000;
const MAX_OBJECT_BYTES = 512_000;
const KEY = "shiba:approved-file-checkpoint:v1";

async function contentDigest(content: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Private, opt-in policy: the caller must verify it against the frozen signed envelope. */
export const fileCheckpointPolicySchema = z.object({
  version: z.literal(1), consent: z.literal("approved-files"),
  ownerAccountId: id, sessionId: id, runId: id, approvalId: id,
  envelopeHash: digest, sourceEpoch: id, leaseId: id,
  createdAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(),
  paths: expectedDeliverablesSchema.refine((paths) => paths.length > 0),
}).strict().refine((policy) => policy.expiresAt > policy.createdAt && policy.expiresAt - policy.createdAt <= MAX_LEASE_MS);
export type FileCheckpointPolicy = z.infer<typeof fileCheckpointPolicySchema>;

const fileSchema = z.object({
  path: z.string().max(240), content: z.string().max(MAX_DELIVERABLE_BYTES),
  bytes: z.number().int().min(0).max(MAX_DELIVERABLE_BYTES), sha256: digest,
}).strict();
const snapshotSchema = z.object({
  version: z.literal(1), kind: z.literal("approved-files"), policyHash: digest,
  files: z.array(fileSchema).min(1).max(8),
}).strict();
const receiptSchema = z.object({
  version: z.literal(1), policyHash: digest, objectHash: digest,
  expiresAt: z.number().int().positive(), state: z.enum(["pending", "committed", "revoked"]),
}).strict();
type Receipt = z.infer<typeof receiptSchema>;

interface ReceiptTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}
export interface FileCheckpointStorage extends ReceiptTransaction {
  transaction<T>(callback: (transaction: ReceiptTransaction) => Promise<T>): Promise<T>;
}
/** Compatible with the existing private ARTIFACTS R2 binding. No public downloads. */
export interface FileCheckpointBucket {
  put(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<{ size: number; text(): Promise<string> } | null>;
  delete(key: string): Promise<void>;
}
export interface ApprovedCheckpointFile { path: string; content: string }
type Action = "capture" | "read" | "revoke";

/** No routes or runtime adapter enable this store by default. One receipt per run-owned DO. */
export class RunFileCheckpointStore {
  constructor(
    private readonly storage: FileCheckpointStorage,
    private readonly bucket: FileCheckpointBucket,
    // Must recheck native account/session, source/installation fences, approval and lease.
    private readonly assertCurrent: (policy: FileCheckpointPolicy, action: Action) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  private async authorize(value: FileCheckpointPolicy, action: Action) {
    const policy = fileCheckpointPolicySchema.parse(value);
    this.checkClock(policy);
    await this.assertCurrent(policy, action);
    this.checkClock(policy);
    return policy;
  }

  private checkClock(policy: FileCheckpointPolicy) {
    if (policy.createdAt > this.now() || policy.expiresAt <= this.now()) throw new Error("File checkpoint lease is unavailable.");
  }

  private objectKey(receipt: Receipt) {
    return `approved-file-checkpoints/v1/${receipt.policyHash}/${receipt.objectHash}.json`;
  }

  private async required(policyHash: string): Promise<Receipt> {
    const receipt = receiptSchema.parse(await this.storage.get(KEY));
    if (receipt.policyHash !== policyHash || receipt.state !== "committed") throw new Error("File checkpoint is missing, incomplete or revoked.");
    return receipt;
  }

  /** Only an approved descriptor-anchored exporter may supply these regular UTF-8 files. */
  async capture(value: FileCheckpointPolicy, exported: readonly ApprovedCheckpointFile[]) {
    const policy = await this.authorize(value, "capture");
    const policyHash = await runtimeIdentity(policy);
    const files = await this.validateFiles(policy, exported);
    const snapshot = snapshotSchema.parse({ version: 1, kind: "approved-files", policyHash, files });
    const text = JSON.stringify(snapshot);
    if (new TextEncoder().encode(text).byteLength > MAX_OBJECT_BYTES) throw new Error("File checkpoint exceeds its storage bound.");
    const objectHash = await runtimeIdentity(snapshot);
    const receipt: Receipt = { version: 1, policyHash, objectHash, expiresAt: policy.expiresAt, state: "pending" };
    await this.authorize(policy, "capture");
    await this.storage.transaction(async (tx) => {
      const previous = await tx.get<unknown>(KEY);
      if (previous !== undefined) {
        const record = receiptSchema.parse(previous);
        if (record.policyHash !== policyHash || record.objectHash !== objectHash || record.state === "revoked") {
          throw new Error("File checkpoint attempt is already claimed or revoked.");
        }
      } else await tx.put(KEY, receipt);
    });
    await this.authorize(policy, "capture");
    await this.bucket.put(this.objectKey(receipt), text);
    await this.authorize(policy, "capture");
    // Receipt commits last. Interrupted uploads cannot become readable checkpoints.
    await this.storage.transaction(async (tx) => {
      const record = receiptSchema.parse(await tx.get(KEY));
      if (record.state === "revoked" || record.policyHash !== policyHash || record.objectHash !== objectHash) {
        throw new Error("File checkpoint claim changed.");
      }
      await tx.put(KEY, { ...record, state: "committed" });
    });
    await this.authorize(policy, "capture");
    await this.required(policyHash);
    return { kind: "approved-files" as const, checkpointHash: objectHash, fileCount: files.length,
      bytes: files.reduce((sum, file) => sum + file.bytes, 0), expiresAt: policy.expiresAt };
  }

  /** Returns a verified restore payload, not process memory, an output ACK or permission to exec. */
  async read(value: FileCheckpointPolicy) {
    const policy = await this.authorize(value, "read");
    const policyHash = await runtimeIdentity(policy);
    const receipt = await this.required(policyHash);
    if (receipt.expiresAt !== policy.expiresAt) throw new Error("File checkpoint lease changed.");
    const object = await this.bucket.get(this.objectKey(receipt));
    if (!object || object.size > MAX_OBJECT_BYTES) throw new Error("File checkpoint object is unavailable.");
    const text = await object.text();
    if (new TextEncoder().encode(text).byteLength !== object.size || object.size > MAX_OBJECT_BYTES) {
      throw new Error("File checkpoint object size changed.");
    }
    const snapshot = snapshotSchema.parse(JSON.parse(text));
    if (snapshot.policyHash !== policyHash || await runtimeIdentity(snapshot) !== receipt.objectHash) {
      throw new Error("File checkpoint integrity check failed.");
    }
    const files = await this.validateFiles(policy, snapshot.files);
    if (await runtimeIdentity(files) !== await runtimeIdentity(snapshot.files)) throw new Error("File checkpoint manifest changed.");
    await this.required(policyHash);
    await this.authorize(policy, "read");
    return { kind: "approved-files" as const, checkpointHash: receipt.objectHash, files,
      outputAcknowledgment: null, unknownTail: true as const, processRestored: false as const };
  }

  async revoke(value: FileCheckpointPolicy): Promise<void> {
    const policy = await this.authorize(value, "revoke");
    await this.retire(await runtimeIdentity(policy));
  }

  /** Alarm cleanup remains possible after authorization expires. Tombstone is never removed. */
  async purgeExpired(): Promise<void> {
    const raw = await this.storage.get(KEY);
    if (raw === undefined) return;
    const record = receiptSchema.parse(raw);
    if (record.expiresAt > this.now()) throw new Error("File checkpoint lease has not expired.");
    await this.retire(record.policyHash);
  }

  private async retire(policyHash: string) {
    const record = await this.storage.transaction(async (tx) => {
      const current = receiptSchema.parse(await tx.get(KEY));
      if (current.policyHash !== policyHash) throw new Error("File checkpoint identity changed.");
      await tx.put(KEY, { ...current, state: "revoked" });
      return current;
    });
    await this.bucket.delete(this.objectKey(record));
  }

  private async validateFiles(policy: FileCheckpointPolicy, exported: readonly ApprovedCheckpointFile[]) {
    if (exported.length !== policy.paths.length) throw new Error("File checkpoint must match every approved path exactly.");
    const paths = new Set<string>();
    let total = 0;
    const files = [];
    for (const file of exported) {
      if (!policy.paths.includes(file.path) || paths.has(file.path)) throw new Error("Unapproved file checkpoint path.");
      paths.add(file.path);
      const bytes = new TextEncoder().encode(file.content);
      total += bytes.byteLength;
      if (bytes.byteLength > MAX_DELIVERABLE_BYTES || total > MAX_TOTAL_DELIVERABLE_BYTES ||
          new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== file.content ||
          /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(file.content) || redactSecrets(file.content) !== file.content ||
          /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(file.content) ||
          /(?:password|passwd|secret|token|api[_ -]?key|authorization|cookie|private[_ -]?key)\s*["']?\s*[:=]/i.test(file.content) ||
          /(?:^|\/)(?:auth|credentials?|secrets?|tokens?|passwords?)(?:\.|\/|$)/i.test(file.path)) {
        throw new Error("File checkpoint content is unsafe or exceeds its bound.");
      }
      files.push({ path: file.path, content: file.content, bytes: bytes.byteLength, sha256: await contentDigest(file.content) });
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }
}
