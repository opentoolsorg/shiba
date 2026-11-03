import { z } from "zod";
import { RUN_DEADLINE_MS } from "@shiba/shared";
import { childDispatchEnvelopeHash } from "./child-dispatch.js";
import type { CodingTaskInput } from "./opencode-input.js";

const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

/** Worker-only prepared state. No command, task, environment or credential values. */
export const preparedRuntimeExecutionSchema = z.object({
  version: z.literal(1),
  phase: z.literal("harness"),
  provider: z.literal("cloudflare"),
  sandboxId: z.string().min(1).max(512),
  harness: z.string().min(1).max(64),
  workdir: z.string().min(1).max(1024),
  approvalId: z.string().min(1).max(512),
  inputHash: digest,
  envelopeHash: digest,
  commandIdentity: digest,
  jobId: digest,
  issuedAt: z.number().int().nonnegative(),
  preparedAt: z.number().int().nonnegative(),
  deadline: z.number().int().positive(),
  recoveryDeadline: z.number().int().positive(),
  baseRevision: oid.nullable(),
  baselineCommit: oid,
  setupCommit: oid.nullable(),
}).strict();

export type PreparedRuntimeExecution = z.infer<typeof preparedRuntimeExecutionSchema>;

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, sorted(entry)]));
  }
  return value;
}

export async function runtimeIdentity(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(sorted(value))));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Signature verification remains the caller's responsibility before acquiring sandbox ops. */
export async function approvedRuntimeIdentity(input: CodingTaskInput): Promise<{
  approvalId: string; inputHash: string; envelopeHash: string; issuedAt: number; recoveryDeadline: number;
}> {
  const { dispatchApprovalId, dispatchInputHash, dispatchEnvelopeHash, dispatchIssuedAt, dispatchExpiresAt } = input;
  if (!dispatchApprovalId || !dispatchInputHash || !dispatchEnvelopeHash || !input.dispatchSig ||
      !Number.isSafeInteger(dispatchIssuedAt) || !Number.isSafeInteger(dispatchExpiresAt) ||
      dispatchIssuedAt! > Date.now() || dispatchExpiresAt! <= Date.now() ||
      dispatchExpiresAt! - dispatchIssuedAt! > RUN_DEADLINE_MS ||
      dispatchEnvelopeHash !== await childDispatchEnvelopeHash(input)) {
    throw new Error("Prepared execution does not have an unchanged approved dispatch identity.");
  }
  return { approvalId: dispatchApprovalId, inputHash: dispatchInputHash, envelopeHash: dispatchEnvelopeHash,
    issuedAt: dispatchIssuedAt!, recoveryDeadline: dispatchExpiresAt! };
}

export async function assertPreparedRuntimeExecution(
  value: unknown,
  input: CodingTaskInput,
  expected: { harness: string; workdir: string; commandIdentity: string; jobId: string },
): Promise<PreparedRuntimeExecution> {
  const record = preparedRuntimeExecutionSchema.parse(value);
  const approved = await approvedRuntimeIdentity(input);
  const expectedBase = input.executionTarget?.kind === "artifact-workspace" ? record.baseRevision === null : record.baseRevision !== null;
  if (record.sandboxId !== input.sandboxId || record.harness !== expected.harness || record.workdir !== expected.workdir ||
      record.commandIdentity !== expected.commandIdentity || record.jobId !== expected.jobId ||
      record.approvalId !== approved.approvalId || record.inputHash !== approved.inputHash ||
      record.envelopeHash !== approved.envelopeHash || record.issuedAt !== approved.issuedAt ||
      record.recoveryDeadline !== approved.recoveryDeadline || record.preparedAt < record.issuedAt ||
      record.preparedAt > Date.now() || record.deadline <= record.preparedAt ||
      record.deadline > record.preparedAt + 15 * 60_000 || record.deadline > record.recoveryDeadline ||
      record.recoveryDeadline - record.issuedAt > RUN_DEADLINE_MS || !expectedBase) {
    throw new Error("Prepared execution identity or original deadline changed. Recovery refused.");
  }
  return record;
}
