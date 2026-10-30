/** Pure authorization and event contracts for explicitly shared task rooms. */
export const COLLABORATION_ROLES = ["owner", "member", "agent"] as const;
export type CollaborationRole = (typeof COLLABORATION_ROLES)[number];
export const COLLABORATION_CAPABILITIES = ["room.read", "message.send", "handoff.create", "task.cancel", "approval.decide", "membership.manage"] as const;
export type CollaborationCapability = (typeof COLLABORATION_CAPABILITIES)[number];
export type CollaborationActorKind = "human" | "agent";
export type CollaborationVisibility = "private" | "shared";
export type MembershipStatus = "active" | "removed";

export interface CollaborationActor { kind: CollaborationActorKind; actorId: string; tenantId: string; workspaceId: string; userId: string }
export interface CollaborationRoom { roomId: string; tenantId: string; workspaceId: string; visibility: CollaborationVisibility }
export interface CollaborationMembership {
  roomId: string; tenantId: string; workspaceId: string; userId: string; actorId: string;
  actorKind: CollaborationActorKind; role: CollaborationRole; status: MembershipStatus;
  capabilities: readonly CollaborationCapability[];
}
export interface CollaborationAuthorizationContext { tenantId: string; workspaceId: string; userId: string; actor: CollaborationActor }
export type CollaborationAction = CollaborationCapability;
export type AuthorizationDenial = "invalid-context" | "scope-mismatch" | "not-a-member" | "membership-removed" | "actor-mismatch" | "capability-missing" | "agent-cannot-approve";
export type AuthorizationResult = { allowed: true; reason: "authorized" } | { allowed: false; reason: AuthorizationDenial };

const cap = (value: unknown): value is CollaborationCapability => (COLLABORATION_CAPABILITIES as readonly unknown[]).includes(value);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const invalid = (reason: AuthorizationDenial): AuthorizationResult => ({ allowed: false, reason });

/** Shared visibility never grants access by itself; all actions require membership. */
export function authorizeCollaborationAction(
  context: CollaborationAuthorizationContext, room: CollaborationRoom,
  membership: CollaborationMembership | undefined, action: CollaborationAction,
): AuthorizationResult {
  if (!context || !room || !context.actor || !nonEmpty(context.tenantId) || !nonEmpty(context.workspaceId) || !nonEmpty(context.userId) ||
      !nonEmpty(context.actor.actorId) || !nonEmpty(context.actor.userId) ||
      (context.actor.kind !== "human" && context.actor.kind !== "agent") || !cap(action)) return invalid("invalid-context");
  if (context.tenantId !== room.tenantId || context.workspaceId !== room.workspaceId ||
      context.actor.tenantId !== context.tenantId || context.actor.workspaceId !== context.workspaceId || context.actor.userId !== context.userId) return invalid("scope-mismatch");
  if (!membership) return invalid("not-a-member");
  if (membership.status !== "active") return invalid("membership-removed");
  if (!Array.isArray(membership.capabilities) || !membership.capabilities.every(cap) ||
      (membership.role !== "owner" && membership.role !== "member" && membership.role !== "agent") ||
      membership.roomId !== room.roomId || membership.tenantId !== room.tenantId || membership.workspaceId !== room.workspaceId ||
      membership.userId !== context.userId || membership.actorId !== context.actor.actorId || membership.actorKind !== context.actor.kind ||
      (membership.actorKind === "agent") !== (membership.role === "agent")) return invalid("actor-mismatch");
  if (action === "approval.decide" && context.actor.kind !== "human") return invalid("agent-cannot-approve");
  if (!membership.capabilities.includes(action)) return invalid("capability-missing");
  return { allowed: true, reason: "authorized" };
}

