import { stableHash } from "@shiba/shared";
import type { Env } from "./env.js";
import type { CodingTaskInput } from "./opencode-input.js";
import { preparedRuntimeExecutionSchema, type PreparedRuntimeExecution } from "./runtime-recovery.js";
import { assertChildDispatchAuthorized } from "./child-dispatch.js";
import { isAuthorizedSessionAgent, parseSessionAgentName } from "./web-sessions.js";
import { reserveRunOutputArchive, type ArchiveReservation } from "./run-output-archive-reservations.js";
import { sealArchiveAuthorization, type ArchiveAuthorization } from "./run-output-archive.js";

export async function prepareRunOutputArchive(env: Env, input: CodingTaskInput, capsule: PreparedRuntimeExecution): Promise<ArchiveAuthorization> {
  await assertChildDispatchAuthorized(env, input);
  preparedRuntimeExecutionSchema.parse(capsule);
  const room = input.runRoom, policy = input.outputArchive;
  const session = input.accessAgent ? parseSessionAgentName(input.accessAgent) : null;
  if (!room || !policy || !input.initiatorUserId || room.ownerId !== input.initiatorUserId || !input.accessAgent ||
    input.accessAgent !== input.initiatorUserId && !session ||
    !isAuthorizedSessionAgent(input.accessAgent, input.initiatorUserId) || room.sessionId !== (session?.sessionId ?? "default") ||
    capsule.issuedAt !== input.dispatchIssuedAt || capsule.recoveryDeadline !== input.dispatchExpiresAt || capsule.deadline > capsule.recoveryDeadline ||
    capsule.preparedAt < capsule.issuedAt || capsule.preparedAt > Date.now() || capsule.deadline > capsule.preparedAt + 15 * 60_000 ||
    input.personalExecution || input.customAgentId || input.skillPins?.length || input.draftTaskId || input.onboardingSourceSnapshot ||
    input.runtime !== "sandbox" || input.sandboxProvider !== "cloudflare" || capsule.provider !== "cloudflare" ||
    room.runId !== `agent-tool:${capsule.approvalId}` || capsule.sandboxId !== input.sandboxId || capsule.inputHash !== input.dispatchInputHash ||
    capsule.envelopeHash !== input.dispatchEnvelopeHash || capsule.approvalId !== input.dispatchApprovalId) throw new Error("This run has no exact private output archive authority.");
  const fields = { ownerId: room.ownerId, ownerAccountId: policy.ownerAccountId, sessionId: room.sessionId, runId: room.runId,
    sandboxId: input.sandboxId, approvalId: capsule.approvalId, inputHash: capsule.inputHash, envelopeHash: capsule.envelopeHash,
    jobId: capsule.jobId, commandIdentity: capsule.commandIdentity, policy: { ...policy }, issuedAt: capsule.issuedAt, writeDeadline: capsule.deadline };
  const reservation: ArchiveReservation = { id: stableHash(["shiba.output-archive-reservation.v1", fields.ownerAccountId, fields.jobId, fields.inputHash]), ...fields };
  await reserveRunOutputArchive(env, reservation);
  return sealArchiveAuthorization(env, reservation);
}
