import {
  REPORT_SLACK_DISCLOSURE_SCOPE, REPORT_SLACK_MAX_BYTES, REPORT_SLACK_TTL_MS, founderSkillIdSchema, reportSlackDestinationSchema, reportSlackDisclosureSchema,
  type ReportSlackDecision, type ReportSlackDisclosure, type ReportSlackDestination, type ReportSlackIntent, type ReportSlackPrepare, type ReportSlackState,
} from "@shiba/shared";
import type { Env } from "./env.js";
import type { WorkspaceNativeMember } from "./workspace-native-authority.js";
import { membershipSql, assertWorkspaceMemberCurrent, insertGuarded, WorkspaceIntegrationError } from "./workspace-integrations-store.js";
import { ensureCollaborationSchema } from "./collaboration-store.js";
import { ensureTeamWorkspacesSchema } from "./team-workspaces-store.js";
import { parseSlackCanvasOwners } from "./slack-canvas.js";
import { isApprover, parseApproverAllowlist } from "./slack-approval.js";
import { SlackPostRejectedError, verifySlackBotInstallation } from "./slack.js";
import { redactSecrets } from "./security.js";
import { hashToolArgs } from "./mcp-gateway.js";
import { REPORT_SLACK_SCHEMA } from "./report-slack-schema.js";
import { postReportSlackMessage } from "./report-slack-sender.js";
import { loadFounderEvidenceReport, founderEvidenceReportGuard, type FounderEvidenceAuthority } from "./founder-evidence-reports.js";
import { activeSlackInstallationForTeam, ensureSlackInstallations, readSlackInstallationCredential, slackInstallationGuard, slackOAuthConfiguration } from "./slack-installations-store.js";
import { verifySlackInstallationBot } from "./slack-installations-oauth.js";

interface Row {
  id: string; workspace_id: string; library_id: string; report_id: string; creator_id: string; creator_account_id: string;
  creator_member_json: string; request_id: string; input_hash: string; digest: string; disclosure_scope: string; report_hash: string; source_hash: string;
  source_json: string; content: string; content_hash: string; room_id: string; link_id: string; destination_json: string;
  audience_json: string; policy_json: string; link_created_at: number; state: Exclude<ReportSlackIntent["status"], "expired">;
  created_at: number; expires_at: number; disclosed_at: number | null; approver_json: string | null; receipt_ts: string | null; error_code: string | null;
}
interface LinkSnapshot {
  destination: ReportSlackDestination; audienceJson: string; policyJson: string; createdAt: number;
}
export interface ReportSlackDeps {
  verifyInstallation?: typeof verifySlackBotInstallation;
  postMessage?: typeof postReportSlackMessage;
}
type SessionFence = () => Promise<void>;
interface Guard { sql: string; values: unknown[] }
const initialized = new WeakSet<D1Database>();
const nowSql = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
const audienceSql = `(SELECT json_group_array(json_object('actorId',a.actor_id,'userId',a.user_id,'kind',a.actor_kind,'role',a.role,'capabilities',a.capabilities_json,'profileVersion',a.profile_version,'createdAt',a.created_at))
  FROM (SELECT * FROM collaboration_memberships WHERE tenant_id=l.tenant_id AND workspace_id=l.workspace_id AND room_id=l.room_id AND status='active'
    AND EXISTS(SELECT 1 FROM json_each(capabilities_json) WHERE value='room.read') ORDER BY actor_id) a)`;
