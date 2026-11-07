import { z } from "zod";
import { operatorEnrollmentReviewSchema, type OperatorEnrollmentDecision, type OperatorEnrollmentReview } from "@shiba/shared";
import type { Env } from "./env.js";
import { openConnectorConnectionName } from "./integrations/openconnector-provider.js";

/** This store cannot admit actions, grant employees access, or activate an account. */
export class OperatorEnrollmentError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}
export interface OperatorEnrollmentOwner { ownerId: string; accountId: string; sessionId: string; sessionExpiresAt: number }
interface Row {
  id: string; generation: string; owner_id: string; owner_account_id: string; operator_id: string;
  proposal_json: string; proposal_digest: string; state: OperatorEnrollmentReview["state"]; version: number;
  expires_at: number; created_at: number; decision_account_id: string | null; decided_at: number | null; revoked_at: number | null;
}
const SQL_NOW = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
function ownerFence(owner: OperatorEnrollmentOwner) {
  return { sql: `EXISTS(SELECT 1 FROM shiba_auth_account_policy p JOIN "user" u ON u.id=p.account_id
    JOIN "session" s ON s.userId=u.id WHERE p.account_id=? AND p.email=? AND p.kind='bootstrap'
    AND lower(trim(u.email))=? AND u.emailVerified=1 AND s.id=?
    AND CASE WHEN typeof(s.expiresAt) IN ('integer','real') THEN s.expiresAt
      ELSE CAST((julianday(s.expiresAt)-2440587.5)*86400000 AS INTEGER) END>${SQL_NOW}
    AND ?>${SQL_NOW})`, values: [owner.accountId, owner.ownerId, owner.ownerId, owner.sessionId, owner.sessionExpiresAt] };
}
const proposalSchema = operatorEnrollmentReviewSchema.omit({
  enrollmentId: true, enrollmentGeneration: true, proposalDigest: true, personalAlias: true,
  state: true, version: true, createdAt: true, decidedAt: true, revokedAt: true, executionAvailable: true,
});
async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function dto(row: Row): OperatorEnrollmentReview {
  return operatorEnrollmentReviewSchema.parse({ ...JSON.parse(row.proposal_json),
    proposalDigest: row.proposal_digest, state: row.state, version: row.version,
    decidedAt: row.decided_at, revokedAt: row.revoked_at, executionAvailable: false });
}

/** Internal ingestion seam only: caller must authenticate operator and attest exact sibling metadata.
 * No HTTP route calls this until the coordinated sibling metadata protocol is integrated.
 * The payload is non-secret; unknown fields (including credential fields) are rejected.
 */
export async function proposeOperatorEnrollment(env: Env, target: { ownerId: string; accountId: string }, operatorId: string, metadata: unknown): Promise<OperatorEnrollmentReview> {
  if (env.OPEN_CONNECTOR_OPERATOR_REVIEW_ENABLED !== "true") throw new OperatorEnrollmentError("operator_review_disabled", 503);
  const parsed = proposalSchema.safeParse(metadata);
  if (!parsed.success || !operatorId || operatorId.length > 160 || !z.string().email().safeParse(target.ownerId).success || !target.accountId || target.accountId.length > 160)
    throw new OperatorEnrollmentError("operator_proposal_invalid", 400);
  const createdAt = Date.now(), input = parsed.data;
  if (input.expiresAt <= createdAt || input.expiresAt > createdAt + 30 * 86400_000)
    throw new OperatorEnrollmentError("operator_proposal_expiry_invalid", 400);
  const operations = [...input.operations].sort((a, b) => a.actionId < b.actionId ? -1 : a.actionId > b.actionId ? 1 : 0);
  if (new Set(operations.map((operation) => operation.actionId)).size !== operations.length)
    throw new OperatorEnrollmentError("operator_proposal_actions_invalid", 400);
  const proposal = { ...input, operations, enrollmentId: `oe_${crypto.randomUUID().replaceAll("-", "")}`,
    enrollmentGeneration: crypto.randomUUID(), personalAlias: await openConnectorConnectionName(target.ownerId), createdAt };
  // Domain separated and complete: labels, exact operation hashes and identities cannot be repointed.
  const proposalDigest = await digest(["shiba.operator-enrollment-review.v1", target.ownerId, target.accountId, operatorId, proposal]);
  const result = await env.AGENT_AUDIT.prepare(`INSERT INTO operator_enrollment_reviews
    (id,generation,owner_id,owner_account_id,operator_id,proposal_json,proposal_digest,expires_at,created_at,state,version)
    SELECT ?,?,?,?,?,?,?,?,?,'proposed',1 WHERE ?>${SQL_NOW}
    AND EXISTS(SELECT 1 FROM shiba_auth_account_policy p JOIN "user" u ON u.id=p.account_id
      WHERE p.account_id=? AND p.email=? AND p.kind='bootstrap' AND lower(trim(u.email))=? AND u.emailVerified=1)`)
    .bind(proposal.enrollmentId, proposal.enrollmentGeneration, target.ownerId, target.accountId, operatorId,
      JSON.stringify(proposal), proposalDigest, input.expiresAt, createdAt, input.expiresAt,
      target.accountId, target.ownerId, target.ownerId).run();
  if (result.meta.changes !== 1) throw new OperatorEnrollmentError("operator_owner_unavailable", 403);
  return operatorEnrollmentReviewSchema.parse({ ...proposal, proposalDigest, state: "proposed", version: 1, decidedAt: null, revokedAt: null, executionAvailable: false });
}

export async function listOperatorEnrollments(env: Env, owner: OperatorEnrollmentOwner): Promise<OperatorEnrollmentReview[]> {
  const guard = ownerFence(owner);
  const rows = await env.AGENT_AUDIT.prepare(`SELECT * FROM operator_enrollment_reviews WHERE owner_id=? AND owner_account_id=?
    AND ${guard.sql} ORDER BY created_at DESC,id LIMIT 100`).bind(owner.ownerId, owner.accountId, ...guard.values).all<Row>();
  return rows.results.map(dto);
}

export async function decideOperatorEnrollment(env: Env, owner: OperatorEnrollmentOwner, id: string, input: OperatorEnrollmentDecision): Promise<void> {
  if (env.OPEN_CONNECTOR_OPERATOR_REVIEW_ENABLED !== "true" && input.decision !== "revoke") throw new OperatorEnrollmentError("operator_review_disabled", 503);
  if (input.expectedOwnerAccountId !== owner.accountId) throw new OperatorEnrollmentError("operator_owner_changed", 403);
  const guard = ownerFence(owner), revoke = input.decision === "revoke";
  const result = await env.AGENT_AUDIT.prepare(`UPDATE operator_enrollment_reviews
    SET state=?,version=version+1,decision_account_id=?,decided_at=COALESCE(decided_at,${SQL_NOW}),
      revoked_at=${revoke ? SQL_NOW : "NULL"}
    WHERE id=? AND owner_id=? AND owner_account_id=? AND version=? AND proposal_digest=?
      AND state IN (${revoke ? "'proposed','accepted'" : "'proposed'"})
      ${input.decision === "accept" ? `AND expires_at>${SQL_NOW}` : ""} AND ${guard.sql}`)
    .bind(revoke ? "revoked" : input.decision === "accept" ? "accepted" : "rejected", owner.accountId,
      id, owner.ownerId, owner.accountId, input.expectedVersion, input.proposalDigest, ...guard.values).run();
  if (result.meta.changes !== 1) throw new OperatorEnrollmentError("operator_proposal_changed_or_unavailable");
}
