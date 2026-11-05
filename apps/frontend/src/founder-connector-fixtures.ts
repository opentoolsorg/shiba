import type { FounderConnectorOptions, FounderConnectorPlan, FounderConnectorOccurrence, FounderConnectorState } from "@shiba/shared";

export const FOUNDER_WORKSPACE = `ws_${"a".repeat(24)}`;
export const FOUNDER_LIBRARY = "founder-stripe-revenue-pulse";
export const FOUNDER_BASE = `/api/founder-skills/${FOUNDER_LIBRARY}/connector-job`;
export const FOUNDER_ACTOR = "owner@example.test";
export const founderOptions = (): FounderConnectorOptions => ({ ok: true, workspaceId: FOUNDER_WORKSPACE, libraryId: FOUNDER_LIBRARY, actorId: FOUNDER_ACTOR, canConfigure: true,
  employees: [{ id: "employee-one", version: 2, name: "Revenue reviewer" }], skill: { id: "skill-one", version: 3, name: "Revenue facts" },
  connections: [{ id: "account-one", workspaceId: FOUNDER_WORKSPACE, scope: "workspace", providerKey: "stripe", version: 4, generation: 1, state: "active", identityLabel: "Reviewed account", authorizationFingerprint: "f".repeat(64), upstreamReady: true, health: "unknown", grantCount: 1 }] });
export const founderPlan = (): FounderConnectorPlan => ({ id: "fcj-one", version: 1, digest: "a".repeat(64), state: "draft", reviewExpiresAt: Date.now() + 900_000, nextDueAt: Date.now() + 3_600_000,
  canEnable: true, canPause: false, canResume: false, canRevoke: true,
  contract: { format: "shiba.founder-connector.v1", libraryId: FOUNDER_LIBRARY, workspaceId: FOUNDER_WORKSPACE, ownerId: FOUNDER_ACTOR, ownerAccountId: "native-owner",
    employeeId: "employee-one", employeeVersion: 2, employeeName: "Revenue reviewer", skillId: "skill-one", skillVersion: 3, skillName: "Revenue facts",
    connectionId: "account-one", connectionVersion: 4, providerKey: "stripe", identityLabel: "Reviewed account", actionId: "stripe.list-subscriptions", actionName: "List subscriptions",
    inputSchema: { type: "object", properties: { limit: { type: "integer" } } }, arguments: { limit: 10 }, actionSchemaHash: "b".repeat(64), bindingDigest: "c".repeat(64), recipeSha256: "d".repeat(64),
    cadence: "daily", localTime: "09:00", timezone: "UTC", cron: "0 9 * * *", expiresAt: Date.now() + 86_400_000, destination: "private-dashboard", model: null } });
export const enabledFounderPlan = (): FounderConnectorPlan => ({ ...founderPlan(), version: 2, state: "enabled", canEnable: false, canPause: true });
export const founderOccurrence = (plan = enabledFounderPlan()): FounderConnectorOccurrence => ({ id: "occurrence-one", planId: plan.id, planVersion: plan.version, digest: "e".repeat(64), scheduledAt: Date.now() - 1_000,
  createdAt: Date.now(), expiresAt: Date.now() + 600_000, requestId: "static-occurrence-request", status: "pending", approval: null, canPrepare: true, canDecide: false, canExecute: false });
export const founderState = (plan: FounderConnectorPlan | null = null, occurrences: FounderConnectorOccurrence[] = []): FounderConnectorState => ({ ok: true, workspaceId: FOUNDER_WORKSPACE, libraryId: FOUNDER_LIBRARY, actorId: FOUNDER_ACTOR, canConfigure: true, plan, occurrences });
export const withFounderApproval = (item: FounderConnectorOccurrence, status: "pending" | "approved" | "completed" | "unknown" = "pending"): FounderConnectorOccurrence => ({ ...item,
  status: status === "pending" ? "awaiting-approval" : status, canPrepare: false, canDecide: status === "pending", canExecute: status === "approved",
  approval: { id: "wca-one", requesterId: FOUNDER_ACTOR, employeeId: "employee-one", employeeVersion: 2, employeeName: "Revenue reviewer", connectionId: "account-one", connectionVersion: 4,
    actionId: "stripe.list-subscriptions", arguments: { limit: 10 }, inputHash: "f".repeat(64), status, expiresAt: item.expiresAt, canDecide: status === "pending", canExecute: status === "approved", result: status === "completed" ? { subscriptions: 10, privateReceipt: "owner-only-output" } : null, error: status === "unknown" ? "outcome_unknown" : null } });
