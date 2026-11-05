import { TEAM_MODEL_TEXT_MODEL, type TeamModelFunding, type TeamModelStateResponse, type TeamModelTurn } from "@shiba/shared";
export const TEAM_MODEL_WORKSPACE = `ws_${"a".repeat(24)}`;
export const TEAM_MODEL_ROOM = `room_${"b".repeat(24)}`;
export const TEAM_MODEL_ACTOR = "member@example.test";
export const TEAM_MODEL_OPERATOR = "operator@example.test";
/** Deterministic local fixtures only. These IDs grant no real account access. */
export function teamModelFixture(now = Date.now()): { grant: TeamModelFunding; turn: TeamModelTurn; state: TeamModelStateResponse } {
  const grant: TeamModelFunding = { id: `tmf_${"c".repeat(32)}`, version: 2, digest: "d".repeat(64), state: "active", contract: {
    roomId: TEAM_MODEL_ROOM, issuerId: TEAM_MODEL_OPERATOR, memberId: TEAM_MODEL_ACTOR, memberVersion: 3, employeeId: "employee-writer", employeeVersion: 4,
    employeeName: "Writer fixture", employeeInstructions: "Draft plain text only. No tools.", model: TEAM_MODEL_TEXT_MODEL, maxRequests: 3, maxInputBytes: 8192, maxOutputTokens: 256, expiresAt: now + 60 * 60_000,
    billing: "deployment-workers-ai", audience: "requesting-member", tools: [], credentialRef: null,
  }, reviewExpiresAt: now + 60_000, usedRequests: 0, reservedInputBytes: 0, reservedOutputTokens: 0, canActivate: false, canRevoke: false, unavailableReason: null };
  const turn: TeamModelTurn = { id: `tmt_${"e".repeat(32)}`, grantId: grant.id, version: 1, roomId: TEAM_MODEL_ROOM, requesterId: TEAM_MODEL_ACTOR,
    employeeId: grant.contract.employeeId, model: TEAM_MODEL_TEXT_MODEL, requestedPrompt: "Write a short fixture summary.", messages: [{ role: "system", content: grant.contract.employeeInstructions }, { role: "user", content: "Write a short fixture summary." }], sources: [],
    inputHash: "f".repeat(64), inputBytes: 160, maxOutputTokens: 256, expiresAt: now + 60_000, status: "pending", output: null, error: null, canApprove: true, canExecute: false, canCancel: true };
  const state: TeamModelStateResponse = { ok: true, workspaceId: TEAM_MODEL_WORKSPACE, roomId: TEAM_MODEL_ROOM, actorId: TEAM_MODEL_ACTOR, enabled: true, model: TEAM_MODEL_TEXT_MODEL, policyDigest: "a".repeat(64), canFund: false, unavailableReason: null,
    actors: [{ userId: TEAM_MODEL_ACTOR, version: 3 }], employees: [{ id: "employee-writer", name: "Writer fixture", version: 4 }], grants: [grant], turns: [] };
  return { grant, turn, state };
}
