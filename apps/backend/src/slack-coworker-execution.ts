import type {
  PersonalExecutionSnapshot,
  PersonalPairingScope,
  SlackCoworkerPrivateStatusTarget,
} from "@shiba/shared";
import type { Env } from "./env.js";
import type { WorkspaceNativeMember } from "./workspace-native-authority.js";
import { SlackInstallationError } from "./slack-installations-crypto.js";
import { slackCoworkerDraftGuard } from "./slack-coworker-store.js";
import {
  resolvePersonalExecutionOwner,
  resolvePersonalExecutionGrant,
  personalGrantFence,
} from "./personal-execution-store.js";
import { canReadCollaborationRoom } from "./collaboration-room-access.js";
import {
  collaborationEmployeeOrgId,
  getActiveCollaborationMembership,
  getCollaborationMembership,
  getCollaborationRoom,
  humanActorId,
} from "./collaboration-store.js";
import { getCustomAgentVersion } from "./custom-agents-store.js";
import { composeCustomAgentTask } from "./custom-agents-resolve.js";
import { membershipSql } from "./workspace-integrations-store.js";

export interface SlackCoworkerSession {
  id: string;
  expiresAt: number;
}
export interface SlackCoworkerPrepare {
  requestId: string;
  id: string;
  roomId: string;
  recipientActorId: string;
  personalExecution: { grantId: string; expectedVersion: number };
}
export interface SlackCoworkerSubmit {
  previewId: string;
  digest: string;
  reviewed: true;
  audienceConsent: "share-my-slack-task-and-results-with-reviewed-room-audience";
  privateStatusConsent?: boolean;
}
export interface SlackCoworkerPreview {
  previewId: string;
  draftId: string;
  digest: string;
  workspaceId: string;
  actorId: string;
  task: string;
  roomId: string;
  roomTitle: string;
  recipientActorId: string;
  employeeName: string;
  employeeVersion: number;
  personalExecution: PersonalExecutionSnapshot;
  privateStatus?: SlackCoworkerPrivateStatusTarget | null;
  roomAudience: Array<{ actorId: string; userId: string; kind: "human" | "agent"; role: string }>;
  createdAt: number;
  expiresAt: number;
  consent: "share-my-slack-task-and-results-with-reviewed-room-audience";
}
interface Row {
  id: string;
  request_id: string;
  draft_id: string;
  handoff_id: string;
  workspace_id: string;
  account_id: string;
  member_json: string;
  scope_json: string;
  preview_json: string;
  digest: string;
  audience_json: string;
  profile_json: string;
  state: string;
  created_at: number;
  expires_at: number;
  session_id: string;
  session_expires_at: number;
  frozen_task_hash: string | null;
  approval_id: string | null;
}
const PURPOSE = "share-my-slack-task-and-results-with-reviewed-room-audience" as const;
const HEADER = "X-Shiba-Coworker-Proof";
const nowSql = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
const audienceSql = `(SELECT json_group_array(json_object('actorId',x.actor_id,'userId',x.user_id,'kind',x.actor_kind,'role',x.role)) FROM (SELECT actor_id,user_id,actor_kind,role FROM collaboration_memberships WHERE tenant_id='self-hosted' AND workspace_id=? AND room_id=? AND status='active' AND EXISTS(SELECT 1 FROM json_each(capabilities_json) WHERE value='room.read') ORDER BY actor_id) x)`;
function fail(code = "slack_coworker_authority_changed", status = 403): never {
  throw new SlackInstallationError(code, status);
}
async function digest(value: unknown) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
async function schema(env: Env) {
  await env.AGENT_AUDIT.prepare(
    `CREATE TABLE IF NOT EXISTS slack_coworker_execution_receipts (handoff_id TEXT PRIMARY KEY,draft_id TEXT NOT NULL UNIQUE,workspace_id TEXT NOT NULL,account_id TEXT NOT NULL,member_json TEXT NOT NULL,selection_json TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL)`,
  ).run();
  await env.AGENT_AUDIT.prepare(
    `CREATE TABLE IF NOT EXISTS slack_coworker_execution_v2 (id TEXT PRIMARY KEY,request_id TEXT NOT NULL,draft_id TEXT NOT NULL,handoff_id TEXT NOT NULL,workspace_id TEXT NOT NULL,account_id TEXT NOT NULL,member_json TEXT NOT NULL,scope_json TEXT NOT NULL,preview_json TEXT NOT NULL,digest TEXT NOT NULL,audience_json TEXT NOT NULL,profile_json TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,session_id TEXT NOT NULL,session_expires_at INTEGER NOT NULL,frozen_task_hash TEXT,approval_id TEXT,UNIQUE(workspace_id,account_id,request_id))`,
  ).run();
  await env.AGENT_AUDIT.prepare(
    `CREATE UNIQUE INDEX IF NOT EXISTS slack_coworker_execution_v2_claim ON slack_coworker_execution_v2(handoff_id) WHERE state<>'preview'`,
  ).run();
}
function sessionGuard(member: WorkspaceNativeMember, session: SlackCoworkerSession) {
  return {
    sql: `EXISTS(SELECT 1 FROM "session" s WHERE s.id=? AND s.userId=? AND CASE WHEN typeof(s.expiresAt) IN ('integer','real') THEN s.expiresAt ELSE CAST((julianday(s.expiresAt)-2440587.5)*86400000 AS INTEGER) END>${nowSql}) AND ?>${nowSql}`,
    values: [session.id, member.accountId, session.expiresAt],
  };
}
function parsed(row: Row) {
  return JSON.parse(row.preview_json) as SlackCoworkerPreview;
}
async function current(env: Env, row: Row, withSession?: SlackCoworkerSession): Promise<boolean> {
  try {
    if (env.SLACK_INSTALLATIONS_ENABLED?.trim() !== "true") return false;
    const m = JSON.parse(row.member_json) as WorkspaceNativeMember,
      p = parsed(row),
      scope = JSON.parse(row.scope_json) as PersonalPairingScope;
    if (
      m.accountId !== row.account_id ||
      m.workspaceId !== row.workspace_id ||
      p.previewId !== row.id ||
      p.draftId !== row.draft_id ||
      p.digest !== row.digest ||
      p.workspaceId !== m.workspaceId ||
      p.actorId !== m.userId ||
      (await digest({ ...p, digest: "" })) !== row.digest
    )
      return false;
    if (
      !(await personalGrantFence(env, scope, p.personalExecution)) ||
      !(await canReadCollaborationRoom(
        env,
        { tenantId: "self-hosted", workspaceId: m.workspaceId, roomId: p.roomId },
        m.userId,
      ))
    )
      return false;
    const d = slackCoworkerDraftGuard(m),
      session = withSession ? sessionGuard(m, withSession) : { sql: "1=1", values: [] };
    const check =
      await env.AGENT_AUDIT.prepare(`SELECT 1 FROM slack_coworker_drafts d WHERE d.id=? AND d.text=? AND ${d.sql} AND ${session.sql} AND ${audienceSql}=?
    AND EXISTS(SELECT 1 FROM collaboration_rooms WHERE tenant_id='self-hosted' AND workspace_id=? AND room_id=? AND title=?)
    AND EXISTS(SELECT 1 FROM collaboration_memberships WHERE tenant_id='self-hosted' AND workspace_id=? AND room_id=? AND actor_id=? AND actor_kind='human' AND user_id=? AND status='active' AND EXISTS(SELECT 1 FROM json_each(capabilities_json) WHERE value='handoff.create'))
    AND EXISTS(SELECT 1 FROM collaboration_memberships WHERE tenant_id='self-hosted' AND workspace_id=? AND room_id=? AND actor_id=? AND actor_kind='agent' AND status='active' AND profile_version=?)
    AND EXISTS(SELECT 1 FROM org_custom_agents a JOIN org_custom_agent_versions v ON v.org_id=a.org_id AND v.agent_id=a.id WHERE a.org_id=? AND a.id=? AND a.deleted_at IS NULL AND a.archived_at IS NULL AND a.version=? AND v.version=? AND v.config_json=?)
    AND EXISTS(SELECT 1 FROM personal_execution_grants pg WHERE pg.grant_id=? AND pg.owner_account_id=? AND pg.workspace_id=? AND pg.status='active' AND pg.version=? AND pg.snapshot_json=? AND pg.scope_json=? AND pg.expires_at>${nowSql})
    AND EXISTS(SELECT 1 FROM slack_coworker_execution_v2 v WHERE v.id=? AND v.state=? AND v.preview_json=? AND v.digest=? AND v.member_json=? AND v.scope_json=? AND v.audience_json=? AND v.profile_json=? AND v.approval_id IS ? AND v.frozen_task_hash IS ?)
    AND (? IN ('preview','dispatching') OR EXISTS(SELECT 1 FROM collaboration_handoffs h WHERE h.tenant_id='self-hosted' AND h.workspace_id=? AND h.handoff_id=? AND h.room_id=? AND h.status='active' AND h.sender_user_id=? AND h.sender_actor_id=? AND h.recipient_actor_id=? AND h.recipient_user_id=? AND h.profile_version=? AND h.parent_handoff_id IS NULL AND h.root_handoff_id=? AND h.approval_id IS ?))`)
        .bind(
          row.draft_id,
          p.task,
          ...d.values,
          ...session.values,
          m.workspaceId,
          p.roomId,
          row.audience_json,
          m.workspaceId,
          p.roomId,
          p.roomTitle,
          m.workspaceId,
          p.roomId,
          humanActorId(m.userId),
          m.userId,
          m.workspaceId,
          p.roomId,
          p.recipientActorId,
          p.employeeVersion,
          collaborationEmployeeOrgId({ workspaceId: m.workspaceId }),
          p.recipientActorId.slice(6),
          p.employeeVersion,
          p.employeeVersion,
          row.profile_json,
          p.personalExecution.grantId,
          m.accountId,
          m.workspaceId,
          p.personalExecution.grantVersion,
          JSON.stringify(p.personalExecution),
          row.scope_json,
          row.id,
          row.state,
          row.preview_json,
          row.digest,
          row.member_json,
          row.scope_json,
          row.audience_json,
          row.profile_json,
          row.approval_id,
          row.frozen_task_hash,
          row.state,
          m.workspaceId,
          row.handoff_id,
          p.roomId,
          m.userId,
          humanActorId(m.userId),
          p.recipientActorId,
          p.roomAudience.find((r) => r.actorId === p.recipientActorId && r.kind === "agent")
            ?.userId ?? "",
          p.employeeVersion,
          row.handoff_id,
          row.approval_id,
        )
        .first();
    return Boolean(check);
  } catch {
    return false;
  }
}
export async function prepareSlackCoworkerSubmission(
  env: Env,
  request: Request,
  member: WorkspaceNativeMember,
  session: SlackCoworkerSession,
  input: SlackCoworkerPrepare,
): Promise<SlackCoworkerPreview> {
  await schema(env);
  if ((env.INTERNAL_SIGNING_KEY?.trim().length ?? 0) < 32)
    fail("slack_coworker_signing_unavailable", 503);
  const scope = await resolvePersonalExecutionOwner(request, env);
  if (
    !scope ||
    scope.ownerAccountId !== member.accountId ||
    scope.actorId !== member.userId ||
    scope.workspaceId !== member.workspaceId
  )
    fail();
  const grant = await resolvePersonalExecutionGrant(env, scope, input.personalExecution.grantId);
  if (!grant || grant.grantVersion !== input.personalExecution.expectedVersion) fail();
  const cs = { tenantId: "self-hosted", workspaceId: member.workspaceId, userId: member.userId };
  const [room, sender, recipient] = await Promise.all([
    getCollaborationRoom(env, cs, input.roomId),
    getCollaborationMembership(env, cs, input.roomId, humanActorId(member.userId)),
    getActiveCollaborationMembership(env, cs, input.roomId, input.recipientActorId),
  ]);
  if (
    !room ||
    !sender ||
    sender.status !== "active" ||
    !sender.capabilities.includes("handoff.create") ||
    !recipient ||
    recipient.actorKind !== "agent" ||
    !recipient.profileVersion ||
    !(await canReadCollaborationRoom(env, { ...cs, roomId: input.roomId }, member.userId))
  )
    fail();
  const profile = await getCustomAgentVersion(
    env,
    collaborationEmployeeOrgId(cs),
    input.recipientActorId.slice(6),
    recipient.profileVersion,
  );
  if (!profile || profile.config.toolScopes?.length) fail();
  const pRow = await env.AGENT_AUDIT.prepare(
    "SELECT config_json FROM org_custom_agent_versions WHERE org_id=? AND agent_id=? AND version=?",
  )
    .bind(collaborationEmployeeOrgId(cs), profile.id, profile.version)
    .first<{ config_json: string }>();
  if (!pRow) fail();
  const g = slackCoworkerDraftGuard(member),
    d = await env.AGENT_AUDIT.prepare(
      `SELECT d.text,g.expires_at AS expires FROM slack_coworker_drafts d JOIN slack_coworker_intake_grants g ON g.id=d.grant_id WHERE d.id=? AND ${g.sql}`,
    )
      .bind(input.id, ...g.values)
      .first<{ text: string; expires: number }>();
  if (!d) fail();
  const audience = await env.AGENT_AUDIT.prepare(`SELECT ${audienceSql} AS value`)
    .bind(member.workspaceId, input.roomId)
    .first<{ value: string }>();
  if (!audience) fail();
  const readers = JSON.parse(audience.value) as SlackCoworkerPreview["roomAudience"];
  if (
    !Array.isArray(readers) ||
    readers.length < 1 ||
    readers.length > 50 ||
    !readers.some(
      (r) =>
        r.actorId === input.recipientActorId && r.userId === recipient.userId && r.kind === "agent",
    )
  )
    fail();
  const now = Date.now(),
    expiresAt = Math.min(now + 900_000, d.expires, grant.expiresAt, session.expiresAt);
  if (expiresAt <= now) fail();
  const existing = await env.AGENT_AUDIT.prepare(
    "SELECT * FROM slack_coworker_execution_v2 WHERE workspace_id=? AND account_id=? AND request_id=?",
  )
    .bind(member.workspaceId, member.accountId, input.requestId)
    .first<Row>();
  if (existing) {
    const p = parsed(existing);
    if (
      p.draftId !== input.id ||
      p.roomId !== input.roomId ||
      p.recipientActorId !== input.recipientActorId ||
      p.personalExecution.grantId !== input.personalExecution.grantId ||
      p.personalExecution.grantVersion !== input.personalExecution.expectedVersion ||
      existing.state !== "preview" ||
      existing.expires_at <= Date.now() ||
      !(await current(env, existing, session))
    )
      fail("slack_coworker_request_conflict", 409);
    return p;
  }
  const preview: SlackCoworkerPreview = {
    previewId: `scp_${crypto.randomUUID().replaceAll("-", "")}`,
    draftId: input.id,
    digest: "",
    workspaceId: member.workspaceId,
    actorId: member.userId,
    task: d.text,
    roomId: input.roomId,
    roomTitle: room.title,
    recipientActorId: input.recipientActorId,
    employeeName: profile.config.name,
    employeeVersion: profile.version,
    personalExecution: grant,
    privateStatus: await (
      await import("./slack-coworker-private-status.js")
    ).describeSlackCoworkerPrivateStatus(env, member, input.id, grant.expiresAt),
    roomAudience: readers,
    createdAt: now,
    expiresAt,
    consent: PURPOSE,
  };
  preview.digest = await digest(preview);
  const sg = sessionGuard(member, session);
  const result =
    await env.AGENT_AUDIT.prepare(`INSERT INTO slack_coworker_execution_v2(id,request_id,draft_id,handoff_id,workspace_id,account_id,member_json,scope_json,preview_json,digest,audience_json,profile_json,state,created_at,expires_at,session_id,session_expires_at)
 SELECT ?,?,?,?,?,?,?,?,?,?,?,?,'preview',?,?,?,? WHERE ${sg.sql} AND EXISTS(SELECT 1 FROM slack_coworker_drafts d WHERE d.id=? AND d.text=? AND ${g.sql}) AND ${audienceSql}=?
 AND NOT EXISTS(SELECT 1 FROM slack_coworker_execution_receipts WHERE draft_id=?) AND NOT EXISTS(SELECT 1 FROM slack_coworker_execution_v2 WHERE draft_id=? AND state<>'preview')
 AND (SELECT count(*) FROM slack_coworker_execution_v2 WHERE account_id=?)<1000 AND (SELECT count(*) FROM slack_coworker_execution_v2 WHERE account_id=? AND state='preview' AND expires_at>${nowSql})<16`)
      .bind(
        preview.previewId,
        input.requestId,
        input.id,
        `scx_${input.id.slice(3)}`,
        member.workspaceId,
        member.accountId,
        JSON.stringify(member),
        JSON.stringify(scope),
        JSON.stringify(preview),
        preview.digest,
        audience.value,
        pRow.config_json,
        now,
        expiresAt,
        session.id,
        session.expiresAt,
        ...sg.values,
        input.id,
        d.text,
        ...g.values,
        member.workspaceId,
        input.roomId,
        audience.value,
        input.id,
        input.id,
        member.accountId,
        member.accountId,
      )
      .run();
  if (result.meta.changes !== 1) fail("slack_coworker_preview_unavailable", 409);
  const saved = await env.AGENT_AUDIT.prepare(
    "SELECT * FROM slack_coworker_execution_v2 WHERE id=?",
  )
    .bind(preview.previewId)
    .first<Row>();
  if (!saved || !(await current(env, saved, session))) fail();
  return preview;
}
async function mac(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
function bodyFor(row: Row) {
  const p = parsed(row);
  return {
    handoffId: row.handoff_id,
    taskId: row.handoff_id,
    task: p.task,
    recipientActorId: p.recipientActorId,
    personalExecution: {
      grantId: p.personalExecution.grantId,
      expectedVersion: p.personalExecution.grantVersion,
    },
    budget: 0,
    grantedCapabilities: ["room.read", "message.send"],
  };
}
async function proofValue(secret: string, row: Row, body: unknown) {
  return mac(
    secret,
    JSON.stringify([
      "shiba:slack-coworker-submission:v2",
      row.id,
      row.account_id,
      row.workspace_id,
      row.session_id,
      row.session_expires_at,
      row.expires_at,
      body,
    ]),
  );
}
export async function claimSlackCoworkerSubmission(
  env: Env,
  request: Request,
  member: WorkspaceNativeMember,
  session: SlackCoworkerSession,
  input: SlackCoworkerSubmit,
): Promise<{ handoffId: string; request: Request }> {
  await schema(env);
  const secret = env.INTERNAL_SIGNING_KEY?.trim();
  if (!secret || secret.length < 32) fail("slack_coworker_signing_unavailable", 503);
  if (input.reviewed !== true || input.audienceConsent !== PURPOSE) fail();
  const row = await env.AGENT_AUDIT.prepare(
    "SELECT * FROM slack_coworker_execution_v2 WHERE id=? AND workspace_id=? AND account_id=?",
  )
    .bind(input.previewId, member.workspaceId, member.accountId)
    .first<Row>();
  if (
    !row ||
    row.digest !== input.digest ||
    row.state !== "preview" ||
    row.expires_at <= Date.now() ||
    row.session_id !== session.id ||
    row.session_expires_at !== session.expiresAt ||
    !(await current(env, row, session))
  )
    fail("slack_coworker_preview_unavailable", 409);
  const sg = sessionGuard(member, session),
    g = slackCoworkerDraftGuard(member),
    p = parsed(row);
  if (input.privateStatusConsent && !p.privateStatus)
    fail("slack_coworker_private_status_unavailable", 409);
  const result =
    await env.AGENT_AUDIT.prepare(`UPDATE slack_coworker_execution_v2 SET state='dispatching' WHERE id=? AND digest=? AND state='preview' AND expires_at>${nowSql} AND ${sg.sql}
 AND EXISTS(SELECT 1 FROM slack_coworker_drafts d WHERE d.id=? AND d.text=? AND ${g.sql}) AND ${audienceSql}=?
 AND NOT EXISTS(SELECT 1 FROM slack_coworker_execution_receipts WHERE draft_id=?)`)
      .bind(
        row.id,
        row.digest,
        ...sg.values,
        row.draft_id,
        p.task,
        ...g.values,
        member.workspaceId,
        p.roomId,
        row.audience_json,
        row.draft_id,
      )
      .run();
  if (result.meta.changes !== 1) fail("slack_coworker_execution_already_submitted", 409);
  if (input.privateStatusConsent)
    await (await import("./slack-coworker-private-status.js")).activateSlackCoworkerPrivateStatus(
      env,
      member,
      p,
      true,
    );
  const body = bodyFor(row),
    headers = new Headers(request.headers);
  headers.set(HEADER, `${row.id}.${await proofValue(secret, row, body)}`);
  headers.set("content-type", "application/json");
  return {
    handoffId: row.handoff_id,
    request: new Request(new URL(`/api/collaboration/rooms/${p.roomId}/handoffs`, request.url), {
      method: "POST",
      headers,
      signal: request.signal,
      body: JSON.stringify(body),
    }),
  };
}
/** Consumes a Worker-only purpose-bound proof before reserving any handoff. */
export async function consumeSlackCoworkerSubmission(
  env: Env,
  request: Request,
  body: Record<string, unknown>,
  workspaceId: string,
  userId: string,
  roomId: string,
): Promise<boolean> {
  try {
    const secret = env.INTERNAL_SIGNING_KEY?.trim(),
      match = /^(scp_[a-f0-9]{32})\.([a-f0-9]{64})$/.exec(request.headers.get(HEADER) ?? "");
    if (!secret || secret.length < 32 || !match) return false;
    await schema(env);
    const row = await env.AGENT_AUDIT.prepare(
      "SELECT * FROM slack_coworker_execution_v2 WHERE id=? AND workspace_id=? AND handoff_id=? AND state='dispatching'",
    )
      .bind(match[1], workspaceId, body.handoffId)
      .first<Row>();
    if (!row || row.expires_at <= Date.now()) return false;
    const p = parsed(row),
      member = JSON.parse(row.member_json) as WorkspaceNativeMember,
      session = { id: row.session_id, expiresAt: row.session_expires_at };
    if (
      p.actorId !== userId ||
      p.roomId !== roomId ||
      JSON.stringify(body) !== JSON.stringify(bodyFor(row)) ||
      !(await current(env, row, session))
    )
      return false;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const expected = Uint8Array.from(match[2]!.match(/../g)!, (v) => parseInt(v, 16));
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        key,
        expected,
        new TextEncoder().encode(
          JSON.stringify([
            "shiba:slack-coworker-submission:v2",
            row.id,
            row.account_id,
            row.workspace_id,
            row.session_id,
            row.session_expires_at,
            row.expires_at,
            body,
          ]),
        ),
      ))
    )
      return false;
    const sg = sessionGuard(member, session),
      g = slackCoworkerDraftGuard(member);
    const consumed =
      await env.AGENT_AUDIT.prepare(`UPDATE slack_coworker_execution_v2 SET state='queuing' WHERE id=? AND state='dispatching' AND digest=? AND expires_at>${nowSql} AND ${sg.sql}
    AND EXISTS(SELECT 1 FROM slack_coworker_drafts d WHERE d.id=? AND d.text=? AND ${g.sql}) AND ${audienceSql}=?`)
        .bind(
          row.id,
          row.digest,
          ...sg.values,
          row.draft_id,
          p.task,
          ...g.values,
          workspaceId,
          roomId,
          row.audience_json,
        )
        .run();
    return consumed.meta.changes === 1;
  } catch {
    return false;
  }
}
/** Bind the actual orchestrator-frozen task before linking the handoff to an approval. */
export async function bindSlackCoworkerApproval(
  env: Env,
  handoffId: string,
  approvalId: string,
  task: unknown,
): Promise<boolean> {
  if (!handoffId.startsWith("scx_")) return true;
  try {
    const row = await env.AGENT_AUDIT.prepare(
      "SELECT * FROM slack_coworker_execution_v2 WHERE handoff_id=? AND state='queuing'",
    )
      .bind(handoffId)
      .first<Row>();
    if (!row || typeof task !== "string" || !(await current(env, row))) return false;
    const profile = JSON.parse(row.profile_json) as { instructions?: unknown },
      instructions = typeof profile.instructions === "string" ? profile.instructions : "";
    const exactTask = composeCustomAgentTask(parsed(row).task.trim(), instructions);
    if (task !== exactTask) return false;
    const saved = await env.AGENT_AUDIT.prepare(
      "UPDATE slack_coworker_execution_v2 SET frozen_task_hash=?,approval_id=? WHERE handoff_id=? AND state='queuing' AND frozen_task_hash IS NULL AND approval_id IS NULL",
    )
      .bind(await digest(task), approvalId, handoffId)
      .run();
    return saved.meta.changes === 1;
  } catch {
    return false;
  }
}
export async function isSlackCoworkerV2Current(
  env: Env,
  handoffId: string,
  scope: { workspaceId: string; userId: string },
  roomId: string,
  task?: string,
  approvalId?: string,
  personalExecution?: unknown,
): Promise<boolean> {
  try {
    const row = await env.AGENT_AUDIT.prepare(
      "SELECT * FROM slack_coworker_execution_v2 WHERE handoff_id=? AND workspace_id=? AND state IN ('queuing','queued')",
    )
      .bind(handoffId, scope.workspaceId)
      .first<Row>();
    if (!row) return false;
    const p = parsed(row);
    if (p.actorId !== scope.userId || p.roomId !== roomId || !(await current(env, row)))
      return false;
    const h = await env.AGENT_AUDIT.prepare(
      "SELECT * FROM collaboration_handoffs WHERE tenant_id='self-hosted' AND workspace_id=? AND handoff_id=?",
    )
      .bind(scope.workspaceId, handoffId)
      .first<Record<string, unknown>>();
    if (
      !h ||
      h.status !== "active" ||
      h.room_id !== roomId ||
      h.sender_user_id !== scope.userId ||
      h.sender_actor_id !== humanActorId(scope.userId) ||
      h.recipient_actor_id !== p.recipientActorId ||
      !p.roomAudience.some(
        (r) =>
          r.actorId === p.recipientActorId &&
          r.kind === "agent" &&
          r.userId === h.recipient_user_id,
      ) ||
      h.profile_version !== p.employeeVersion ||
      h.parent_handoff_id !== null ||
      h.root_handoff_id !== handoffId
    )
      return false;
    if ((approvalId !== undefined || h.approval_id !== null) && row.state !== "queued")
      return false;
    if (h.approval_id !== null && (h.approval_id !== row.approval_id || !row.frozen_task_hash))
      return false;
    if (
      approvalId !== undefined &&
      (row.approval_id !== approvalId || h.approval_id !== approvalId || !row.frozen_task_hash)
    )
      return false;
    if (
      personalExecution !== undefined &&
      JSON.stringify(personalExecution) !== JSON.stringify(p.personalExecution)
    )
      return false;
    if (task !== undefined) {
      if (
        row.frozen_task_hash
          ? (await digest(task)) !== row.frozen_task_hash
          : task !== p.task.trim()
      )
        return false;
    }
    return await current(env, row);
  } catch {
    return false;
  }
}
export async function finishSlackCoworkerSubmission(
  env: Env,
  handoffId: string,
  state: "queued" | "blocked" | "unknown",
) {
  await env.AGENT_AUDIT.prepare(
    "UPDATE slack_coworker_execution_v2 SET state=? WHERE handoff_id=? AND state IN ('dispatching','queuing')",
  )
    .bind(state, handoffId)
    .run();
}
async function recoverExpiredSubmissions(
  env: Env,
  member: WorkspaceNativeMember,
  session: SlackCoworkerSession,
) {
  const sg = sessionGuard(member, session),
    mg = membershipSql(member);
  await env.AGENT_AUDIT.prepare(
    `UPDATE slack_coworker_execution_v2 SET state='unknown' WHERE workspace_id=? AND account_id=? AND state IN ('dispatching','queuing') AND expires_at<=${nowSql} AND ${sg.sql} AND ${mg.sql}`,
  )
    .bind(member.workspaceId, member.accountId, ...sg.values, ...mg.values)
    .run();
}
export async function readSlackCoworkerSubmission(
  env: Env,
  member: WorkspaceNativeMember,
  session: SlackCoworkerSession,
  draftId: string,
) {
  await schema(env);
  await recoverExpiredSubmissions(env, member, session);
  const row = await env.AGENT_AUDIT.prepare(
    "SELECT * FROM slack_coworker_execution_v2 WHERE draft_id=? AND workspace_id=? AND account_id=? ORDER BY CASE WHEN state='preview' THEN 1 ELSE 0 END,created_at DESC LIMIT 1",
  )
    .bind(draftId, member.workspaceId, member.accountId)
    .first<Row>();
  if (!row) return { preview: null, receipt: null, sourceAvailable: false };
  const privateStatusState = await (
    await import("./slack-coworker-private-status.js")
  ).readSlackCoworkerPrivateStatus(env, member, row.id);
  const available = await current(env, row, session),
    p = parsed(row),
    pending = row.state === "preview";
  if (!available) {
    const sg = sessionGuard(member, session),
      mg = membershipSql(member);
    if (
      !(await env.AGENT_AUDIT.prepare(
        `SELECT 1 FROM slack_coworker_execution_v2 WHERE id=? AND workspace_id=? AND account_id=? AND state=? AND preview_json=? AND ${sg.sql} AND ${mg.sql}`,
      )
        .bind(
          row.id,
          member.workspaceId,
          member.accountId,
          row.state,
          row.preview_json,
          ...sg.values,
          ...mg.values,
        )
        .first())
    )
      fail();
  }
  return {
    preview: pending && row.expires_at > Date.now() && available ? p : null,
    receipt: pending
      ? null
      : {
          previewId: row.id,
          draftId: row.draft_id,
          roomId: p.roomId,
          handoffId: row.handoff_id,
          state: row.state as "dispatching" | "queuing" | "queued" | "blocked" | "unknown",
          approvalRequired: true as const,
          ...(privateStatusState ? { privateStatusState } : {}),
        },
    sourceAvailable: available,
  };
}
export async function listSlackCoworkerSubmissions(
  env: Env,
  member: WorkspaceNativeMember,
  session: SlackCoworkerSession,
) {
  await schema(env);
  await recoverExpiredSubmissions(env, member, session);
  const sg = sessionGuard(member, session),
    mg = membershipSql(member);
  const rows = await env.AGENT_AUDIT.prepare(
    `SELECT * FROM slack_coworker_execution_v2 WHERE workspace_id=? AND account_id=? AND state<>'preview' AND ${sg.sql} AND ${mg.sql} ORDER BY created_at DESC LIMIT 100`,
  )
    .bind(member.workspaceId, member.accountId, ...sg.values, ...mg.values)
    .all<Row>();
  return rows.results.map((row) => {
    const p = parsed(row);
    return {
      previewId: row.id,
      draftId: row.draft_id,
      roomId: p.roomId,
      handoffId: row.handoff_id,
      state: row.state as "dispatching" | "queuing" | "queued" | "blocked" | "unknown",
      approvalRequired: true as const,
    };
  });
}
