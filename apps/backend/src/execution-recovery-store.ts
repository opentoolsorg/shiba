import { z } from "zod";
import type { CodingTaskInput } from "./opencode-input.js";
import { preparedRuntimeExecutionSchema, type PreparedRuntimeExecution } from "./runtime-recovery.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const recoveryRecordSchema = z.object({
  version: z.literal(1),
  envelopeHash: digest,
  approvalId: z.string().min(1).max(512),
  expiresAt: z.number().int().positive(),
  phase: z.enum(["preparing", "harness", "settling", "complete", "failed"]),
  capsule: preparedRuntimeExecutionSchema.optional(),
  finalReceipt: z.object({ chunks: z.number().int().min(1).max(128), chars: z.number().int().min(1).max(4 * 1024 * 1024), sha256: digest }).strict().optional(),
}).strict();

type StoredExecutionRecovery = z.infer<typeof recoveryRecordSchema>;
export type ExecutionRecoveryRecord = StoredExecutionRecovery & { finalText?: string };
export interface ExecutionRecoveryStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}
const KEY = "shiba:execution-recovery:v1";
const CHUNK_CHARS = 32_768;
async function hash(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Private Worker storage only. Raw output, commands and environment values stay out. */
export class ExecutionRecoveryStore {
  constructor(private readonly storage: ExecutionRecoveryStorage) {}

  async read(input: CodingTaskInput): Promise<ExecutionRecoveryRecord | undefined> {
    const value = await this.storage.get<unknown>(KEY);
    if (value === undefined) return undefined;
    const parsed = recoveryRecordSchema.safeParse(value);
    if (!parsed.success || parsed.data.envelopeHash !== input.dispatchEnvelopeHash ||
        parsed.data.approvalId !== input.dispatchApprovalId || parsed.data.expiresAt !== input.dispatchExpiresAt) {
      throw new Error("Execution recovery identity changed. Execution outcome is uncertain.");
    }
    const record = parsed.data;
    if (record.capsule && (record.capsule.envelopeHash !== record.envelopeHash ||
        record.capsule.approvalId !== record.approvalId || record.capsule.recoveryDeadline !== record.expiresAt)) {
      throw new Error("Execution recovery capsule identity changed. Execution outcome is uncertain.");
    }
    if (record.phase === "harness" && !record.capsule || record.phase === "complete" && !record.finalReceipt) {
      throw new Error("Execution recovery state is incomplete. Execution outcome is uncertain.");
    }
    if (record.phase === "complete") {
      const receipt = record.finalReceipt!;
      const chunks: string[] = [];
      for (let index = 0; index < receipt.chunks; index++) {
        const chunk = await this.storage.get<unknown>(`${KEY}:result:${index}`);
        if (typeof chunk !== "string" || chunk.length > CHUNK_CHARS) throw new Error("Execution result cache is incomplete. Execution outcome is uncertain.");
        chunks.push(chunk);
      }
      const finalText = chunks.join("");
      if (finalText.length !== receipt.chars || await hash(finalText) !== receipt.sha256) {
        throw new Error("Execution result cache changed. Execution outcome is uncertain.");
      }
      return { ...record, finalText };
    }
    return record;
  }

  async begin(input: CodingTaskInput): Promise<void> {
    if (await this.read(input)) throw new Error("An execution attempt is already recorded. Refusing to launch another CLI.");
    await this.write({ version: 1, envelopeHash: input.dispatchEnvelopeHash!, approvalId: input.dispatchApprovalId!,
      expiresAt: input.dispatchExpiresAt!, phase: "preparing" });
  }

  async prepared(input: CodingTaskInput, capsule: PreparedRuntimeExecution): Promise<void> {
    const record = await this.required(input);
    if (record.phase !== "preparing" || capsule.envelopeHash !== record.envelopeHash ||
        capsule.approvalId !== record.approvalId || capsule.recoveryDeadline !== record.expiresAt) {
      throw new Error("Execution preparation was already consumed or changed.");
    }
    await this.write({ ...record, capsule, phase: "harness" });
  }

  async settling(input: CodingTaskInput): Promise<void> {
    const record = await this.required(input);
    if (record.phase !== "harness" && record.phase !== "preparing") {
      throw new Error("Execution settlement was already consumed. Execution outcome is uncertain.");
    }
    await this.write({ ...record, phase: "settling" });
  }

  async complete(input: CodingTaskInput, finalText: string): Promise<void> {
    const record = await this.required(input);
    if (record.phase !== "settling" && record.phase !== "preparing") {
      throw new Error("Execution result cannot be committed in this phase.");
    }
    if (!finalText || finalText.length > 4 * 1024 * 1024) throw new Error("Execution result cache exceeds its bounded capacity.");
    const chunks = Math.ceil(finalText.length / CHUNK_CHARS);
    // Chunk values remain below the Durable Object value limit even after UTF-8 encoding.
    // The receipt commits only after every chunk exists, so partial writes never replay.
    for (let index = 0; index < chunks; index++) {
      await this.storage.put(`${KEY}:result:${index}`, finalText.slice(index * CHUNK_CHARS, (index + 1) * CHUNK_CHARS));
    }
    await this.write({ ...record, phase: "complete", finalReceipt: { chunks, chars: finalText.length, sha256: await hash(finalText) } });
  }

  async failed(input: CodingTaskInput): Promise<void> {
    const record = await this.read(input);
    if (record && record.phase !== "complete") await this.write({ ...record, phase: "failed" });
  }

  private async required(input: CodingTaskInput): Promise<ExecutionRecoveryRecord> {
    const record = await this.read(input);
    if (!record) throw new Error("Execution recovery record is missing. Execution outcome is uncertain.");
    return record;
  }

  private async write(record: StoredExecutionRecovery): Promise<void> {
    await this.storage.put(KEY, recoveryRecordSchema.parse(record));
  }
}
