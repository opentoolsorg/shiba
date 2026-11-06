import { isTeamWorkspaceId } from "@shiba/shared";
import type { CollaborationHandoffRow, CollaborationScope } from "./collaboration-store.js";
import { buildSessionAgentName, DEFAULT_SESSION_ID, parseSessionAgentName } from "./web-sessions.js";

type ExecutorScope = Pick<CollaborationScope, "tenantId" | "workspaceId" | "userId">;
type ExecutorHandoff = Pick<CollaborationHandoffRow, "tenantId" | "workspaceId" | "senderUserId" | "executorAgentName">;
export interface CollaborationExecutorIdentity { agentName: string; ownerId: string; sessionId: string }

function owner(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 320 && value === value.trim() &&
    !Array.from(value).some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127) && !/[:/\\]/.test(value) && !/^(?:default|system|automation|agent|mcp|child|subagent)$/i.test(value);
}
function canonical(value: string): string { return value.toLowerCase(); }
function validScope(tenantId: string, workspaceId: string): boolean {
  return tenantId === "self-hosted" && (workspaceId === "default" || isTeamWorkspaceId(workspaceId));
}
function teamOwner(value: string): boolean { return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }

/**
 * Mint an isolated server-only execution address. The caller must CAS-pin it
 * before touching its DO and MUST NOT register it as a private web session.
 * An address is a storage selector, never proof of membership or approval.
 */
export function mintCollaborationExecutor(scope: ExecutorScope, rawOwner: string): string {
  if (!validScope(scope.tenantId, scope.workspaceId) || !owner(rawOwner) || !owner(scope.userId) ||
    canonical(rawOwner) !== canonical(scope.userId) || (isTeamWorkspaceId(scope.workspaceId) && !teamOwner(rawOwner))) {
    throw new Error("Invalid collaboration executor scope or owner.");
  }
  return scope.workspaceId === "default" ? rawOwner : buildSessionAgentName(rawOwner, crypto.randomUUID());
}

/** Validate the persisted pin without guessing, registry lookup or base-owner fallback. */
export function collaborationExecutorIdentity(handoff: ExecutorHandoff): CollaborationExecutorIdentity | null {
  if (!validScope(handoff.tenantId, handoff.workspaceId) || !owner(handoff.senderUserId) ||
    typeof handoff.executorAgentName !== "string") return null;
  const agentName = handoff.executorAgentName;
  if (handoff.workspaceId === "default") {
    return owner(agentName) && canonical(agentName) === canonical(handoff.senderUserId)
      ? { agentName, ownerId: agentName, sessionId: DEFAULT_SESSION_ID } : null;
  }
  const parsed = parseSessionAgentName(agentName);
  if (!parsed || !owner(parsed.userId) || !teamOwner(parsed.userId) || canonical(parsed.userId) !== canonical(handoff.senderUserId) ||
    // Require the canonical round-trip so alternate path/segment spellings do
    // not become aliases for an unrelated owner or lane.
    buildSessionAgentName(parsed.userId, parsed.sessionId) !== agentName) return null;
  return { agentName, ownerId: parsed.userId, sessionId: parsed.sessionId };
}