function fail(code: string, status = 409): never { throw new WorkspaceIntegrationError(code, status); }
const ownerOf = (row: Row) => JSON.parse(row.creator_member_json) as WorkspaceNativeMember;
const destinationOf = (row: Row) => reportSlackDestinationSchema.parse(JSON.parse(row.destination_json));
/** Pack only trusted, fixed predicates to stay below D1's bound-parameter limit. */
function packed(guard: Guard): Guard {
  let index = 0;
  const sql = guard.sql.replaceAll("?", () => `json_extract(rsg.value,'$[${index++}]')`);
  if (index !== guard.values.length) fail("report_slack_guard_invalid", 503);
  return { sql: `EXISTS(SELECT 1 FROM json_each(?) rsg WHERE ${sql})`, values: [JSON.stringify([guard.values])] };
}
function configured(env: Env): boolean {
  let tokenAvailable = Boolean(env.SLACK_BOT_TOKEN?.trim());
  const managed = env.SLACK_INSTALLATIONS_ENABLED?.trim() === "true";
  if (managed) { try { slackOAuthConfiguration(env); tokenAvailable = true; } catch { tokenAvailable = false; } }
  return env.SLACK_ROOM_OUTBOX_ENABLED?.trim() === "true" && tokenAvailable && (managed || Boolean(env.SLACK_APPROVALS_CHANNEL?.trim())) &&
    parseApproverAllowlist(env.DASHBOARD_APPROVERS).length > 0 && parseSlackCanvasOwners(env.SLACK_CANVAS_OWNERS).length > 0;
}
function approver(env: Env, member: WorkspaceNativeMember): boolean { return member.role !== "member" && isApprover(member.userId, parseApproverAllowlist(env.DASHBOARD_APPROVERS)); }
export async function ensureReportSlackSchema(env: Env): Promise<void> {
  if (!env.AGENT_AUDIT) fail("report_slack_storage_unavailable", 503);
  if (initialized.has(env.AGENT_AUDIT)) return;
  await ensureCollaborationSchema(env); await ensureTeamWorkspacesSchema(env); await ensureSlackInstallations(env);
  for (const sql of REPORT_SLACK_SCHEMA) await env.AGENT_AUDIT.prepare(sql).run();
  initialized.add(env.AGENT_AUDIT);
}
function policyFor(env: Env, destination: ReportSlackDestination) {
  return parseSlackCanvasOwners(env.SLACK_CANVAS_OWNERS).find((policy) => policy.teamId === destination.teamId && policy.channelId === destination.channelId && policy.ownerId === destination.ownerId);
}
function installationGuard(env: Env, owner: WorkspaceNativeMember, destination: ReportSlackDestination): Guard {
  const snapshot = destination.installation;
  if (snapshot) {
    if (env.SLACK_INSTALLATIONS_ENABLED?.trim() !== "true" || snapshot.workspaceId !== owner.workspaceId || snapshot.ownerAccountId !== owner.accountId || snapshot.teamId !== destination.teamId || snapshot.appId !== env.SLACK_OAUTH_APP_ID || !snapshot.scopes.includes("chat:write")) return { sql: "0=1", values: [] };
    return slackInstallationGuard(snapshot);
  }
  if (env.SLACK_INSTALLATIONS_ENABLED?.trim() !== "true") return { sql: "NOT EXISTS(SELECT 1 FROM slack_installations WHERE team_id=?) AND NOT EXISTS(SELECT 1 FROM slack_installation_revocations WHERE team_id=?)", values: [destination.teamId, destination.teamId] };
  if (env.SLACK_LEGACY_MODE_ENABLED?.trim() !== "true" || env.SLACK_LEGACY_TEAM_ID !== destination.teamId || env.SLACK_LEGACY_APP_ID !== env.SLACK_OAUTH_APP_ID || !env.SLACK_BOT_TOKEN?.trim()) return { sql: "0=1", values: [] };
  return { sql: "NOT EXISTS(SELECT 1 FROM slack_installations WHERE app_id=? AND team_id=?) AND NOT EXISTS(SELECT 1 FROM slack_installation_revocations WHERE app_id=? AND team_id=?)", values: [env.SLACK_OAUTH_APP_ID, destination.teamId, env.SLACK_OAUTH_APP_ID, destination.teamId] };
}
/** Literal SQL and bound values only; no HTTP-supplied predicates. */
function slackGuard(env: Env, owner: WorkspaceNativeMember, snapshot: LinkSnapshot, reader?: WorkspaceNativeMember) {
  const d = snapshot.destination, native = membershipSql(owner, true), human = reader ? membershipSql(reader, true) : null, installation = installationGuard(env, owner, d);
  const policy = policyFor(env, d), policyJson = policy ? JSON.stringify(policy) : "";
  return {
    sql: `${native.sql} AND ?=? AND ?=? AND EXISTS(SELECT 1 FROM collaboration_slack_room_links l JOIN collaboration_rooms r ON r.room_id=l.room_id AND r.tenant_id=l.tenant_id AND r.workspace_id=l.workspace_id
      WHERE l.tenant_id='self-hosted' AND l.workspace_id=? AND l.room_id=? AND l.link_id=? AND l.owner_user_id=? AND l.team_id=? AND l.channel_id=? AND l.thread_ts=? AND l.created_at=? AND l.status='active' AND r.title=?
      AND ${audienceSql}=?
      AND EXISTS(SELECT 1 FROM collaboration_memberships o WHERE o.tenant_id=l.tenant_id AND o.workspace_id=l.workspace_id AND o.room_id=l.room_id
        AND o.actor_id=? AND o.user_id=? AND o.actor_kind='human' AND o.role='owner' AND o.status='active'
        AND EXISTS(SELECT 1 FROM json_each(o.capabilities_json) WHERE value='room.read')
        AND EXISTS(SELECT 1 FROM json_each(o.capabilities_json) WHERE value='message.send')
        AND EXISTS(SELECT 1 FROM json_each(o.capabilities_json) WHERE value='membership.manage'))
      AND NOT EXISTS(SELECT 1 FROM collaboration_memberships m WHERE m.tenant_id=l.tenant_id AND m.workspace_id=l.workspace_id AND m.room_id=l.room_id AND m.status='active'
        AND EXISTS(SELECT 1 FROM json_each(m.capabilities_json) WHERE value='room.read')
        AND (NOT EXISTS(SELECT 1 FROM team_workspace_memberships t WHERE t.tenant_id=m.tenant_id AND t.workspace_id=m.workspace_id AND t.user_id=m.user_id AND t.status='active')
          OR (m.user_id<>? AND NOT EXISTS(SELECT 1 FROM json_each(?) WHERE value=m.user_id))))
      ${reader ? `AND EXISTS(SELECT 1 FROM collaboration_memberships v WHERE v.tenant_id=l.tenant_id AND v.workspace_id=l.workspace_id AND v.room_id=l.room_id AND v.actor_id=? AND v.user_id=? AND v.actor_kind='human' AND v.status='active' AND EXISTS(SELECT 1 FROM json_each(v.capabilities_json) WHERE value='room.read'))` : ""})
      ${human ? `AND ${human.sql}` : ""} AND ${installation.sql}`,
    values: [...native.values, policyJson, snapshot.policyJson, d.installation ? d.channelId : env.SLACK_APPROVALS_CHANNEL?.trim() ?? "", d.channelId,
      owner.workspaceId, d.roomId, d.linkId, owner.userId, d.teamId, d.channelId, d.threadTs, snapshot.createdAt, d.roomTitle, snapshot.audienceJson,
      `human:${owner.userId}`, owner.userId, owner.userId, JSON.stringify(policy?.viewerIds ?? []),
      ...(reader ? [`human:${reader.userId}`, reader.userId, ...human!.values] : []), ...installation.values],
  };
}
function snapshotOf(row: Row): LinkSnapshot { return { destination: destinationOf(row), audienceJson: row.audience_json, policyJson: row.policy_json, createdAt: row.link_created_at }; }
async function destinations(env: Env, owner: WorkspaceNativeMember): Promise<LinkSnapshot[]> {
  const rows = await env.AGENT_AUDIT.prepare(`SELECT l.*,r.title,${audienceSql} AS audience_json FROM collaboration_slack_room_links l
    JOIN collaboration_rooms r ON r.room_id=l.room_id AND r.tenant_id=l.tenant_id AND r.workspace_id=l.workspace_id
    WHERE l.tenant_id='self-hosted' AND l.workspace_id=? AND l.owner_user_id=? AND l.status='active' ORDER BY l.room_id,l.link_id LIMIT 50`)
    .bind(owner.workspaceId, owner.userId).all<{ room_id: string; link_id: string; title: string; team_id: string; channel_id: string; thread_ts: string; created_at: number; audience_json: string }>();
  const result: LinkSnapshot[] = [];
  for (const row of rows.results) {
    const audience = JSON.parse(row.audience_json) as { userId: string }[];
    const d = reportSlackDestinationSchema.safeParse({ roomId: row.room_id, roomTitle: row.title, linkId: row.link_id, teamId: row.team_id, channelId: row.channel_id,
      threadTs: row.thread_ts, ownerId: owner.userId, roomAudienceIds: [...new Set(audience.map((item) => item.userId))].sort() });
    if (!d.success) continue;
    const policy = policyFor(env, d.data); if (!policy) continue;
    const destination = d.data;
    if (env.SLACK_INSTALLATIONS_ENABLED?.trim() === "true") {
      const installation = await activeSlackInstallationForTeam(env, env.SLACK_OAUTH_APP_ID ?? "", destination.teamId);
      if (installation) destination.installation = installation;
    }
    const snapshot = { destination, audienceJson: row.audience_json, policyJson: JSON.stringify(policy), createdAt: row.created_at };
    const guard = slackGuard(env, owner, snapshot);
    if (await env.AGENT_AUDIT.prepare(`SELECT 1 AS current WHERE ${guard.sql}`).bind(...guard.values).first()) result.push(snapshot);
  }
  return result;
}
export function neutralizeReportSlackText(markdown: string): string {
  const raw = `Stored app receipt excerpts. Completeness and business success are unverified.\n\n${markdown}`;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Refuse hidden control bytes in externally delivered data.
  if (!markdown.trim() || /[\x00-\x08\x0b-\x1f\x7f]/.test(raw) || redactSecrets(raw) !== raw) fail("report_slack_content_unreviewable", 400);
  const rendered = raw.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  if (new TextEncoder().encode(rendered).length > REPORT_SLACK_MAX_BYTES) fail("report_slack_content_too_large", 413);
  return rendered;
}
async function textHash(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function boundReport(env: Env, row: Row): Promise<FounderEvidenceAuthority> {
  if (row.disclosure_scope !== REPORT_SLACK_DISCLOSURE_SCOPE) fail("report_slack_disclosure_scope_changed", 403);
  const loaded = await loadFounderEvidenceReport(env, ownerOf(row), row.library_id, row.report_id, { requireExportOwnership: true });
  const authority = loaded.authority;
  if (authority.reportHash !== row.report_hash || authority.authorityJson !== row.source_json || await hashToolArgs(authority.authorityJson) !== row.source_hash ||
    await textHash(row.content) !== row.content_hash || neutralizeReportSlackText(authority.markdown) !== row.content || row.expires_at > authority.expiresAt) fail("report_slack_report_changed", 403);
  return authority;
}
function finalGuard(env: Env, row: Row, authority: FounderEvidenceAuthority, reader?: WorkspaceNativeMember) {
  const source = founderEvidenceReportGuard(authority, { requireExportOwnership: true }), slack = slackGuard(env, ownerOf(row), snapshotOf(row), reader);
  return packed({ sql: `${source.sql} AND ${slack.sql} AND ?>${nowSql}`, values: [...source.values, ...slack.values, row.expires_at] });
}
async function find(env: Env, member: WorkspaceNativeMember, libraryId: string, reportId: string, id: string): Promise<Row> {
  const row = await env.AGENT_AUDIT.prepare("SELECT * FROM report_slack_deliveries WHERE id=? AND workspace_id=? AND library_id=? AND report_id=?")
    .bind(id, member.workspaceId, libraryId, reportId).first<Row>();
  if (!row || row.creator_account_id !== member.accountId && (row.state === "draft" || !approver(env, member))) fail("report_slack_unavailable", 404);
  return row;
}
function exact(row: Row, input: ReportSlackDecision) {
  if (input.expectedVersion !== 1 || input.reviewed !== true || input.digest !== row.digest || input.contentHash !== row.content_hash || input.expiresAt !== row.expires_at) fail("report_slack_review_changed");
}
function view(row: Row, member: WorkspaceNativeMember, current: boolean, canApprove: boolean): ReportSlackIntent {
  const terminal = !["draft", "disclosed"].includes(row.state), active = current && row.expires_at > Date.now();
  return { id: row.id, version: 1, digest: row.digest, reportHash: row.report_hash, sourceHash: row.source_hash, disclosureScope: REPORT_SLACK_DISCLOSURE_SCOPE, content: row.content, contentHash: row.content_hash,
    creatorId: row.creator_id, creatorAccountId: row.creator_account_id, destination: destinationOf(row), createdAt: row.created_at, expiresAt: row.expires_at,
    status: !terminal && row.expires_at <= Date.now() ? "expired" : row.state, disclosedAt: row.disclosed_at,
    approvedByUserId: row.approver_json ? (JSON.parse(row.approver_json) as WorkspaceNativeMember).userId : null,
    receiptTs: row.receipt_ts, errorCode: row.error_code, canDisclose: active && row.state === "draft" && row.creator_account_id === member.accountId,
    canApprove: active && row.state === "disclosed" && canApprove, canCancel: active && !terminal && row.creator_account_id === member.accountId };
}
export async function prepareReportSlack(env: Env, member: WorkspaceNativeMember, libraryId: string, reportId: string, input: ReportSlackPrepare, verifySession: SessionFence): Promise<string> {
  await ensureReportSlackSchema(env); await assertWorkspaceMemberCurrent(env, member, true);
  if (!configured(env)) fail("report_slack_not_configured", 503);
  const inputHash = await hashToolArgs({ libraryId, reportId, ...input });
  const previous = await env.AGENT_AUDIT.prepare("SELECT id,input_hash FROM report_slack_deliveries WHERE workspace_id=? AND creator_account_id=? AND request_id=?")
    .bind(member.workspaceId, member.accountId, input.requestId).first<{ id: string; input_hash: string }>();
  if (previous) { if (previous.input_hash !== inputHash) fail("report_slack_request_conflict"); return previous.id; }
  const loaded = await loadFounderEvidenceReport(env, member, libraryId, reportId, { requireExportOwnership: true }), a = loaded.authority;
  if (input.reportHash !== a.reportHash || input.expiresAt <= Date.now() || input.expiresAt > Date.now() + REPORT_SLACK_TTL_MS || input.expiresAt > a.expiresAt) fail("report_slack_report_or_expiry_changed", 409);
  const destination = (await destinations(env, member)).find((item) => item.destination.roomId === input.roomId && item.destination.linkId === input.linkId);
  if (!destination) fail("report_slack_destination_unavailable", 403);
  if (await env.AGENT_AUDIT.prepare("SELECT 1 AS busy FROM report_slack_deliveries WHERE workspace_id=? AND link_id=? AND state IN ('sending','unknown')")
    .bind(member.workspaceId, input.linkId).first()) fail("report_slack_delivery_requires_inspection");
  const content = neutralizeReportSlackText(a.markdown), contentHash = await textHash(content), sourceHash = await hashToolArgs(a.authorityJson), createdAt = Date.now();
  const immutable = { reportId, libraryId, reportHash: a.reportHash, sourceHash, disclosureScope: REPORT_SLACK_DISCLOSURE_SCOPE, creator: member, destination: destination.destination,
    audienceJson: destination.audienceJson, policyJson: destination.policyJson, content, contentHash, expiresAt: input.expiresAt, requestId: input.requestId };
  const row: Row = { id: `rsd_${crypto.randomUUID().replaceAll("-", "")}`, workspace_id: member.workspaceId, library_id: libraryId, report_id: reportId,
    creator_id: member.userId, creator_account_id: member.accountId, creator_member_json: JSON.stringify(member), request_id: input.requestId, input_hash: inputHash,
    digest: await hashToolArgs(immutable), disclosure_scope: REPORT_SLACK_DISCLOSURE_SCOPE, report_hash: a.reportHash, source_hash: sourceHash, source_json: a.authorityJson, content, content_hash: contentHash,
    room_id: input.roomId, link_id: input.linkId, destination_json: JSON.stringify(destination.destination), audience_json: destination.audienceJson,
    policy_json: destination.policyJson, link_created_at: destination.createdAt, state: "draft", created_at: createdAt, expires_at: input.expiresAt,
    disclosed_at: null, approver_json: null, receipt_ts: null, error_code: null };
  await verifySession();
  const guard = finalGuard(env, row, a);
  try {
    const result = await insertGuarded(env, "report_slack_deliveries", { ...row }, { sql: `${guard.sql} AND (SELECT COUNT(*) FROM report_slack_deliveries WHERE workspace_id=? AND creator_account_id=?)<100
      AND NOT EXISTS(SELECT 1 FROM report_slack_deliveries WHERE workspace_id=? AND link_id=? AND state IN ('sending','unknown'))`, values: [...guard.values, member.workspaceId, member.accountId, member.workspaceId, row.link_id] }).run();
    if (result.meta.changes !== 1) fail("report_slack_sources_changed", 403);
  } catch (error) {
    const duplicate = await env.AGENT_AUDIT.prepare("SELECT id,input_hash FROM report_slack_deliveries WHERE workspace_id=? AND creator_account_id=? AND request_id=?")
      .bind(member.workspaceId, member.accountId, input.requestId).first<{ id: string; input_hash: string }>();
    if (duplicate?.input_hash === inputHash) return duplicate.id;
    if (error instanceof WorkspaceIntegrationError) throw error;
    fail("report_slack_delivery_requires_inspection");
  }
  return row.id;
}
export async function discloseReportSlack(env: Env, member: WorkspaceNativeMember, libraryId: string, reportId: string, id: string, input: ReportSlackDisclosure, verifySession: SessionFence): Promise<void> {
  reportSlackDisclosureSchema.parse(input);
  await ensureReportSlackSchema(env); const row = await find(env, member, libraryId, reportId, id); exact(row, input);
  if (row.creator_account_id !== member.accountId || row.state !== "draft" || !configured(env)) fail("report_slack_not_disclosable", 403);
  const authority = await boundReport(env, row); await verifySession(); const guard = finalGuard(env, row, authority);
  const updated = await env.AGENT_AUDIT.prepare(`UPDATE report_slack_deliveries SET state='disclosed',disclosed_at=? WHERE id=? AND state='draft' AND digest=? AND ${guard.sql}`)
    .bind(Date.now(), id, row.digest, ...guard.values).run();
  if (updated.meta.changes !== 1) fail("report_slack_sources_changed", 403);
}
export async function cancelReportSlack(env: Env, member: WorkspaceNativeMember, libraryId: string, reportId: string, id: string, input: ReportSlackDecision, verifySession: SessionFence): Promise<void> {
  await ensureReportSlackSchema(env); const row = await find(env, member, libraryId, reportId, id); exact(row, input);
  if (row.creator_account_id !== member.accountId) fail("report_slack_unavailable", 404);
  await verifySession(); const native = membershipSql(member, true);
  await env.AGENT_AUDIT.prepare(`UPDATE report_slack_deliveries SET state='cancelled' WHERE id=? AND state IN ('draft','disclosed') AND ${native.sql}`).bind(id, ...native.values).run();
}
export async function approveAndSendReportSlack(env: Env, member: WorkspaceNativeMember, libraryId: string, reportId: string, id: string, input: ReportSlackDecision,
  verifySession: SessionFence, deps: ReportSlackDeps = {}): Promise<void> {
  await ensureReportSlackSchema(env); const row = await find(env, member, libraryId, reportId, id); exact(row, input);
  if (!configured(env) || !approver(env, member)) fail("report_slack_human_approver_required", 403);
  if (row.state !== "disclosed") fail("report_slack_not_pending");
  const authority = await boundReport(env, row); await verifySession();
  const guard = finalGuard(env, row, authority, member);
  const claimed = await env.AGENT_AUDIT.prepare(`UPDATE report_slack_deliveries SET state='sending',approver_json=? WHERE id=? AND digest=? AND state='disclosed' AND ${guard.sql}
    AND NOT EXISTS(SELECT 1 FROM report_slack_deliveries other WHERE other.workspace_id=? AND other.link_id=? AND other.id<>? AND other.state IN ('sending','unknown'))`)
    .bind(JSON.stringify(member), id, row.digest, ...guard.values, row.workspace_id, row.link_id, row.id).run();
  if (claimed.meta.changes !== 1) fail("report_slack_sources_changed", 403);
  let state: "sent" | "blocked" | "failed" | "unknown" = "blocked", error = "report_slack_preflight_failed", receipt: string | null = null;
  let dispatched = false;
  try {
    const selected = destinationOf(row).installation;
    const token = selected ? (await readSlackInstallationCredential(env, selected)).token : env.SLACK_BOT_TOKEN?.trim();
    if (!token) fail("report_slack_installation_unavailable", 403);
    const installation = await (deps.verifyInstallation ?? (selected ? verifySlackInstallationBot : verifySlackBotInstallation))(token);
    if (installation.teamId !== destinationOf(row).teamId || !installation.userId || !installation.botId ||
      selected && (installation.userId !== selected.botUserId || installation.botId !== selected.botId)) fail("report_slack_installation_changed", 403);
    const current = await boundReport(env, row); await verifySession();
    if (!configured(env) || !approver(env, member)) fail("report_slack_human_approver_required", 403);
    const last = finalGuard(env, row, current, member);
    if (!await env.AGENT_AUDIT.prepare(`SELECT 1 AS current FROM report_slack_deliveries WHERE id=? AND state='sending' AND digest=? AND approver_json=? AND ${last.sql}`)
      .bind(id, row.digest, JSON.stringify(member), ...last.values).first()) fail("report_slack_sources_changed", 403);
    const destination = destinationOf(row);
    if (!configured(env) || !approver(env, member) || Date.now() >= row.expires_at || Date.now() >= current.expiresAt ||
      selected?.expiresAt !== null && selected?.expiresAt !== undefined && Date.now() >= selected.expiresAt) fail("report_slack_expired_before_send", 403);
    // No asynchronous lookups follow the last authority snapshot. No automatic retry.
    dispatched = true;
    const response = await (deps.postMessage ?? postReportSlackMessage)(token, { channel: destination.channelId, threadTs: destination.threadTs, text: row.content, clientMsgId: row.request_id });
    if (response.channel !== destination.channelId || !/^\d{1,20}\.\d{1,20}$/.test(response.ts)) throw new Error("report_slack_outcome_unknown");
    state = "sent"; error = ""; receipt = response.ts;
  } catch (caught) {
    state = dispatched ? caught instanceof SlackPostRejectedError && caught.outcomeKnown ? "failed" : "unknown" : "blocked";
    error = state === "blocked" ? "report_slack_preflight_failed" : state === "failed" ? "report_slack_rejected" : "report_slack_outcome_unknown";
  }
  const saved = await env.AGENT_AUDIT.prepare("UPDATE report_slack_deliveries SET state=?,receipt_ts=?,error_code=? WHERE id=? AND state='sending'").bind(state, receipt, error || null, id).run();
  if (saved.meta.changes !== 1) fail("report_slack_receipt_unconfirmed", 503);
}
export async function readReportSlack(env: Env, member: WorkspaceNativeMember, libraryId: string, reportId: string, verifySession: SessionFence): Promise<ReportSlackState> {
  await ensureReportSlackSchema(env); await assertWorkspaceMemberCurrent(env, member, true);
  const base = { ok: true as const, workspaceId: member.workspaceId, libraryId: founderSkillIdSchema.parse(libraryId), reportId, actorId: member.userId, available: configured(env), destinations: [] as ReportSlackDestination[], intents: [] as ReportSlackIntent[] };
  let proof: FounderEvidenceAuthority | null = null;
  try { proof = (await loadFounderEvidenceReport(env, member, libraryId, reportId, { requireExportOwnership: true })).authority; } catch { /* Private source is not disclosed by destination discovery. */ }
  const links = proof && configured(env) ? await destinations(env, member) : [];
  const rows = await env.AGENT_AUDIT.prepare("SELECT * FROM report_slack_deliveries WHERE workspace_id=? AND library_id=? AND report_id=? ORDER BY created_at DESC,id DESC LIMIT 5")
    .bind(member.workspaceId, libraryId, reportId).all<Row>();
  const candidates: { row: Row; authority: FounderEvidenceAuthority }[] = [];
  for (const row of rows.results) {
    if (row.creator_account_id !== member.accountId && (row.state === "draft" || !approver(env, member))) continue;
    try { candidates.push({ row, authority: await boundReport(env, row) }); } catch { /* Revoked private report bytes are never cached into public state. */ }
  }
  await verifySession();
  // One final statement fences all cached private rows and destinations together.
  const native = membershipSql(member, true), statements = [`SELECT 'actor' AS kind,'' AS id WHERE ${native.sql}`], values: unknown[] = [...native.values];
  const groups = new Map<string, { kind: string; id: string; values: unknown[]; row?: Row }[]>();
  const add = (guard: Guard, item: { kind: string; id: string; row?: Row }) => {
    const group = groups.get(guard.sql) ?? []; group.push({ ...item, values: guard.values }); groups.set(guard.sql, group);
  };
  for (const { row, authority } of candidates) {
    const current = finalGuard(env, row, authority, member);
    add(current, { kind: "intent", id: row.id, row });
  }
  if (proof) for (const link of links) {
    const source = founderEvidenceReportGuard(proof, { requireExportOwnership: true }), guard = slackGuard(env, member, link);
    add(packed({ sql: `${source.sql} AND ${guard.sql}`, values: [...source.values, ...guard.values] }), { kind: "destination", id: link.destination.linkId });
  }
  for (const [guard, items] of groups) {
    let at = 0;
    const expression = guard.replaceAll("?", () => `json_extract(rsi.value,'$.values[${at++}]')`);
    if (at !== items[0]?.values.length) fail("report_slack_guard_invalid", 503);
    const encoded = JSON.stringify(items);
    if (new TextEncoder().encode(encoded).length > 1_000_000) fail("report_slack_review_too_large", 413);
    statements.push(`SELECT json_extract(rsi.value,'$.kind') AS kind,json_extract(rsi.value,'$.id') AS id FROM json_each(?) rsi WHERE ${expression}
      AND (json_extract(rsi.value,'$.kind')='destination' OR EXISTS(SELECT 1 FROM report_slack_deliveries d
        WHERE d.id=json_extract(rsi.value,'$.id') AND d.digest=json_extract(rsi.value,'$.row.digest') AND d.state=json_extract(rsi.value,'$.row.state')
          AND d.content=json_extract(rsi.value,'$.row.content') AND d.source_json=json_extract(rsi.value,'$.row.source_json')
          AND d.disclosed_at IS json_extract(rsi.value,'$.row.disclosed_at') AND d.approver_json IS json_extract(rsi.value,'$.row.approver_json')
          AND d.receipt_ts IS json_extract(rsi.value,'$.row.receipt_ts') AND d.error_code IS json_extract(rsi.value,'$.row.error_code')))`);
    values.push(encoded);
  }
  const final = await env.AGENT_AUDIT.prepare(statements.join(" UNION ALL ")).bind(...values).all<{ kind: string; id: string }>();
  if (!final.results.some((item) => item.kind === "actor")) fail("report_slack_authority_changed", 403);
  const ids = new Set(final.results.map((item) => `${item.kind}:${item.id}`));
  base.intents = candidates.filter(({ row }) => ids.has(`intent:${row.id}`)).map(({ row }) => view(row, member, configured(env), approver(env, member)));
  base.destinations = links.filter((link) => ids.has(`destination:${link.destination.linkId}`)).map((link) => link.destination);
  return { ...base, ...(!proof && candidates.length === 0 ? { available: false, unavailableReason: "report_slack_source_owner_required" } : !configured(env) ? { unavailableReason: "report_slack_not_configured" } : {}) };
}

/** Server-only reusable destination fence. A caller must also bind its own human/source grant and expiry. */
export type ReportSlackLinkSnapshot = LinkSnapshot;
export { destinations as listReportSlackDestinations, slackGuard as reportSlackDestinationGuard };
