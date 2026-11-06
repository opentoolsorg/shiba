import {
  isApprovalExpired,
  runInputHash,
  type PendingApproval,
  type DelegatedRun,
  type PersonalExecutionSnapshot,
  type SlackInstallationSnapshot,
  type SlackCoworkerPrivateStatusTarget,
} from "@shiba/shared";
import { getAgentByName } from "agents/routing";
import type { Env } from "./env.js";
import type { WorkspaceNativeMember } from "./workspace-native-authority.js";
import { membershipSql } from "./workspace-integrations-store.js";
import {
  activeSlackInstallationForTeam,
  readSlackInstallationCredential,
  slackInstallationGuard,
  slackOAuthConfiguration,
} from "./slack-installations-store.js";
import { slackCoworkerDraftGuard } from "./slack-coworker-store.js";
import { collaborationExecutorIdentity } from "./collaboration-executor.js";
import { getCollaborationHandoff } from "./collaboration-store.js";
import { isCollaborationRunBound } from "./collaboration-live-routes.js";
import { signInternalRequest } from "./edge-identity.js";

export interface SlackCoworkerPrivateStatusPreview {
  previewId: string;
  draftId: string;
  workspaceId: string;
  actorId: string;
  roomId: string;
  personalExecution: PersonalExecutionSnapshot;
  privateStatus?: SlackCoworkerPrivateStatusTarget | null;
  digest: string;
}
export interface SlackCoworkerPrivateStatusDeps {
  fetch?: typeof fetch;
}
interface Source {
  app_id: string;
  team_id: string;
  channel_id: string;
  thread_ts: string;
  slack_user_id: string;
  message_ts: string;
  event_id: string;
  grant_id: string;
  installation_id: string;
  expires_at: number;
}
interface Row {
  preview_id: string;
  workspace_id: string;
  account_id: string;
  member_json: string;
  draft_id: string;
  handoff_id: string;
  target_json: string;
  installation_json: string;
  source_json: string;
  preview_json: string;
  preview_digest: string;
  state: string;
  delivery_state: string;
  claim_id: string | null;
  lease_expires_at: number | null;
  attempted_json: string;
  last_status: string | null;
  used_notices: number;
  next_check_at: number;
  expires_at: number;
  error_code: string | null;
}
const nowSql = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
const SCHEMA = `CREATE TABLE IF NOT EXISTS slack_coworker_private_status (preview_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,account_id TEXT NOT NULL,member_json TEXT NOT NULL,draft_id TEXT NOT NULL UNIQUE,handoff_id TEXT NOT NULL UNIQUE,target_json TEXT NOT NULL,installation_json TEXT NOT NULL,source_json TEXT NOT NULL,preview_json TEXT NOT NULL,preview_digest TEXT NOT NULL,state TEXT NOT NULL,delivery_state TEXT NOT NULL,claim_id TEXT,lease_expires_at INTEGER,attempted_json TEXT NOT NULL,last_status TEXT,used_notices INTEGER NOT NULL,next_check_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,error_code TEXT,created_at INTEGER NOT NULL)`;
const POLL = 300_000,
  LEASE = 30_000;
