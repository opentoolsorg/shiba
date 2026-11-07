import { canonical, digest, operatorExact, operatorRecord, UPSTREAM_REVISION } from "@shiba/openconnector-read-gateway";

/** Real execution acceptance, deliberately incompatible with reviewOnly UI records. */
export interface OperatorExecutionEnrollment {
  format: "shiba.operator-execution-enrollment.v1";
  enrollmentId: string; enrollmentGeneration: number; recordVersion: number;
  ownerId: string; personalAlias: string; provider: string; rawConnectionId: string; upstreamRevision: string;
  deploymentEpoch: string; versionId: string; upstreamSourceRevision: string; manifestDigest: string;
  operations: Array<{ actionId: string; inputSchemaHash: string; executorHash: string }>;
  expiresAt: number;
  proposal: { proposalId: string; operatorId: string; proposedAt: number };
  acceptance: { acceptanceId: string; ownerId: string; acceptedAt: number; purpose: "operator_execution" };
  lifecycle: "active";
  revocationTombstone: null;
}
const id = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_.:@/-]{1,200}$/.test(value);
const positive = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const hex = (value: unknown) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const invalid = () => new Error("operator_execution_enrollment_invalid");

/** No key material or secret-derived fingerprint is accepted in this strict tuple. */
export async function operatorEnrollmentConnectionId(value: OperatorExecutionEnrollment): Promise<string> {
  const input = structuredClone(value), row = operatorRecord(input);
  operatorExact(row, ["format", "enrollmentId", "enrollmentGeneration", "recordVersion", "ownerId", "personalAlias", "provider",
    "rawConnectionId", "upstreamRevision", "deploymentEpoch", "versionId", "upstreamSourceRevision", "manifestDigest",
    "operations", "expiresAt", "proposal", "acceptance", "lifecycle", "revocationTombstone"]);
  const proposal = operatorRecord(input.proposal), acceptance = operatorRecord(input.acceptance);
  operatorExact(proposal, ["proposalId", "operatorId", "proposedAt"]);
  operatorExact(acceptance, ["acceptanceId", "ownerId", "acceptedAt", "purpose"]);
  if (input.format !== "shiba.operator-execution-enrollment.v1" || input.lifecycle !== "active" || input.revocationTombstone !== null
    || ![input.enrollmentId, input.ownerId, input.provider, input.rawConnectionId, input.upstreamRevision, input.deploymentEpoch,
      input.proposal.proposalId, input.proposal.operatorId, input.acceptance.acceptanceId].every(id)
    || ![input.enrollmentGeneration, input.recordVersion, input.expiresAt, input.proposal.proposedAt, input.acceptance.acceptedAt].every(positive)
    || !/^[0-9a-f-]{36}$/.test(input.versionId) || !hex(input.manifestDigest)
    || input.upstreamSourceRevision !== UPSTREAM_REVISION || input.acceptance.ownerId !== input.ownerId
    || input.acceptance.purpose !== "operator_execution" || input.proposal.proposedAt > input.acceptance.acceptedAt
    || input.acceptance.acceptedAt >= input.expiresAt
    || !Array.isArray(input.operations) || !input.operations.length || input.operations.length > 20) throw invalid();
  for (const [index, operation] of input.operations.entries()) {
    operatorExact(operatorRecord(operation), ["actionId", "inputSchemaHash", "executorHash"]);
    if (!id(operation.actionId) || !hex(operation.inputSchemaHash) || !hex(operation.executorHash)
      || (index > 0 && (input.operations[index - 1]?.actionId ?? "") >= operation.actionId)) throw invalid();
  }
  if (input.personalAlias !== `u_${(await digest(input.ownerId)).slice(0, 16)}`) throw invalid();
  return `oco_${await digest(JSON.stringify(canonical(["shiba.operator-execution-enrollment.connection.v1", input])))}`;
}
