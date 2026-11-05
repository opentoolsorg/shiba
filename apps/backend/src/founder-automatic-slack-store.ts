import {
  AUTOMATIC_SLACK_RENDER_POLICY,
  AUTOMATIC_SLACK_COMPACT_RENDER_POLICY,
  AUTOMATIC_SLACK_MAX_TTL_MS,
  AUTOMATIC_SLACK_AUDIENCE_CONSENT,
  REPORT_SLACK_DISCLOSURE_SCOPE,
  REPORT_SLACK_MAX_BYTES,
  automaticSlackDisclosureSchema,
  founderSkillIdSchema,
  type AutomaticSlackPrepare,
  type AutomaticSlackDecision,
  type AutomaticSlackGrant,
  type AutomaticSlackDelivery,
  type AutomaticSlackState,
} from "@shiba/shared";
import type { Env } from "./env.js";
import type { WorkspaceNativeMember } from "./workspace-native-authority.js";
import {
  membershipSql,
  assertWorkspaceMemberCurrent,
  insertGuarded,
  WorkspaceIntegrationError,
} from "./workspace-integrations-store.js";
import {
  ensureReportSlackSchema,
  listReportSlackDestinations,
  reportSlackDestinationGuard,
  type ReportSlackLinkSnapshot,
} from "./report-slack-store.js";
import {
  automaticAvailability,
  automaticContract,
  automaticPinsGuard,
  type AutomaticGrantRow,
  type AutomaticPins,
} from "./founder-auto-read-store.js";
import {
  automaticReadReportAuthorityGuard,
  loadAutomaticReadReportAuthority,
  type AutomaticReportAuthority,
} from "./founder-auto-read-runtime.js";
import { founderConnectorRecipeHash, FOUNDER_SQL_NOW } from "./founder-connector-context.js";
import { hashToolArgs } from "./mcp-gateway.js";
import { isApprover, parseApproverAllowlist } from "./slack-approval.js";
import { slackOAuthConfiguration } from "./slack-installations-store.js";
import { redactSecrets } from "./security.js";
import { AUTOMATIC_SLACK_SCHEMA } from "./founder-automatic-slack-schema.js";