function configured(env: Env): boolean {
  try {
    return (
      (env as Env & { SLACK_COWORKER_PRIVATE_STATUS_ENABLED?: string })
        .SLACK_COWORKER_PRIVATE_STATUS_ENABLED === "true" &&
      env.SLACK_INSTALLATIONS_ENABLED?.trim() === "true" &&
      Boolean(slackOAuthConfiguration(env))
    );
  } catch {
    return false;
  }
}
async function schema(env: Env) {
  await env.AGENT_AUDIT.prepare(SCHEMA).run();
  await env.AGENT_AUDIT.prepare(
    "CREATE INDEX IF NOT EXISTS slack_coworker_private_status_due ON slack_coworker_private_status(state,next_check_at)",
  ).run();
}
async function hash(value: unknown) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
async function source(
  env: Env,
  member: WorkspaceNativeMember,
  draftId: string,
): Promise<Source | null> {
  const g = slackCoworkerDraftGuard(member);
  return env.AGENT_AUDIT.prepare(`SELECT d.app_id,d.team_id,d.channel_id,d.thread_ts,d.slack_user_id,d.message_ts,d.event_id,d.grant_id,g.installation_id,g.expires_at FROM slack_coworker_drafts d JOIN slack_coworker_intake_grants g ON g.id=d.grant_id JOIN slack_coworker_bindings b ON b.id=g.binding_id
 WHERE d.id=? AND ${g.sql} AND d.app_id=g.app_id AND d.team_id=g.team_id AND d.channel_id=g.channel_id AND d.thread_ts=g.thread_ts AND d.slack_user_id=b.slack_user_id AND b.installation_id=g.installation_id AND b.generation=g.generation
 AND NOT EXISTS(SELECT 1 FROM slack_coworker_invalidated_messages x WHERE x.app_id=d.app_id AND x.team_id=d.team_id AND x.channel_id=d.channel_id AND x.message_ts=d.message_ts)`)
    .bind(draftId, ...g.values)
    .first<Source>();
}
async function derive(
  env: Env,
  member: WorkspaceNativeMember,
  draftId: string,
  personalExpiresAt: number,
) {
  if (!configured(env) || !Number.isSafeInteger(personalExpiresAt)) return null;
  const s = await source(env, member, draftId);
  if (!s) return null;
  const installation = await activeSlackInstallationForTeam(env, s.app_id, s.team_id);
  if (
    !installation ||
    installation.id !== s.installation_id ||
    !installation.scopes.includes("chat:write")
  )
    return null;
  const expiresAt = Math.min(
    Date.now() + 86_400_000,
    s.expires_at,
    personalExpiresAt,
    installation.expiresAt ?? Number.MAX_SAFE_INTEGER,
  );
  if (expiresAt <= Date.now()) return null;
  const target: SlackCoworkerPrivateStatusTarget = {
    kind: "private-slack-status-v1",
    installationId: installation.id,
    installationDigest: await hash(installation),
    appId: s.app_id,
    teamId: s.team_id,
    channelId: s.channel_id,
    threadTs: s.thread_ts,
    slackUserId: s.slack_user_id,
    expiresAt,
    maxNotices: 6,
  };
  if (!(await source(env, member, draftId))) return null;
  return { target, installation, source: s };
}
export async function describeSlackCoworkerPrivateStatus(
  env: Env,
  member: WorkspaceNativeMember,
  draftId: string,
  personalExpiresAt: number,
): Promise<SlackCoworkerPrivateStatusTarget | null> {
  try {
    return (await derive(env, member, draftId, personalExpiresAt))?.target ?? null;
  } catch {
    return null;
  }
}
/** Activation records consent only. Actual delivery waits for a retained human-approved run. */
export async function activateSlackCoworkerPrivateStatus(
  env: Env,
  member: WorkspaceNativeMember,
  preview: SlackCoworkerPrivateStatusPreview,
  consent: boolean,
): Promise<void> {
  if (!consent) return;
  if (!configured(env)) throw new Error("private_status_unavailable");
  await schema(env);
  const selected = await derive(env, member, preview.draftId, preview.personalExecution.expiresAt);
  if (
    !selected ||
    !preview.privateStatus ||
    JSON.stringify(selected.target) !== JSON.stringify(preview.privateStatus) ||
    preview.workspaceId !== member.workspaceId ||
    preview.actorId !== member.userId
  )
    throw new Error("private_status_authority_changed");
  const raw = await env.AGENT_AUDIT.prepare(
    "SELECT preview_json FROM slack_coworker_execution_v2 WHERE id=? AND workspace_id=? AND account_id=? AND draft_id=? AND digest=? AND state='dispatching'",
  )
    .bind(preview.previewId, member.workspaceId, member.accountId, preview.draftId, preview.digest)
    .first<{ preview_json: string }>();
  if (!raw) throw new Error("private_status_submission_unavailable");
  const saved = JSON.parse(raw.preview_json) as Record<string, unknown>;
  if (
    JSON.stringify(saved.privateStatus) !== JSON.stringify(preview.privateStatus) ||
    saved.digest !== preview.digest ||
    saved.roomId !== preview.roomId ||
    JSON.stringify(saved.personalExecution) !== JSON.stringify(preview.personalExecution)
  )
    throw new Error("private_status_selection_changed");
  const d = slackCoworkerDraftGuard(member),
    i = slackInstallationGuard(selected.installation),
    s = selected.source;
  const r =
    await env.AGENT_AUDIT.prepare(`INSERT INTO slack_coworker_private_status(preview_id,workspace_id,account_id,member_json,draft_id,handoff_id,target_json,installation_json,source_json,preview_json,preview_digest,state,delivery_state,attempted_json,used_notices,next_check_at,expires_at,created_at)
 SELECT ?,?,?,?,?,?,?,?,?,?,?,'active','idle','[]',0,?,?,? WHERE ${i.sql} AND EXISTS(SELECT 1 FROM slack_coworker_drafts d WHERE d.id=? AND ${d.sql} AND d.app_id=? AND d.team_id=? AND d.channel_id=? AND d.thread_ts=? AND d.message_ts=? AND d.event_id=? AND d.slack_user_id=? AND d.grant_id=?)
 AND EXISTS(SELECT 1 FROM slack_coworker_execution_v2 WHERE id=? AND state='dispatching' AND preview_json=? AND digest=?) AND (SELECT count(*) FROM slack_coworker_private_status WHERE account_id=?)<1000`)
      .bind(
        preview.previewId,
        member.workspaceId,
        member.accountId,
        JSON.stringify(member),
        preview.draftId,
        `scx_${preview.draftId.slice(3)}`,
        JSON.stringify(selected.target),
        JSON.stringify(selected.installation),
        JSON.stringify(s),
        raw.preview_json,
        preview.digest,
        Date.now(),
        selected.target.expiresAt,
        Date.now(),
        ...i.values,
        preview.draftId,
        ...d.values,
        s.app_id,
        s.team_id,
        s.channel_id,
        s.thread_ts,
        s.message_ts,
        s.event_id,
        s.slack_user_id,
        s.grant_id,
        preview.previewId,
        raw.preview_json,
        preview.digest,
        member.accountId,
      )
      .run();
  if (r.meta.changes !== 1) throw new Error("private_status_authority_changed");
}
type RunStatus = "awaiting_review" | "rejected" | "approved" | "running" | "completed" | "stopped";
interface ExecutionRow {
  preview_json: string;
  scope_json: string;
  audience_json: string;
  profile_json: string;
  approval_id: string;
  frozen_task_hash: string;
  state: string;
}
const linksSql = `(SELECT json_group_array(json_object('id',x.link_id,'owner',x.owner_user_id,'team',x.team_id,'channel',x.channel_id,'thread',x.thread_ts,'status',x.status,'created',x.created_at)) FROM (SELECT link_id,owner_user_id,team_id,channel_id,thread_ts,status,created_at FROM collaboration_slack_room_links WHERE tenant_id='self-hosted' AND workspace_id=? AND room_id=? ORDER BY link_id) x)`;
function mapped(run: DelegatedRun): RunStatus | null {
  if (run.status === "pending") return "approved";
  if (run.status === "running") return "running";
  if (run.status === "completed") return "completed";
  if (["error", "aborted", "cancelled"].includes(run.status)) return "stopped";
  return null;
}
function message(handoffId: string, status: RunStatus) {
  const suffix = handoffId.slice(-8);
  return status === "awaiting_review"
    ? `Shiba task ${suffix} is awaiting your review. Open your authorized Shiba room for details.`
    : status === "rejected"
      ? `Shiba task ${suffix} was rejected. Open your authorized Shiba room for details.`
      : status === "approved"
        ? `Shiba task ${suffix} is approved and waiting to run. Open your authorized Shiba room for details.`
        : status === "running"
          ? `Shiba task ${suffix} is running. Open your authorized Shiba room for details.`
          : status === "completed"
            ? `Shiba task ${suffix} completed. Open your authorized Shiba room for details.`
            : `Shiba task ${suffix} stopped. Open your authorized Shiba room for details.`;
}
async function boundedJson(response: Response): Promise<Record<string, unknown> | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  let used = 0;
  const buf = new Uint8Array(16_384);
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (used + part.value.length > buf.length) return null;
      buf.set(part.value, used);
      used += part.value.length;
    }
    const obj: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, used)),
    );
    return obj && typeof obj === "object" && !Array.isArray(obj)
      ? (obj as Record<string, unknown>)
      : null;
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
  }
}
async function readObserved(env: Env, row: Row) {
  const member = JSON.parse(row.member_json) as WorkspaceNativeMember,
    scope = { tenantId: "self-hosted", workspaceId: row.workspace_id, userId: member.userId };
  const p = JSON.parse(row.preview_json) as SlackCoworkerPrivateStatusPreview & {
    recipientActorId: string;
    employeeVersion: number;
    roomTitle: string;
  };
  const v = await env.AGENT_AUDIT.prepare(
    "SELECT preview_json,scope_json,audience_json,profile_json,approval_id,frozen_task_hash,state FROM slack_coworker_execution_v2 WHERE id=? AND workspace_id=? AND account_id=? AND state='queued'",
  )
    .bind(row.preview_id, row.workspace_id, row.account_id)
    .first<ExecutionRow>();
  if (!v || v.preview_json !== row.preview_json || !v.approval_id || !v.frozen_task_hash)
    return null;
  const handoff = await getCollaborationHandoff(env, scope, row.handoff_id),
    executor = handoff && collaborationExecutorIdentity(handoff);
  if (
    !handoff ||
    !executor ||
    handoff.status !== "active" ||
    handoff.roomId !== p.roomId ||
    handoff.senderUserId !== member.userId ||
    handoff.approvalId !== v.approval_id ||
    !handoff.runId ||
    handoff.runId !== `agent-tool:${v.approval_id}` ||
    handoff.recipientActorId !== p.recipientActorId ||
    handoff.profileVersion !== p.employeeVersion
  )
    return null;
  const host = await getAgentByName(env.CodingOrchestrator, executor.agentName);
  const read = async (path: string) => {
    const req = new Request(`https://internal${path}`);
    await signInternalRequest(req, env);
    const response = await host.fetch(req);
    return response.ok ? (response.json() as Promise<Record<string, unknown>>) : null;
  };
  const [rb, ab] = await Promise.all([
    read(`/api/runs/${encodeURIComponent(handoff.runId)}`),
    read("/api/approvals"),
  ]);
  const decisions = [
    ...(Array.isArray(ab?.approvals) ? ab.approvals : []),
    ...(Array.isArray(ab?.decided) ? ab.decided : []),
  ];
  const matches = decisions.filter(
    (item: unknown) =>
      item &&
      typeof item === "object" &&
      (item as { approvalId?: unknown }).approvalId === v.approval_id,
  );
  if (matches.length !== 1) return null;
  const approval = matches[0] as PendingApproval;
  if (
    approval.threadKey !== executor.agentName ||
    approval.collaborationHandoffId !== row.handoff_id ||
    approval.customAgentId !== p.recipientActorId.slice(6) ||
    approval.customAgentVersion !== p.employeeVersion ||
    typeof approval.task !== "string" ||
    JSON.stringify(approval.personalExecution) !== JSON.stringify(p.personalExecution)
  )
    return null;
  const authorized = await (await import("./slack-coworker-execution.js")).isSlackCoworkerV2Current(
    env,
    row.handoff_id,
    scope,
    p.roomId,
    approval.task,
    v.approval_id,
    approval.personalExecution,
  );
  if (!authorized) return null;
  const links = await env.AGENT_AUDIT.prepare(`SELECT ${linksSql} AS value`)
    .bind(row.workspace_id, p.roomId)
    .first<{ value: string }>();
  if (!links) return null;
  const inputHash = runInputHash({
    ...approval,
    baseBranch: approval.baseBranch ?? "main",
    publishPullRequest: approval.publishPullRequest ?? false,
  });
  if (approval.status === "pending")
    return !isApprovalExpired(approval, Date.now())
      ? { status: "awaiting_review" as const, handoff, v, p, inputHash, links: links.value }
      : null;
  if (
    approval.decidedBy?.trim().toLowerCase() !== member.userId ||
    !Number.isFinite(approval.decidedAt) ||
    !approval.decidedAt
  )
    return null;
  if (approval.status === "rejected")
    return { status: "rejected" as const, handoff, v, p, inputHash, links: links.value };
  const run = rb?.run as DelegatedRun | undefined;
  if (
    approval.status !== "approved" ||
    !isCollaborationRunBound(run, handoff) ||
    !Number.isSafeInteger(run.generation) ||
    run.generation < 0 ||
    run.approval?.inputHash !== inputHash ||
    run.approval.decidedBy.trim().toLowerCase() !== member.userId ||
    run.approval.decidedAt !== approval.decidedAt ||
    approval.task !== run.task ||
    JSON.stringify(run.personalExecution) !== JSON.stringify(p.personalExecution)
  )
    return null;
  const status = mapped(run);
  return status
    ? { status, handoff, v, p, inputHash, links: links.value, generation: run.generation }
    : null;
}
function finalGuard(row: Row, observed: NonNullable<Awaited<ReturnType<typeof readObserved>>>) {
  const member = JSON.parse(row.member_json) as WorkspaceNativeMember,
    installation = JSON.parse(row.installation_json) as SlackInstallationSnapshot,
    s = JSON.parse(row.source_json) as Source;
  const d = slackCoworkerDraftGuard(member),
    i = slackInstallationGuard(installation),
    p = observed.p,
    v = observed.v,
    h = observed.handoff;
  const audience = `(SELECT json_group_array(json_object('actorId',x.actor_id,'userId',x.user_id,'kind',x.actor_kind,'role',x.role)) FROM (SELECT actor_id,user_id,actor_kind,role FROM collaboration_memberships WHERE tenant_id='self-hosted' AND workspace_id=? AND room_id=? AND status='active' AND EXISTS(SELECT 1 FROM json_each(capabilities_json) WHERE value='room.read') ORDER BY actor_id) x)`;
  return {
    sql: `${i.sql} AND EXISTS(SELECT 1 FROM slack_coworker_drafts d WHERE d.id=? AND ${d.sql} AND d.app_id=? AND d.team_id=? AND d.channel_id=? AND d.thread_ts=? AND d.message_ts=? AND d.event_id=? AND d.slack_user_id=? AND d.grant_id=? AND EXISTS(SELECT 1 FROM slack_coworker_intake_grants g JOIN slack_coworker_bindings b ON b.id=g.binding_id WHERE g.id=d.grant_id AND g.app_id=d.app_id AND g.team_id=d.team_id AND g.channel_id=d.channel_id AND g.thread_ts=d.thread_ts AND b.slack_user_id=d.slack_user_id AND b.installation_id=g.installation_id AND b.generation=g.generation) AND NOT EXISTS(SELECT 1 FROM slack_coworker_invalidated_messages x WHERE x.app_id=d.app_id AND x.team_id=d.team_id AND x.channel_id=d.channel_id AND x.message_ts=d.message_ts))
 AND ${audience}=? AND EXISTS(SELECT 1 FROM slack_coworker_execution_v2 e WHERE e.id=? AND e.workspace_id=? AND e.account_id=? AND e.state='queued' AND e.preview_json=? AND e.scope_json=? AND e.audience_json=? AND e.profile_json=? AND e.approval_id=? AND e.frozen_task_hash=?)
 AND ${linksSql}=? AND EXISTS(SELECT 1 FROM collaboration_rooms WHERE tenant_id='self-hosted' AND workspace_id=? AND room_id=? AND title=?)
 AND EXISTS(SELECT 1 FROM collaboration_memberships WHERE tenant_id='self-hosted' AND workspace_id=? AND room_id=? AND actor_id=? AND user_id=? AND actor_kind='human' AND status='active' AND EXISTS(SELECT 1 FROM json_each(capabilities_json) WHERE value='handoff.create'))
 AND EXISTS(SELECT 1 FROM collaboration_memberships WHERE tenant_id='self-hosted' AND workspace_id=? AND room_id=? AND actor_id=? AND user_id=? AND actor_kind='agent' AND status='active' AND profile_version=?)
 AND EXISTS(SELECT 1 FROM collaboration_handoffs h WHERE h.tenant_id='self-hosted' AND h.workspace_id=? AND h.handoff_id=? AND h.room_id=? AND h.status='active' AND h.sender_user_id=? AND h.sender_actor_id=? AND h.recipient_actor_id=? AND h.recipient_user_id=? AND h.profile_version=? AND h.approval_id=? AND h.run_id=? AND h.executor_agent_name=? AND h.parent_handoff_id IS NULL AND h.root_handoff_id=h.handoff_id)
 AND EXISTS(SELECT 1 FROM org_custom_agents a JOIN org_custom_agent_versions av ON av.org_id=a.org_id AND av.agent_id=a.id WHERE a.org_id=? AND a.id=? AND a.version=? AND a.deleted_at IS NULL AND a.archived_at IS NULL AND av.version=? AND av.config_json=?)
 AND EXISTS(SELECT 1 FROM personal_execution_grants pg WHERE pg.grant_id=? AND pg.owner_account_id=? AND pg.workspace_id=? AND pg.status='active' AND pg.version=? AND pg.snapshot_json=? AND pg.scope_json=? AND pg.expires_at>${nowSql})`,
    values: [
      ...i.values,
      row.draft_id,
      ...d.values,
      s.app_id,
      s.team_id,
      s.channel_id,
      s.thread_ts,
      s.message_ts,
      s.event_id,
      s.slack_user_id,
      s.grant_id,
      row.workspace_id,
      p.roomId,
      v.audience_json,
      row.preview_id,
      row.workspace_id,
      row.account_id,
      v.preview_json,
      v.scope_json,
      v.audience_json,
      v.profile_json,
      v.approval_id,
      v.frozen_task_hash,
      row.workspace_id,
      p.roomId,
      observed.links,
      row.workspace_id,
      p.roomId,
      p.roomTitle,
      row.workspace_id,
      p.roomId,
      `human:${member.userId}`,
      member.userId,
      row.workspace_id,
      p.roomId,
      p.recipientActorId,
      h.recipientUserId,
      p.employeeVersion,
      row.workspace_id,
      row.handoff_id,
      p.roomId,
      member.userId,
      `human:${member.userId}`,
      p.recipientActorId,
      h.recipientUserId,
      p.employeeVersion,
      v.approval_id,
      h.runId,
      h.executorAgentName,
      `team:${row.workspace_id}`,
      p.recipientActorId.slice(6),
      p.employeeVersion,
      p.employeeVersion,
      v.profile_json,
      p.personalExecution.grantId,
      row.account_id,
      row.workspace_id,
      p.personalExecution.grantVersion,
      JSON.stringify(p.personalExecution),
      v.scope_json,
    ],
  };
}
function packGuard(guard: { sql: string; values: unknown[] }) {
  let n = 0;
  const sql = guard.sql.replaceAll("?", () => `json_extract(psg.value,'$[${n++}]')`);
  if (n !== guard.values.length) throw new Error("private_status_guard_invalid");
  return {
    sql: `EXISTS(SELECT 1 FROM json_each(?) psg WHERE ${sql})`,
    values: [JSON.stringify([guard.values])],
  };
}
/** One attempt per status; uncertain or abandoned posts never retry. */
export async function tickSlackCoworkerPrivateStatus(
  env: Env,
  deps: SlackCoworkerPrivateStatusDeps = {},
) {
  if (!configured(env) || !env.AGENT_AUDIT || !env.CodingOrchestrator)
    return { accepted: 0, unavailable: true };
  await schema(env);
  const rows = await env.AGENT_AUDIT.prepare(
    `SELECT * FROM slack_coworker_private_status WHERE state='active' AND next_check_at<=${nowSql} ORDER BY next_check_at,preview_id LIMIT 20`,
  ).all<Row>();
  let accepted = 0;
  for (const row of rows.results) {
    if (row.delivery_state === "sending") {
      if ((row.lease_expires_at ?? 0) <= Date.now())
        await env.AGENT_AUDIT.prepare(
          "UPDATE slack_coworker_private_status SET state='unknown',delivery_state='unknown',error_code='receipt_missing' WHERE preview_id=? AND state='active' AND delivery_state='sending' AND claim_id=?",
        )
          .bind(row.preview_id, row.claim_id)
          .run();
      continue;
    }
    if (row.delivery_state === "unknown" || row.expires_at <= Date.now() || row.used_notices >= 6) {
      await env.AGENT_AUDIT.prepare(
        "UPDATE slack_coworker_private_status SET state=CASE WHEN delivery_state='unknown' THEN 'unknown' ELSE 'expired' END WHERE preview_id=? AND state='active' AND delivery_state<>'sending'",
      )
        .bind(row.preview_id)
        .run();
      continue;
    }
    let claimId: string | undefined,
      dispatched = false;
    try {
      const targetPin = JSON.parse(row.target_json) as SlackCoworkerPrivateStatusTarget;
      const previewPin = JSON.parse(row.preview_json) as SlackCoworkerPrivateStatusPreview;
      const sourcePin = JSON.parse(row.source_json) as Source;
      const installationPin = JSON.parse(row.installation_json) as SlackInstallationSnapshot;
      if (
        JSON.stringify(previewPin.privateStatus) !== row.target_json ||
        previewPin.digest !== row.preview_digest ||
        targetPin.expiresAt !== row.expires_at ||
        targetPin.maxNotices !== 6 ||
        targetPin.installationId !== installationPin.id ||
        targetPin.appId !== sourcePin.app_id ||
        targetPin.teamId !== sourcePin.team_id ||
        targetPin.channelId !== sourcePin.channel_id ||
        targetPin.threadTs !== sourcePin.thread_ts ||
        targetPin.slackUserId !== sourcePin.slack_user_id ||
        targetPin.installationId !== sourcePin.installation_id ||
        (await hash(installationPin)) !== targetPin.installationDigest
      )
        throw new Error("private_status_target_changed");
      const member = JSON.parse(row.member_json) as WorkspaceNativeMember,
        sourceNow = await source(env, member, row.draft_id);
      if (!sourceNow || JSON.stringify(sourceNow) !== row.source_json)
        throw new Error("source_changed");
      const first = await readObserved(env, row);
      if (!first) {
        await env.AGENT_AUDIT.prepare(
          "UPDATE slack_coworker_private_status SET next_check_at=? WHERE preview_id=? AND state='active' AND delivery_state='idle'",
        )
          .bind(Date.now() + POLL, row.preview_id)
          .run();
        continue;
      }
      const installation = JSON.parse(row.installation_json) as SlackInstallationSnapshot,
        target = JSON.parse(row.target_json) as SlackCoworkerPrivateStatusTarget;
      if ((await hash(installation)) !== target.installationDigest || !configured(env))
        throw new Error("installation_changed");
      const { token } = await readSlackInstallationCredential(env, installation),
        http = deps.fetch ?? fetch;
      const auth = await http("https://slack.com/api/auth.test", {
        method: "POST",
        redirect: "error",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8_000),
      });
      const identity = await boundedJson(auth);
      const scopes =
        auth.headers
          .get("x-oauth-scopes")
          ?.split(",")
          .map((s) => s.trim()) ?? [];
      if (
        !auth.ok ||
        identity?.ok !== true ||
        identity.team_id !== installation.teamId ||
        identity.user_id !== installation.botUserId ||
        identity.bot_id !== installation.botId ||
        identity.enterprise_id != null ||
        !scopes.includes("chat:write")
      )
        throw new Error("installation_changed");
      const fresh = await readObserved(env, row);
      if (
        !fresh ||
        fresh.handoff.runId !== first.handoff.runId ||
        fresh.inputHash !== first.inputHash ||
        ("generation" in first && "generation" in fresh && first.generation !== fresh.generation)
      )
        throw new Error("source_changed");
      const status = fresh.status,
        attempted = JSON.parse(row.attempted_json) as string[];
      if (attempted.includes(status)) {
        await env.AGENT_AUDIT.prepare(
          "UPDATE slack_coworker_private_status SET next_check_at=? WHERE preview_id=? AND state='active' AND delivery_state='idle' AND attempted_json=?",
        )
          .bind(Date.now() + POLL, row.preview_id, row.attempted_json)
          .run();
        continue;
      }
      const guard = packGuard(finalGuard(row, fresh)),
        now = Date.now();
      claimId = crypto.randomUUID();
      const result = await env.AGENT_AUDIT.prepare(
        `UPDATE slack_coworker_private_status SET delivery_state='sending',claim_id=?,lease_expires_at=?,used_notices=used_notices+1,attempted_json=json_insert(attempted_json,'$[#]',?),next_check_at=? WHERE preview_id=? AND workspace_id=? AND account_id=? AND state='active' AND delivery_state='idle' AND used_notices=? AND attempted_json=? AND target_json=? AND installation_json=? AND source_json=? AND preview_json=? AND preview_digest=? AND expires_at>? AND used_notices<6 AND ${guard.sql}`,
      )
        .bind(
          claimId,
          now + LEASE,
          status,
          now + POLL,
          row.preview_id,
          row.workspace_id,
          row.account_id,
          row.used_notices,
          row.attempted_json,
          row.target_json,
          row.installation_json,
          row.source_json,
          row.preview_json,
          row.preview_digest,
          now,
          ...guard.values,
        )
        .run();
      if (result.meta.changes !== 1) continue;
      // Last D1 authority snapshot includes consent, source, audience and exact claim.
      const final = await env.AGENT_AUDIT.prepare(
        `SELECT 1 FROM slack_coworker_private_status WHERE preview_id=? AND state='active' AND delivery_state='sending' AND claim_id=? AND lease_expires_at>${nowSql} AND expires_at>${nowSql} AND ${guard.sql}`,
      )
        .bind(row.preview_id, claimId, ...guard.values)
        .first();
      if (!final || !configured(env) || Date.now() >= row.expires_at)
        throw new Error("source_changed");
      dispatched = true;
      const response = await http("https://slack.com/api/chat.postEphemeral", {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        signal: AbortSignal.timeout(8_000),
        body: JSON.stringify({
          channel: target.channelId,
          user: target.slackUserId,
          thread_ts: target.threadTs,
          text: message(row.handoff_id, status),
        }),
      });
      const receipt = await boundedJson(response);
      if (
        !response.ok ||
        receipt?.ok !== true ||
        typeof receipt.message_ts !== "string" ||
        !/^\d{1,20}\.\d{1,20}$/.test(receipt.message_ts)
      )
        throw new Error("receipt_unconfirmed");
      const saved = await env.AGENT_AUDIT.prepare(
        "UPDATE slack_coworker_private_status SET delivery_state='idle',last_status=?,claim_id=NULL,lease_expires_at=NULL WHERE preview_id=? AND state='active' AND delivery_state='sending' AND claim_id=?",
      )
        .bind(status, row.preview_id, claimId)
        .run();
      if (saved.meta.changes === 1) accepted++;
    } catch {
      if (claimId)
        await env.AGENT_AUDIT.prepare(
          "UPDATE slack_coworker_private_status SET state=CASE WHEN state='revoked' THEN 'revoked' ELSE ? END,delivery_state=?,error_code=? WHERE preview_id=? AND delivery_state='sending' AND claim_id=?",
        )
          .bind(
            dispatched ? "unknown" : "blocked",
            dispatched ? "unknown" : "blocked",
            dispatched ? "receipt_unconfirmed" : "authority_changed",
            row.preview_id,
            claimId,
          )
          .run();
      else
        await env.AGENT_AUDIT.prepare(
          "UPDATE slack_coworker_private_status SET state='blocked',error_code='authority_changed' WHERE preview_id=? AND state='active' AND delivery_state='idle'",
        )
          .bind(row.preview_id)
          .run();
    }
  }
  return { accepted, unavailable: false };
}
export async function revokeSlackCoworkerPrivateStatus(
  env: Env,
  member: WorkspaceNativeMember,
  previewId: string,
): Promise<boolean> {
  await schema(env);
  const m = membershipSql(member);
  const r = await env.AGENT_AUDIT.prepare(
    `UPDATE slack_coworker_private_status SET state='revoked' WHERE preview_id=? AND workspace_id=? AND account_id=? AND ${m.sql}`,
  )
    .bind(previewId, member.workspaceId, member.accountId, ...m.values)
    .run();
  return r.meta.changes === 1;
}
export async function readSlackCoworkerPrivateStatus(
  env: Env,
  member: WorkspaceNativeMember,
  previewId: string,
): Promise<"active" | "revoked" | "blocked" | "unknown" | "expired" | undefined> {
  if (!env.AGENT_AUDIT) return undefined;
  const exists = await env.AGENT_AUDIT.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='slack_coworker_private_status'",
  ).first();
  if (!exists) return undefined;
  const m = membershipSql(member);
  const row = await env.AGENT_AUDIT.prepare(
    `SELECT state,expires_at FROM slack_coworker_private_status WHERE preview_id=? AND workspace_id=? AND account_id=? AND ${m.sql}`,
  )
    .bind(previewId, member.workspaceId, member.accountId, ...m.values)
    .first<{
      state: "active" | "revoked" | "blocked" | "unknown" | "expired";
      expires_at: number;
    }>();
  return row?.state === "active" && row.expires_at <= Date.now() ? "expired" : row?.state;
}