export interface CollaborationMessageEnvelope {
  kind: "message"; messageId: string; tenantId: string; workspaceId: string; roomId: string;
  sender: CollaborationActor; body: string; createdAt: number; profileVersion?: number;
}
export interface HandoffLineage { rootHandoffId: string; parentHandoffId: string | null; depth: number; ancestorHandoffIds: readonly string[] }
export interface CollaborationHandoffEnvelope {
  kind: "handoff"; handoffId: string; tenantId: string; workspaceId: string; roomId: string; taskId: string;
  sender: CollaborationActor; recipient: CollaborationActor; createdAt: number; lineage: HandoffLineage;
  remainingBudget: number; grantedCapabilities: readonly CollaborationCapability[]; profileVersion?: number;
}
export type CollaborationEnvelope = CollaborationMessageEnvelope | CollaborationHandoffEnvelope;
export const MAX_HANDOFF_DEPTH = 4;
export const MAX_HANDOFF_BUDGET = 32;
export type EnvelopeValidationError = "invalid-envelope" | "invalid-scope" | "invalid-identity" | "invalid-time" | "invalid-profile-version" | "invalid-lineage" | "depth-exceeded" | "budget-exceeded" | "duplicate-handoff-id" | "parent-mismatch" | "authority-widened" | "invalid-budget-propagation" | "profile-version-mismatch";
export type ValidationResult = { valid: true } | { valid: false; reason: EnvelopeValidationError };
const bad = (reason: EnvelopeValidationError): ValidationResult => ({ valid: false, reason });
const record = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return (proto === Object.prototype || proto === null) && Object.keys(v).every((k) => Object.hasOwn(v, k));
};
const actor = (v: unknown): v is CollaborationActor => record(v) && (v.kind === "human" || v.kind === "agent") && nonEmpty(v.actorId) && nonEmpty(v.tenantId) && nonEmpty(v.workspaceId) && nonEmpty(v.userId);
const integer = (v: unknown): v is number => Number.isSafeInteger(v);
const scopeMatches = (v: Record<string, unknown>, expected: {tenantId:string;workspaceId:string;roomId:string}) => v.tenantId === expected.tenantId && v.workspaceId === expected.workspaceId && v.roomId === expected.roomId;

export function validateCollaborationMessage(value: unknown, expected: Pick<CollaborationRoom, "tenantId"|"workspaceId"|"roomId">): ValidationResult {
  if (!record(value) || value.kind !== "message") return bad("invalid-envelope");
  if (!scopeMatches(value, expected)) return bad("invalid-scope");
  if (!nonEmpty(value.messageId) || !actor(value.sender) || !nonEmpty(value.body)) return bad("invalid-identity");
  if (!Number.isFinite(value.createdAt) || (value.createdAt as number) < 0) return bad("invalid-time");
  if ((value.sender.kind === "agent" && (!integer(value.profileVersion) || (value.profileVersion as number) < 1)) || (value.sender.kind === "human" && value.profileVersion !== undefined)) return bad("invalid-profile-version");
  if (value.sender.tenantId !== expected.tenantId || value.sender.workspaceId !== expected.workspaceId) return bad("invalid-scope");
  return { valid: true };
}

export interface HandoffValidationOptions {
  expected: Pick<CollaborationRoom, "tenantId"|"workspaceId"|"roomId">;
  senderCapabilities: readonly CollaborationCapability[];
  seenHandoffIds?: ReadonlySet<string>;
  parent?: CollaborationHandoffEnvelope;
}
const subset = (a: readonly CollaborationCapability[], b: readonly CollaborationCapability[]) => a.every((item) => b.includes(item));
const sameArray = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const sameActor = (a: CollaborationActor, b: CollaborationActor) => a.kind === b.kind && a.actorId === b.actorId && a.userId === b.userId && a.tenantId === b.tenantId && a.workspaceId === b.workspaceId;

