import { isJsonObject } from "../pending-approvals.js";
import { parseSlackCanvasOrigin } from "../slack-canvas.js";
import { parseSlackThreadName } from "../slack-thread.js";
import { isActiveStatus, RunStore } from "../runs.js";
import type { RunRoomIdentity } from "../run-room-events.js";
import type { SlackAgentSessionIntent } from "../slack-agent-sessions.js";
import type { OrchestratorState } from "./orchestrator.js";
import type { Env } from "../env.js";

export function slackCanvasOriginPatch(
  state: OrchestratorState,
  name: string,
  approvalId: string,
  origin: string | undefined,
  room?: RunRoomIdentity | null,
  env: Pick<Env, "SHIBA_SCOPED_DO"> = {},
): Pick<
  OrchestratorState,
  "slackCanvasOrigins" | "slackCanvasThreadOrigin" | "slackCanvasRunRooms"
> {
  if (!origin || parseSlackCanvasOrigin(origin, env)?.orchestratorName !== name) return {};
  return {
    slackCanvasOrigins: Object.fromEntries(
      [
        ...Object.entries(state?.slackCanvasOrigins ?? {}).filter(([id]) => id !== approvalId),
        [approvalId, origin],
      ].slice(-500),
    ),
    ...(origin === name && parseSlackThreadName(name) ? { slackCanvasThreadOrigin: origin } : {}),
    ...(room
      ? {
          slackCanvasRunRooms: Object.fromEntries(
            [
              ...Object.entries(state?.slackCanvasRunRooms ?? {}).filter(
                ([id]) => id !== room.runId,
              ),
              [room.runId, { ownerId: room.ownerId, sessionId: room.sessionId, runId: room.runId }],
            ].slice(-500),
          ),
        }
      : {}),
  };
}

export function slackSessionIntent(
  state: OrchestratorState,
  name: string,
  enabled: boolean,
): SlackAgentSessionIntent | null {
  if (state?.sessionDeletedAt !== undefined || !enabled) return null;
  const scope = parseSlackCanvasOrigin(name);
  const revision = state?.events?.at(-1)?.seq;
  if (
    !scope ||
    scope.orchestratorName !== name ||
    !parseSlackThreadName(name) ||
    !Number.isSafeInteger(revision) ||
    !revision ||
    revision < 1
  )
    return null;
  const approvals = state.pendingApprovals ?? [];
  const runs = new RunStore(
    () => state.runs ?? [],
    () => {},
  ).list();
  const source = (approvalId: string) => {
    if (state.slackCanvasOrigins?.[approvalId] !== name) return null;
    const binding = state.slackCanvasRunRooms?.[`agent-tool:${approvalId}`];
    return binding?.runId === `agent-tool:${approvalId}` ? binding : null;
  };
  const approvedRuns = runs.filter((run) => {
    const approvalId = run.approval?.approvalId;
    const approval = approvals.find(
      (item) => item.approvalId === approvalId && item.threadKey === name,
    );
    return (
      approvalId &&
      run.runId === `agent-tool:${approvalId}` &&
      source(approvalId) &&
      approval?.status === "approved" &&
      (!approval.kind || approval.kind === "run")
    );
  });
  const make = (
    approvalId: string,
    status: SlackAgentSessionIntent["status"],
    persona: SlackAgentSessionIntent["persona"],
  ): SlackAgentSessionIntent | null => {
    const binding = source(approvalId);
    return binding
      ? { origin: name, approvalId, binding: { ...binding }, revision, status, persona }
      : null;
  };
  const active = runs
    .filter((run) => isActiveStatus(run.status))
    .sort((left, right) => right.updatedAt - left.updatedAt);
  for (const run of active) {
    const original = approvedRuns.find(
      (item) =>
        item.runId === run.runId || item.runId === run.reviewOf || item.runId === run.parentRunId,
    );
    if (original?.approval)
      return make(original.approval.approvalId, "processing", run.reviewOf ? "reviewer" : "fixer");
  }
  for (const approval of [...approvals].sort((left, right) => right.createdAt - left.createdAt)) {
    if (approval.status !== "pending" || approval.threadKey !== name) continue;
    if (!approval.kind || approval.kind === "run") {
      const pending = make(approval.approvalId, "suspended", "lead");
      if (pending) return pending;
    }
    if (approval.kind === "pr_publish" && isJsonObject(approval.payload)) {
      const sourceRunId = approval.payload.runId;
      const original = approvedRuns.find((run) => run.runId === sourceRunId);
      if (original?.approval) return make(original.approval.approvalId, "suspended", "reviewer");
    }
  }
  const terminal = approvedRuns
    .filter((run) => !isActiveStatus(run.status))
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
  if (terminal?.approval) return make(terminal.approval.approvalId, "active", "lead");
  const rejected = [...approvals]
    .reverse()
    .find(
      (approval) =>
        approval.status === "rejected" &&
        approval.threadKey === name &&
        (!approval.kind || approval.kind === "run") &&
        source(approval.approvalId),
    );
  return rejected ? make(rejected.approvalId, "active", "lead") : null;
}
