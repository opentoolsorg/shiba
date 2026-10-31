import type { Env } from "./env.js";
import { isApprover, parseApproverAllowlist } from "./slack-approval.js";
import { ORCHESTRATOR_NAME } from "./slack-routes.js";
import { isAuthorizedSessionAgent, WEB_SESSION_PREFIX } from "./web-sessions.js";

/**
 * Server-side gate for POST /api/approvals on the orchestrator DO. The Worker
 * routes human decisions through approvals-routes first; this closes the gap
 * when a caller reaches the DO directly (for example via SDK child routing).
 */
export function approvalResolveForbidden(
  env: Env,
  input: {
    threadKey: string;
    approved: boolean;
    decidedBy: string;
    source?: unknown;
  },
): string | null {
  if (!input.approved) {
    if (input.decidedBy === "task-cancel" || input.decidedBy.startsWith("system:")) {
      return null;
    }
  }

  if (input.decidedBy.startsWith("automation:")) {
    return input.approved ? null : "Not authorized to resolve shared approvals.";
  }

  if (input.source === "slack") {
    return isApprover(input.decidedBy, parseApproverAllowlist(env.SLACK_APPROVERS))
      ? null
      : "Not authorized to resolve shared approvals.";
  }

  if (input.decidedBy === "task-cancel") {
    return null;
  }

  // Personal dashboard runs stamp threadKey to the authenticated owner DO name.
  if (input.threadKey === input.decidedBy) {
    return null;
  }

  if (input.threadKey.startsWith(WEB_SESSION_PREFIX)) {
    return isAuthorizedSessionAgent(input.threadKey, input.decidedBy)
      ? null
      : "Forbidden.";
  }

  // Shared queue on the default orchestrator (email, automations, MCP runs).
  if (input.threadKey === ORCHESTRATOR_NAME || input.threadKey === "default") {
    return isApprover(input.decidedBy, parseApproverAllowlist(env.DASHBOARD_APPROVERS))
      ? null
      : "Not authorized to resolve shared approvals.";
  }

  // Any other shared approval pointer (Slack thread keys, review lane, etc.).
  return isApprover(input.decidedBy, parseApproverAllowlist(env.DASHBOARD_APPROVERS))
    ? null
    : "Not authorized to resolve shared approvals.";
}