/** Snapshot validation only; callers must atomically reserve aggregate budget and replay IDs. */
export function validateCollaborationHandoff(value: unknown, options: HandoffValidationOptions): ValidationResult {
  if (!record(value) || value.kind !== "handoff") return bad("invalid-envelope");
  if (!scopeMatches(value, options.expected)) return bad("invalid-scope");
  if (!nonEmpty(value.handoffId) || !nonEmpty(value.taskId) || !actor(value.sender) || !actor(value.recipient) || !Array.isArray(value.grantedCapabilities) || !value.grantedCapabilities.every(cap)) return bad("invalid-identity");
  if (value.sender.tenantId !== options.expected.tenantId || value.sender.workspaceId !== options.expected.workspaceId || value.recipient.tenantId !== options.expected.tenantId || value.recipient.workspaceId !== options.expected.workspaceId) return bad("invalid-scope");
  if (!Number.isFinite(value.createdAt) || (value.createdAt as number) < 0) return bad("invalid-time");
  if (value.profileVersion !== undefined && (!integer(value.profileVersion) || (value.profileVersion as number) < 1)) return bad("invalid-profile-version");
  if (value.recipient.kind === "agent" && (!integer(value.profileVersion) || (value.profileVersion as number) < 1)) return bad("invalid-profile-version");
  const l = value.lineage;
  if (!record(l) || !nonEmpty(l.rootHandoffId) || !(l.parentHandoffId === null || nonEmpty(l.parentHandoffId)) || !integer(l.depth) || (l.depth as number) < 0 || !Array.isArray(l.ancestorHandoffIds) || !l.ancestorHandoffIds.every(nonEmpty) || new Set(l.ancestorHandoffIds).size !== l.ancestorHandoffIds.length || l.ancestorHandoffIds.includes(value.handoffId) || l.ancestorHandoffIds.length !== l.depth) return bad("invalid-lineage");
  if ((l.depth as number) > MAX_HANDOFF_DEPTH) return bad("depth-exceeded");
  if (!integer(value.remainingBudget) || (value.remainingBudget as number) < 0 || (value.remainingBudget as number) > MAX_HANDOFF_BUDGET) return bad("budget-exceeded");
  if (options.seenHandoffIds?.has(value.handoffId)) return bad("duplicate-handoff-id");
  if (!subset(value.grantedCapabilities, options.senderCapabilities)) return bad("authority-widened");
  if (l.depth === 0) {
    if (l.parentHandoffId !== null || l.rootHandoffId !== value.handoffId || l.ancestorHandoffIds.length !== 0 || options.parent) return bad("invalid-lineage");
    return { valid: true };
  }
  const p = options.parent;
  if (!p) return bad("parent-mismatch");
  if (!integer(p.remainingBudget) || p.remainingBudget < 0 || p.remainingBudget > MAX_HANDOFF_BUDGET) return bad("budget-exceeded");
  if (p.tenantId !== value.tenantId || p.workspaceId !== value.workspaceId || p.roomId !== value.roomId || p.taskId !== value.taskId ||
      !sameActor(value.sender, p.recipient) || l.parentHandoffId !== p.handoffId || l.rootHandoffId !== p.lineage.rootHandoffId || l.depth !== p.lineage.depth + 1 || !sameArray(l.ancestorHandoffIds, [...p.lineage.ancestorHandoffIds, p.handoffId])) return bad("parent-mismatch");
  if ((value.remainingBudget as number) >= p.remainingBudget) return bad("invalid-budget-propagation");
  if (!subset(value.grantedCapabilities, p.grantedCapabilities)) return bad("authority-widened");
  if (p.profileVersion !== value.profileVersion) return bad("profile-version-mismatch");
  return { valid: true };
}

export function childHandoffLineage(parent: CollaborationHandoffEnvelope): HandoffLineage | null {
  if (!integer(parent.lineage.depth) || parent.lineage.depth >= MAX_HANDOFF_DEPTH || !Array.isArray(parent.lineage.ancestorHandoffIds)) return null;
  return { rootHandoffId: parent.lineage.rootHandoffId, parentHandoffId: parent.handoffId, depth: parent.lineage.depth + 1, ancestorHandoffIds: [...parent.lineage.ancestorHandoffIds, parent.handoffId] };
}
export interface HandoffCancellationContract { tenantId: string; workspaceId: string; roomId: string; taskId: string; targetHandoffId: string; rootHandoffId: string; ancestorHandoffIds: readonly string[] }
export function validateHandoffCancellation(c: HandoffCancellationContract, target: CollaborationHandoffEnvelope): ValidationResult {
  if (c.tenantId !== target.tenantId || c.workspaceId !== target.workspaceId || c.roomId !== target.roomId || c.taskId !== target.taskId) return bad("invalid-scope");
  if (c.targetHandoffId !== target.handoffId || c.rootHandoffId !== target.lineage.rootHandoffId || !sameArray(c.ancestorHandoffIds, target.lineage.ancestorHandoffIds)) return bad("invalid-lineage");
  return { valid: true };
}
export function isAuthoritySubset(requested: readonly CollaborationCapability[], granted: readonly CollaborationCapability[]): boolean { return subset(requested, granted); }