export interface AutomaticSlackFamily {
  grant: AutomaticGrantRow;
  pins: AutomaticPins;
  recipeHash: string;
  renderPolicy: typeof AUTOMATIC_SLACK_RENDER_POLICY | typeof AUTOMATIC_SLACK_COMPACT_RENDER_POLICY;
  maxBytes: typeof REPORT_SLACK_MAX_BYTES;
}
export interface AutomaticSlackRow {
  id: string;
  workspace_id: string;
  library_id: string;
  owner_id: string;
  owner_account_id: string;
  owner_json: string;
  request_id: string;
  input_hash: string;
  digest: string;
  version: 1;
  family_json: string;
  read_grant_id: string;
  read_grant_version: number;
  read_grant_digest: string;
  sample_occurrence_id: string;
  sample_report_hash: string;
  destination_json: string;
  audience_json: string;
  policy_json: string;
  link_created_at: number;
  room_id: string;
  link_id: string;
  destination_key: string;
  max_sends: number;
  used_sends: number;
  state: Exclude<AutomaticSlackGrant["state"], "expired">;
  created_at: number;
  expires_at: number;
  review_expires_at: number;
  approved_at: number | null;
  approver_json: string | null;
  error_code: string | null;
}
export interface AutomaticSlackDeliveryRow {
  id: string;
  grant_id: string;
  workspace_id: string;
  occurrence_id: string;
  source_key: string;
  destination_key: string;
  report_hash: string;
  content: string;
  content_hash: string;
  client_msg_id: string;
  state: AutomaticSlackDelivery["state"];
  lease_id: string;
  lease_expires_at: number;
  created_at: number;
  expires_at: number;
  receipt_ts: string | null;
  error_code: string | null;
}
export interface AutomaticSlackGuard {
  sql: string;
  values: unknown[];
}
export type AutomaticSlackSessionFence = () => Promise<void>;
const initialized = new WeakSet<D1Database>();
export function automaticSlackFail(code: string, status = 409): never {
  throw new WorkspaceIntegrationError(code, status);
}
export function automaticSlackOwner(row: AutomaticSlackRow): WorkspaceNativeMember {
  return JSON.parse(row.owner_json);
}
export function automaticSlackFamily(row: AutomaticSlackRow): AutomaticSlackFamily {
  return JSON.parse(row.family_json);
}
export function automaticSlackLink(row: AutomaticSlackRow): ReportSlackLinkSnapshot {
  return {
    destination: JSON.parse(row.destination_json),
    audienceJson: row.audience_json,
    policyJson: row.policy_json,
    createdAt: row.link_created_at,
  };
}
export function automaticSlackApprover(env: Env, member: WorkspaceNativeMember): boolean {
  return (
    member.role !== "member" &&
    isApprover(member.userId, parseApproverAllowlist(env.DASHBOARD_APPROVERS))
  );
}
export function automaticSlackAvailable(env: Env): string | null {
  if (automaticAvailability(env)) return "automatic_slack_read_runtime_unavailable";
  if (env.SLACK_ROOM_OUTBOX_ENABLED !== "true" || env.SLACK_INSTALLATIONS_ENABLED !== "true")
    return "automatic_slack_disabled";
  try {
    slackOAuthConfiguration(env);
  } catch {
    return "automatic_slack_installation_setup_required";
  }
  if (parseApproverAllowlist(env.DASHBOARD_APPROVERS).length === 0)
    return "automatic_slack_human_approver_required";
  return null;
}
export async function ensureAutomaticSlackSchema(env: Env) {
  await ensureReportSlackSchema(env);
  if (initialized.has(env.AGENT_AUDIT)) return;
  for (const sql of AUTOMATIC_SLACK_SCHEMA) await env.AGENT_AUDIT.prepare(sql).run();
  initialized.add(env.AGENT_AUDIT);
}
/** Pack only fixed server predicates, never HTTP or model-provided SQL. */
export function packAutomaticSlackGuard(guard: AutomaticSlackGuard): AutomaticSlackGuard {
  let at = 0;
  const sql = guard.sql.replaceAll("?", () => `json_extract(asg.value,'$[${at++}]')`);
  if (at !== guard.values.length) automaticSlackFail("automatic_slack_guard_invalid", 503);
  return {
    sql: `EXISTS(SELECT 1 FROM json_each(?) asg WHERE ${sql})`,
    values: [JSON.stringify([guard.values])],
  };
}
/** Full, deterministic plain text. No model, mentions, hidden bytes or silent truncation. */
export function renderAutomaticSlackReport(markdown: string): string {
  const raw = `Scheduled fixed-read evidence. Captures are bounded; dataset completeness is unknown and business success is unverified.\n\n${markdown}`;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Delivered data must not contain hidden control bytes.
  if (!markdown.trim() || /[\x00-\x08\x0b-\x1f\x7f]/.test(raw) || redactSecrets(raw) !== raw)
    automaticSlackFail("automatic_slack_content_unreviewable", 400);
  const content = raw.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  if (new TextEncoder().encode(content).length > REPORT_SLACK_MAX_BYTES)
    automaticSlackFail("automatic_slack_complete_report_too_large", 413);
  return content;
}
/** V2 sends every field and result of the canonical stored JSON, without Markdown indentation. */
export function renderAutomaticSlackCompactReport(json: string): string {
  let value: unknown;
  try { value = JSON.parse(json); } catch { return automaticSlackFail("automatic_slack_content_unreviewable", 400); }
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value, null, 2) + "\n" !== json)
    return automaticSlackFail("automatic_slack_content_unreviewable", 400);
  const report = value as Record<string, unknown>;
  const notice = "Fixed reads under an explicit standing grant. Captures are bounded; dataset completeness is unknown and business success is unverified. No model, inferred metrics, MRR, churn or freshness claim.";
  if (report.format !== "shiba.automatic-read.report.v1" || report.notice !== notice || !Array.isArray(report.sources) || !report.sources.length ||
    report.sources.some((source: unknown) => !source || typeof source !== "object" || Array.isArray(source) ||
      (source as Record<string, unknown>).sourceKind !== "standing-scheduled-read" ||
      (source as Record<string, unknown>).datasetCompleteness !== "unknown" || (source as Record<string, unknown>).businessSuccess !== "unverified" ||
      !["operationId", "connectionId", "connectionVersion", "arguments", "inputSchemaHash", "executorHash", "queryHash", "capturedAt", "capturedBytes", "state", "requestDigest", "resultDigest", "captureCompleteness", "result", "error"].every((key) => Object.hasOwn(source, key))))
    return automaticSlackFail("automatic_slack_content_unreviewable", 400);
  const raw = `Scheduled fixed-read evidence. Complete compact JSON; captures are bounded, dataset completeness is unknown and business success is unverified.\n\n${JSON.stringify(value)}`;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Delivered data must not contain hidden control bytes.
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(raw) || redactSecrets(raw) !== raw) return automaticSlackFail("automatic_slack_content_unreviewable", 400);
  const content = raw.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  if (new TextEncoder().encode(content).length > REPORT_SLACK_MAX_BYTES) return automaticSlackFail("automatic_slack_complete_report_too_large", 413);
  return content;
}
export function renderAutomaticSlackSource(row: AutomaticSlackRow, report: AutomaticReportAuthority["report"]): string {
  const policy = automaticSlackFamily(row).renderPolicy;
  if (policy === AUTOMATIC_SLACK_RENDER_POLICY) return renderAutomaticSlackReport(report.markdown);
  if (policy === AUTOMATIC_SLACK_COMPACT_RENDER_POLICY) return renderAutomaticSlackCompactReport(report.json);
  return automaticSlackFail("automatic_slack_renderer_unavailable", 403);
}
/** Receipt hash is SHA-256 of the exact delivered UTF-8 bytes, matching browser verification. */
export async function automaticSlackContentHash(content: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
export function automaticSlackFamilyGuard(env: Env, row: AutomaticSlackRow): AutomaticSlackGuard {
  const family = automaticSlackFamily(row),
    g = family.grant,
    c = automaticContract(g);
  if (
    automaticSlackAvailable(env) ||
    ![AUTOMATIC_SLACK_RENDER_POLICY, AUTOMATIC_SLACK_COMPACT_RENDER_POLICY].includes(family.renderPolicy) ||
    family.maxBytes !== REPORT_SLACK_MAX_BYTES ||
    family.recipeHash !== family.pins.recipeSha256 ||
    g.id !== row.read_grant_id ||
    g.version !== row.read_grant_version ||
    g.digest !== row.read_grant_digest ||
    family.pins.member.accountId !== row.owner_account_id ||
    c.runtime.versionId !== env.OPEN_CONNECTOR_READ_VERSION_ID ||
    c.runtime.manifestDigest !== env.OPEN_CONNECTOR_READ_MANIFEST_SHA256
  )
    return { sql: "0=1", values: [] };
  const source = automaticPinsGuard(family.pins);
  return {
    sql: `${source.sql} AND EXISTS(SELECT 1 FROM founder_automatic_read_grants WHERE id=? AND version=? AND digest=? AND contract_json=? AND pins_json=? AND state IN ('enabled','exhausted') AND json_extract(contract_json,'$.expiresAt')>${FOUNDER_SQL_NOW})`,
    values: [...source.values, g.id, g.version, g.digest, g.contract_json, g.pins_json],
  };
}
/** Fresh family-code check is awaited before constructing any final SQL fence. */
export async function assertAutomaticSlackFamilyCode(row: AutomaticSlackRow) {
  const family = automaticSlackFamily(row);
  const digest = await hashToolArgs({
    ...row, digest: undefined, used_sends: 0, state: "draft", approved_at: null, approver_json: null, error_code: null,
    renderPolicy: family.renderPolicy, maxBytes: REPORT_SLACK_MAX_BYTES, futureAudience: AUTOMATIC_SLACK_AUDIENCE_CONSENT,
  });
  if (digest !== row.digest) automaticSlackFail("automatic_slack_contract_changed", 403);
  if ((await founderConnectorRecipeHash(row.library_id)) !== automaticSlackFamily(row).recipeHash)
    automaticSlackFail("automatic_slack_recipe_changed", 403);
}
export function automaticSlackGrantGuard(
  env: Env,
  row: AutomaticSlackRow,
  reader?: WorkspaceNativeMember,
  withApproval = false,
): AutomaticSlackGuard {
  const owner = automaticSlackOwner(row),
    link = automaticSlackLink(row),
    family = automaticSlackFamilyGuard(env, row);
  if (
    !link.destination.installation ||
    link.destination.installation.ownerAccountId !== owner.accountId
  )
    return { sql: "0=1", values: [] };
  const destination = reportSlackDestinationGuard(env, owner, link, reader),
    approved = row.approver_json ? (JSON.parse(row.approver_json) as WorkspaceNativeMember) : null;
  let approvalSql = "",
    approvalValues: unknown[] = [];
  if (withApproval) {
    if (
      !approved ||
      approved.accountId === owner.accountId ||
      !automaticSlackApprover(env, approved)
    )
      return { sql: "0=1", values: [] };
    const approver = membershipSql(approved, true);
    approvalSql = ` AND ${approver.sql} AND EXISTS(SELECT 1 FROM collaboration_memberships m WHERE m.workspace_id=? AND m.room_id=? AND m.actor_id=? AND m.user_id=? AND m.actor_kind='human' AND m.status='active' AND EXISTS(SELECT 1 FROM json_each(m.capabilities_json) WHERE value='room.read'))`;
    approvalValues = [
      ...approver.values,
      row.workspace_id,
      row.room_id,
      `human:${approved.userId}`,
      approved.userId,
    ];
  }
  return {
    sql: `${family.sql} AND ${destination.sql} AND ?>${FOUNDER_SQL_NOW}${approvalSql}`,
    values: [...family.values, ...destination.values, row.expires_at, ...approvalValues],
  };
}
function exact(row: AutomaticSlackRow, input: AutomaticSlackDecision) {
  if (
    input.expectedVersion !== row.version ||
    input.digest !== row.digest ||
    input.expiresAt !== row.expires_at ||
    input.reviewed !== true
  )
    automaticSlackFail("automatic_slack_review_changed");
}
async function find(env: Env, member: WorkspaceNativeMember, libraryId: string, id: string) {
  const row = await env.AGENT_AUDIT.prepare(
    "SELECT * FROM founder_automatic_slack_grants WHERE id=? AND workspace_id=? AND library_id=?",
  )
    .bind(id, member.workspaceId, libraryId)
    .first<AutomaticSlackRow>();
  if (
    !row ||
    (row.owner_account_id !== member.accountId &&
      (row.state === "draft" || !automaticSlackApprover(env, member)))
  )
    automaticSlackFail("automatic_slack_unavailable", 404);
  return row;
}
export async function prepareAutomaticSlack(
  env: Env,
  member: WorkspaceNativeMember,
  libraryId: string,
  input: AutomaticSlackPrepare,
  verifySession: AutomaticSlackSessionFence,
): Promise<string> {
  await ensureAutomaticSlackSchema(env);
  await assertWorkspaceMemberCurrent(env, member, true);
  const unavailable = automaticSlackAvailable(env);
  if (unavailable) automaticSlackFail(unavailable, 503);
  const inputHash = await hashToolArgs({ libraryId, ...input }),
    previous = await env.AGENT_AUDIT.prepare(
      "SELECT id,input_hash FROM founder_automatic_slack_grants WHERE workspace_id=? AND owner_account_id=? AND request_id=?",
    )
      .bind(member.workspaceId, member.accountId, input.requestId)
      .first<{ id: string; input_hash: string }>();
  if (previous) {
    if (previous.input_hash !== inputHash) automaticSlackFail("automatic_slack_request_conflict");
    return previous.id;
  }
  const a = await loadAutomaticReadReportAuthority(env, {
    kind: "schedule",
    grantId: input.readGrantId,
    grantVersion: input.readGrantVersion,
    occurrenceId: input.sampleOccurrenceId,
  });
  if (
    a.humanAuthorizer.accountId !== member.accountId ||
    a.readGrant.workspace_id !== member.workspaceId ||
    a.readGrant.library_id !== libraryId ||
    a.occurrence.state !== "completed" ||
    a.report.reportHash !== input.sampleReportHash
  )
    automaticSlackFail("automatic_slack_source_owner_required", 403);
  renderAutomaticSlackCompactReport(a.report.json);
  const now = Date.now(),
    contract = automaticContract(a.readGrant);
  if (
    input.expiresAt <= now ||
    input.expiresAt > now + AUTOMATIC_SLACK_MAX_TTL_MS ||
    input.expiresAt > contract.expiresAt
  )
    automaticSlackFail("automatic_slack_expiry_changed");
  const link = (await listReportSlackDestinations(env, member)).find(
    (s) =>
      s.destination.roomId === input.roomId &&
      s.destination.linkId === input.linkId &&
      s.destination.installation?.ownerAccountId === member.accountId,
  );
  if (
    !link?.destination.installation ||
    (link.destination.installation.expiresAt !== null &&
      input.expiresAt > link.destination.installation.expiresAt)
  )
    automaticSlackFail("automatic_slack_managed_destination_required", 403);
  const family: AutomaticSlackFamily = {
    grant: a.readGrant,
    pins: a.pins,
    recipeHash: a.recipeHashFromCode,
    renderPolicy: AUTOMATIC_SLACK_COMPACT_RENDER_POLICY,
    maxBytes: REPORT_SLACK_MAX_BYTES,
  };
  // Destination uncertainty outlives a replacement grant, token generation or installation ID.
  const destinationKey = await hashToolArgs({
    workspaceId: member.workspaceId,
    teamId: link.destination.teamId,
    channelId: link.destination.channelId,
    threadTs: link.destination.threadTs,
  });
  const row: AutomaticSlackRow = {
    id: `asgr_${crypto.randomUUID().replaceAll("-", "")}`,
    workspace_id: member.workspaceId,
    library_id: libraryId,
    owner_id: member.userId,
    owner_account_id: member.accountId,
    owner_json: JSON.stringify(member),
    request_id: input.requestId,
    input_hash: inputHash,
    digest: "",
    version: 1,
    family_json: JSON.stringify(family),
    read_grant_id: a.readGrant.id,
    read_grant_version: a.readGrant.version,
    read_grant_digest: a.readGrant.digest,
    sample_occurrence_id: a.occurrence.id,
    sample_report_hash: a.report.reportHash,
    destination_json: JSON.stringify(link.destination),
    audience_json: link.audienceJson,
    policy_json: link.policyJson,
    link_created_at: link.createdAt,
    room_id: input.roomId,
    link_id: input.linkId,
    destination_key: destinationKey,
    max_sends: input.maxSends,
    used_sends: 0,
    state: "draft",
    created_at: now,
    expires_at: input.expiresAt,
    review_expires_at: Math.min(input.expiresAt, now + 900000),
    approved_at: null,
    approver_json: null,
    error_code: null,
  };
  row.digest = await hashToolArgs({
    ...row,
    digest: undefined,
    renderPolicy: AUTOMATIC_SLACK_COMPACT_RENDER_POLICY,
    maxBytes: REPORT_SLACK_MAX_BYTES,
    futureAudience: AUTOMATIC_SLACK_AUDIENCE_CONSENT,
  });
  await verifySession();
  const familyGuard = automaticSlackGrantGuard(env, row),
    source = automaticReadReportAuthorityGuard(env, a),
    guard = packAutomaticSlackGuard({
      sql: `${familyGuard.sql} AND ${source.sql} AND EXISTS(SELECT 1 FROM founder_automatic_read_occurrences WHERE id=? AND state='completed')`,
      values: [...familyGuard.values, ...source.values, a.occurrence.id],
    });
  const result = await insertGuarded(
    env,
    "founder_automatic_slack_grants",
    { ...row },
    {
      sql: `${guard.sql} AND (SELECT COUNT(*) FROM founder_automatic_slack_grants WHERE workspace_id=? AND owner_account_id=?)<20 AND NOT EXISTS(SELECT 1 FROM founder_automatic_slack_grants WHERE destination_key=? AND state IN ('draft','disclosed','enabled','paused')) AND NOT EXISTS(SELECT 1 FROM founder_automatic_slack_deliveries WHERE destination_key=? AND state IN ('sending','unknown'))`,
      values: [
        ...guard.values,
        member.workspaceId,
        member.accountId,
        destinationKey,
        destinationKey,
      ],
    },
  ).run();
  if (result.meta.changes !== 1)
    automaticSlackFail("automatic_slack_source_or_destination_changed", 403);
  return row.id;
}
export async function transitionAutomaticSlack(
  env: Env,
  member: WorkspaceNativeMember,
  libraryId: string,
  id: string,
  action: "disclose" | "approve" | "pause" | "revoke",
  input: AutomaticSlackDecision,
  verifySession: AutomaticSlackSessionFence,
) {
  await ensureAutomaticSlackSchema(env);
  const row = await find(env, member, libraryId, id);
  exact(row, input);
  const owner = row.owner_account_id === member.accountId;
  if (action === "disclose") automaticSlackDisclosureSchema.parse(input);
  if (action === "approve" ? owner || !automaticSlackApprover(env, member) : !owner)
    automaticSlackFail("automatic_slack_human_authority_required", 403);
  const expected =
    action === "disclose"
      ? "draft"
      : action === "approve"
        ? "disclosed"
        : action === "pause"
          ? "enabled"
          : null;
  if (
    (expected && row.state !== expected) ||
    ["revoked", "blocked", "exhausted"].includes(row.state)
  )
    automaticSlackFail("automatic_slack_state_changed");
  if (action === "disclose" || action === "approve") await assertAutomaticSlackFamilyCode(row);
  // Approval is a fresh human decision over this exact future family, never a cron identity.
  let sample: AutomaticReportAuthority | null = null;
  if (action === "disclose" || action === "approve")
    sample = await loadAutomaticReadReportAuthority(env, {
      kind: "schedule",
      grantId: row.read_grant_id,
      grantVersion: row.read_grant_version,
      occurrenceId: row.sample_occurrence_id,
    });
  if (
    sample &&
    (sample.occurrence.state !== "completed" || sample.report.reportHash !== row.sample_report_hash)
  )
    automaticSlackFail("automatic_slack_sample_changed", 403);
  await verifySession();
  const actor = membershipSql(member, true),
    scope =
      action === "revoke" || action === "pause"
        ? actor
        : automaticSlackGrantGuard(env, row, member);
  const proof = sample ? automaticReadReportAuthorityGuard(env, sample) : null;
  const guard = packAutomaticSlackGuard({
    sql: `${scope.sql} AND ${actor.sql}${proof ? ` AND ${proof.sql} AND ?>${FOUNDER_SQL_NOW}` : ""}`,
    values: [
      ...scope.values,
      ...actor.values,
      ...(proof ? [...proof.values, row.review_expires_at] : []),
    ],
  });
  const state =
    action === "disclose"
      ? "disclosed"
      : action === "approve"
        ? "enabled"
        : action === "pause"
          ? "paused"
          : "revoked";
  const result = await env.AGENT_AUDIT.prepare(
    `UPDATE founder_automatic_slack_grants SET state=?,approved_at=CASE WHEN ?='enabled' THEN ${FOUNDER_SQL_NOW} ELSE approved_at END,approver_json=CASE WHEN ?='enabled' THEN ? ELSE approver_json END WHERE id=? AND state=? AND digest=? AND family_json=? AND ${guard.sql}`,
  )
    .bind(state, state, state, JSON.stringify(member), id, row.state, row.digest, row.family_json, ...guard.values)
    .run();
  if (result.meta.changes !== 1) automaticSlackFail("automatic_slack_authority_changed", 403);
}
function grantView(
  row: AutomaticSlackRow,
  member: WorkspaceNativeMember,
  env: Env,
  sampleContent: string | null,
  sampleExpiresAt: number | null,
): AutomaticSlackGrant {
  const alive = row.expires_at > Date.now(),
    owner = row.owner_account_id === member.accountId,
    review = row.review_expires_at > Date.now();
  if (sampleExpiresAt === null || sampleExpiresAt <= Date.now()) {
    sampleContent = null;
    sampleExpiresAt = null;
  }
  return {
    id: row.id,
    version: 1,
    digest: row.digest,
    readGrantId: row.read_grant_id,
    readGrantVersion: row.read_grant_version,
    readGrantDigest: row.read_grant_digest,
    readContract: automaticContract(automaticSlackFamily(row).grant),
    ownerId: row.owner_id,
    ownerAccountId: row.owner_account_id,
    destination: automaticSlackLink(row).destination,
    renderPolicy: automaticSlackFamily(row).renderPolicy,
    maxBytes: REPORT_SLACK_MAX_BYTES,
    disclosureScope: REPORT_SLACK_DISCLOSURE_SCOPE,
    futureAudienceScope: AUTOMATIC_SLACK_AUDIENCE_CONSENT,
    sampleOccurrenceId: row.sample_occurrence_id,
    sampleReportHash: row.sample_report_hash,
    sampleContent,
    sampleExpiresAt,
    state: alive ? row.state : "expired",
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    reviewExpiresAt: row.review_expires_at,
    approvedAt: row.approved_at,
    approvedByUserId: row.approver_json
      ? (JSON.parse(row.approver_json) as WorkspaceNativeMember).userId
      : null,
    maxSends: row.max_sends,
    usedSends: row.used_sends,
    errorCode: row.error_code,
    canDisclose: alive && review && owner && row.state === "draft" && sampleContent !== null,
    canApprove:
      alive &&
      review &&
      !owner &&
      automaticSlackApprover(env, member) &&
      row.state === "disclosed" &&
      sampleContent !== null,
    canPause: alive && owner && row.state === "enabled",
    canRevoke: owner && !["revoked", "blocked", "exhausted"].includes(row.state),
  };
}
export async function readAutomaticSlack(
  env: Env,
  member: WorkspaceNativeMember,
  libraryId: string,
  verifySession: AutomaticSlackSessionFence,
): Promise<AutomaticSlackState> {
  await ensureAutomaticSlackSchema(env);
  await assertWorkspaceMemberCurrent(env, member, true);
  const reason = automaticSlackAvailable(env),
    rows = await env.AGENT_AUDIT.prepare(
      "SELECT * FROM founder_automatic_slack_grants WHERE workspace_id=? AND library_id=? ORDER BY created_at DESC LIMIT 20",
    )
      .bind(member.workspaceId, libraryId)
      .all<AutomaticSlackRow>();
  const candidates: {
      row: AutomaticSlackRow;
      sample: string | null;
      sampleExpiry: number | null;
      sampleGuard: AutomaticSlackGuard | null;
      guard: AutomaticSlackGuard;
    }[] = [],
    deliveries: { row: AutomaticSlackDeliveryRow; guard: AutomaticSlackGuard }[] = [];
  for (const row of rows.results) {
    if (
      row.owner_account_id !== member.accountId &&
      (row.state === "draft" || !automaticSlackApprover(env, member))
    )
      continue;
    try {
      await assertAutomaticSlackFamilyCode(row);
      const guard = automaticSlackGrantGuard(env, row, member, row.approver_json !== null);
      let sample: string | null = null,
        sampleExpiry: number | null = null,
        sampleGuard: AutomaticSlackGuard | null = null;
      try {
        const a = await loadAutomaticReadReportAuthority(env, {
          kind: "schedule",
          grantId: row.read_grant_id,
          grantVersion: row.read_grant_version,
          occurrenceId: row.sample_occurrence_id,
        });
        if (a.report.reportHash === row.sample_report_hash && a.occurrence.state === "completed") {
          sample = renderAutomaticSlackSource(row, a.report);
          sampleExpiry = a.report.expiresAt;
          sampleGuard = automaticReadReportAuthorityGuard(env, a);
        }
      } catch {
        /* Expired sample is never a retained disclosure. */
      }
      candidates.push({ row, sample, sampleExpiry, sampleGuard, guard });
      const out = await env.AGENT_AUDIT.prepare(
        "SELECT * FROM founder_automatic_slack_deliveries WHERE grant_id=? ORDER BY created_at DESC LIMIT 5",
      )
        .bind(row.id)
        .all<AutomaticSlackDeliveryRow>();
      for (const d of out.results) {
        try {
          const a = await loadAutomaticReadReportAuthority(env, {
            kind: "schedule",
            grantId: row.read_grant_id,
            grantVersion: row.read_grant_version,
            occurrenceId: d.occurrence_id,
          });
          if (
            a.occurrence.state !== "completed" ||
            a.report.reportHash !== d.report_hash ||
            renderAutomaticSlackSource(row, a.report) !== d.content
          )
            continue;
          const source = automaticReadReportAuthorityGuard(env, a);
          deliveries.push({
            row: d,
            guard: {
              sql: `${guard.sql} AND ${source.sql} AND ?>${FOUNDER_SQL_NOW} AND EXISTS(SELECT 1 FROM founder_automatic_slack_grants WHERE id=? AND digest=? AND family_json=?)`,
              values: [...guard.values, ...source.values, d.expires_at, row.id, row.digest, row.family_json],
            },
          });
        } catch {
          /* No cached private source after revocation. */
        }
      }
    } catch {
      /* Changed private family stays hidden. */
    }
  }
  const links = !reason ? (await listReportSlackDestinations(env, member)).slice(0, 10) : [];
  await verifySession();
  const actor = membershipSql(member, true),
    queries = [`SELECT 'actor' AS kind,'' AS id WHERE ${actor.sql}`],
    values: unknown[] = [...actor.values];
  const groups = new Map<string, { kind: string; id: string; values: unknown[] }[]>();
  const add = (
    kind: string,
    id: string,
    guard: AutomaticSlackGuard,
    rowGuard: string,
    rowValues: unknown[],
  ) => {
    const sql = `${guard.sql} AND ${rowGuard}`,
      items = groups.get(sql) ?? [];
    items.push({ kind, id, values: [...guard.values, ...rowValues] });
    groups.set(sql, items);
  };
  for (const c of candidates)
    add(
      "grant",
      c.row.id,
      c.guard,
      "EXISTS(SELECT 1 FROM founder_automatic_slack_grants WHERE id=? AND digest=? AND family_json=? AND state=? AND used_sends=? AND approver_json IS ?)",
      [c.row.id, c.row.digest, c.row.family_json, c.row.state, c.row.used_sends, c.row.approver_json],
    );
  for (const c of candidates)
    if (c.sampleGuard)
      add(
        "sample",
        c.row.id,
        c.sampleGuard,
        "EXISTS(SELECT 1 FROM founder_automatic_slack_grants WHERE id=? AND digest=? AND family_json=? AND state=?)",
        [c.row.id, c.row.digest, c.row.family_json, c.row.state],
      );
  for (const d of deliveries.slice(0, 20))
    add(
      "delivery",
      d.row.id,
      d.guard,
      "EXISTS(SELECT 1 FROM founder_automatic_slack_deliveries WHERE id=? AND state=? AND content=? AND content_hash=? AND receipt_ts IS ?)",
      [d.row.id, d.row.state, d.row.content, d.row.content_hash, d.row.receipt_ts],
    );
  for (const link of links.filter(
    (l) => l.destination.installation?.ownerAccountId === member.accountId,
  ))
    add("link", link.destination.linkId, reportSlackDestinationGuard(env, member, link), "1=1", []);
  for (const [sql, items] of groups) {
    let at = 0;
    const expression = sql.replaceAll("?", () => `json_extract(asread.value,'$.values[${at++}]')`);
    if (at !== items[0]?.values.length) automaticSlackFail("automatic_slack_guard_invalid", 503);
    const encoded = JSON.stringify(items);
    if (new TextEncoder().encode(encoded).length > 1000000)
      automaticSlackFail("automatic_slack_review_too_large", 413);
    queries.push(
      `SELECT json_extract(asread.value,'$.kind') AS kind,json_extract(asread.value,'$.id') AS id FROM json_each(?) asread WHERE ${expression}`,
    );
    values.push(encoded);
  }
  const final = await env.AGENT_AUDIT.prepare(queries.join(" UNION ALL "))
    .bind(...values)
    .all<{ kind: string; id: string }>();
  if (!final.results.some((r) => r.kind === "actor"))
    automaticSlackFail("automatic_slack_authority_changed", 403);
  const allowed = new Set(final.results.map((r) => `${r.kind}:${r.id}`));
  return {
    ok: true,
    workspaceId: member.workspaceId,
    libraryId: founderSkillIdSchema.parse(libraryId),
    actorId: member.userId,
    available: !reason,
    unavailableReason: reason,
    destinations: links
      .filter((l) => allowed.has(`link:${l.destination.linkId}`))
      .map((l) => l.destination),
    grants: candidates
      .filter((c) => allowed.has(`grant:${c.row.id}`) && c.row.expires_at > Date.now())
      .map((c) =>
        grantView(
          c.row,
          member,
          env,
          allowed.has(`sample:${c.row.id}`) ? c.sample : null,
          allowed.has(`sample:${c.row.id}`) ? c.sampleExpiry : null,
        ),
      ),
    deliveries: deliveries
      .slice(0, 20)
      .filter((d) => allowed.has(`delivery:${d.row.id}`) && d.row.expires_at > Date.now())
      .map(({ row: d }) => ({
        id: d.id,
        grantId: d.grant_id,
        occurrenceId: d.occurrence_id,
        reportHash: d.report_hash,
        contentHash: d.content_hash,
        content: d.content,
        state: d.state,
        createdAt: d.created_at,
        expiresAt: d.expires_at,
        receiptTs: d.receipt_ts,
        errorCode: d.error_code,
      })),
  };
}
