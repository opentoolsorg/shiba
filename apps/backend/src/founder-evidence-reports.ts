/** Private evidence composition. No model, business-data reads, action calls, or sends. */
import { getFounderSkillLibraryEntry } from "@shiba/shared";
import type { Env } from "./env.js";
import type { WorkspaceActionBinding } from "./workspace-integration-actions.js";
import type { WorkspaceNativeMember } from "./workspace-native-authority.js";
import { membershipSql, assertWorkspaceMemberCurrent, ensureWorkspaceIntegrationSchema, WorkspaceIntegrationError } from "./workspace-integrations-store.js";
import { founderConnectorContextPredicate, founderConnectorRecipeHash, FOUNDER_SQL_NOW } from "./founder-connector-context.js";
import { founderConnectionAllowed } from "./founder-connector-jobs.js";
import { getCustomAgentById, listCustomAgents } from "./custom-agents-store.js";
import { getSkill } from "./skills-store.js";
import { getSkillInstall } from "./skill-library-store.js";
import { COLLAB_TENANT_ID } from "./collaboration-store.js";
import { sha256Hex } from "./agent-tokens.js";
import { hashToolArgs } from "./mcp-gateway.js";
import { OpenConnectorIntegrationProvider } from "./integrations/openconnector-provider.js";

const FORMAT = "shiba.founder-evidence.v1";
const MODE = "local-and-connection-metadata" as const;
const MAX_BYTES = 262_144;
const QUALIFIERS = { sourceKind: "bounded-stored-excerpt", captureCompleteness: "unknown", datasetCompleteness: "unknown", businessSuccess: "unverified" } as const;
const schema = `CREATE TABLE IF NOT EXISTS founder_evidence_reports (
  id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,owner_id TEXT NOT NULL,owner_account_id TEXT NOT NULL,
  library_id TEXT NOT NULL,request_id TEXT NOT NULL,report_hash TEXT NOT NULL,manifest_digest TEXT NOT NULL,
  authority_json TEXT NOT NULL,markdown TEXT NOT NULL,json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,UNIQUE(workspace_id,owner_account_id,request_id))`;
const initialized = new WeakSet<D1Database>();
const bytes = (text: string) => new TextEncoder().encode(text).length;
type Ref = { approvalId: string; inputHash: string; resultDigest: string };
export interface FounderEvidenceInput { employeeId: string; employeeVersion: number; skillId: string; skillVersion: number; receipts: Ref[]; expiresAt: number }
interface ReceiptRow {
  id: string; workspace_id: string; requester_id: string; binding_json: string; input_hash: string; arguments_json: string;
  employee_id: string; employee_version: number; employee_name: string; connection_id: string; action_id: string; result_json: string | null;
  status: string; decision_id: string | null; decision_account_id: string | null; decision_role: string | null; decision_version: number | null; updated_at: number;
}
interface Source { id: string; inputHash: string; resultDigest: string; binding: WorkspaceActionBinding; bindingJson: string; argumentsJson: string; resultJson: string;
  actionId: string; completedAt: number; decisionId: string; decisionAccountId: string; decisionRole: string; decisionVersion: number; founderRecipeSha256: string | null }
interface Pins { member: WorkspaceNativeMember; libraryId: string; recipeSha256: string; employeeId: string; employeeVersion: number; employeeConfig: string;
  skillId: string; skillVersion: number; skillInstructions: string; skillSource: string | null; sources: Source[]; expiresAt: number }
export interface FounderEvidenceAuthority {
  reportId: string; reportHash: string; manifestDigest: string; expiresAt: number; markdown: string; json: string;
  /** Server-created snapshot. Never accept this object or its SQL predicate from HTTP. */
  pins: Pins; authorityJson: string;
}
interface ReportRow { id: string; workspace_id: string; owner_id: string; owner_account_id: string; library_id: string; request_id: string;
  report_hash: string; manifest_digest: string; authority_json: string; markdown: string; json: string; state: "active" | "revoked"; expires_at: number; created_at: number }
interface ReadOptions { requireExportOwnership?: boolean; beforeFinalRead?: () => Promise<void> }
async function ensure(env: Env) {
  await ensureWorkspaceIntegrationSchema(env);
  if (!initialized.has(env.AGENT_AUDIT)) {
    await env.AGENT_AUDIT.prepare(schema).run();
    await env.AGENT_AUDIT.prepare("CREATE INDEX IF NOT EXISTS founder_evidence_owner ON founder_evidence_reports(workspace_id,owner_account_id,created_at)").run();
    initialized.add(env.AGENT_AUDIT);
  }
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]));
  return value;
}
function scope(member: WorkspaceNativeMember, libraryId: string) { return { ok: true as const, workspaceId: member.workspaceId, libraryId, actorId: member.userId }; }
async function source(row: ReceiptRow): Promise<Source> {
  const binding = JSON.parse(row.binding_json) as WorkspaceActionBinding;
  if (!row.decision_id || !row.decision_account_id || !row.decision_role || !row.decision_version || row.status !== "completed" || bytes(row.result_json ?? "null") > 32_768 || bytes(row.arguments_json) > 32_768)
    throw new WorkspaceIntegrationError("completed_approved_receipt_required", 409);
  if (await hashToolArgs({ binding, actionId: row.action_id, arguments: JSON.parse(row.arguments_json) }) !== row.input_hash) throw new WorkspaceIntegrationError("receipt_integrity_changed", 409);
  return { id: row.id, inputHash: row.input_hash, resultDigest: await sha256Hex(row.result_json ?? "null"), binding, bindingJson: row.binding_json,
    argumentsJson: row.arguments_json, resultJson: row.result_json ?? "null", actionId: row.action_id, completedAt: row.updated_at,
    decisionId: row.decision_id, decisionAccountId: row.decision_account_id, decisionRole: row.decision_role, decisionVersion: row.decision_version,
    founderRecipeSha256: binding.founderContext ? await founderConnectorRecipeHash(binding.founderContext.libraryId) : null };
}
/** One bounded authentication-metadata request; no catalog, action, or business endpoints. */
async function connectionAuth(env: Env, member: WorkspaceNativeMember, sources: Source[]) {
  if (!sources.length) return;
  let metadataFailure: WorkspaceIntegrationError | undefined;
  const fail = (code: string): never => { metadataFailure = new WorkspaceIntegrationError(code,503); throw metadataFailure; };
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/connections" || (init?.method ?? "GET") !== "GET") throw new WorkspaceIntegrationError("report_metadata_route_denied", 503);
    const response = await (env.OPEN_CONNECTOR ? env.OPEN_CONNECTOR.fetch(String(input), init) : fetch(input, init));
    if (!response.ok) return response;
    const reader = response.body?.getReader();
    if (!reader) return fail("report_connection_metadata_unavailable");
    const chunks: Uint8Array[] = []; let used = 0;
    try {
      for (;;) { const item = await reader.read(); if (item.done) break; used += item.value.length;
        if (used > 524_288) fail("report_connection_metadata_limit"); chunks.push(item.value); }
    } finally { await reader.cancel().catch(() => {}); }
    const body = new Uint8Array(used); let at = 0; for (const chunk of chunks) { body.set(chunk, at); at += chunk.length; }
    let rows: unknown; try { rows = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); } catch { fail("report_connection_metadata_unavailable"); }
    if (!Array.isArray(rows) || rows.length > 200) fail("report_connection_metadata_limit");
    return new Response(body, { status: response.status, headers: { "content-type": "application/json" } });
  };
  const boundedEnv = Object.create(env) as Env;
  if (env.OPEN_CONNECTOR) Object.defineProperty(boundedEnv, "OPEN_CONNECTOR", { value: { fetch: transport } });
  let accounts: Awaited<ReturnType<OpenConnectorIntegrationProvider["listConnections"]>>;
  try { accounts = await new OpenConnectorIntegrationProvider({ env: boundedEnv, fetchImpl: transport }).listConnections({ userId: member.userId, workspaceId: member.workspaceId }); }
  catch { throw metadataFailure ?? new WorkspaceIntegrationError("report_connection_metadata_unavailable",503); }
  for (const item of sources) if (accounts.filter((account) => account.id === item.binding.providerConnectionId && account.providerKey === item.binding.providerKey && account.authorizationFingerprint === item.binding.fingerprint && account.executionReady === true).length !== 1)
    throw new WorkspaceIntegrationError("report_connection_authorization_changed", 409);
}

/** Fixed SQL over trusted snapshots. Suitable for a caller's final combined send fence. */
function pinsGuard(pins: Pins, requireExportOwnership = false) {
  const actor = membershipSql(pins.member, true);
  const b = (path: string) => `json_extract(f.value,'$.binding.${path}')`;
  const s = (path: string) => `json_extract(f.value,'$.${path}')`;
  const participant = (alias: string, user: string, account: string, role: string, version: string, manager: boolean) =>
    `EXISTS(SELECT 1 FROM team_workspace_memberships ${alias}m JOIN shiba_auth_account_policy ${alias}p ON ${alias}p.account_id=${account} AND ${alias}p.email=${user}
      JOIN "user" ${alias}u ON ${alias}u.id=${alias}p.account_id AND lower(${alias}u.email)=${user} AND ${alias}u.emailVerified=1
      WHERE ${alias}m.tenant_id=? AND ${alias}m.workspace_id=a.workspace_id AND ${alias}m.user_id=${user} AND ${alias}m.role=${role}
      AND ${alias}m.version=${version} AND ${alias}m.status='active'${manager ? ` AND ${alias}m.role IN ('owner','admin')` : ""})`;
  const founder = pins.sources.some((item) => item.binding.founderContext) ? `(${b("founderContext")} IS NULL OR ${founderConnectorContextPredicate({
    context: b("founderContext"), binding: "json_extract(f.value,'$.binding')", approvalId: "a.id", recipeHash: s("founderRecipeSha256"),
  })})` : "1=1";
  return { sql: `${actor.sql} AND ?>${FOUNDER_SQL_NOW}
    AND EXISTS(SELECT 1 FROM org_custom_agents WHERE org_id=? AND id=? AND version=? AND config_json=? AND deleted_at IS NULL AND archived_at IS NULL)
    AND EXISTS(SELECT 1 FROM skills sk JOIN skill_versions v ON v.skill_id=sk.id AND v.version=sk.version AND v.org_id=sk.org_id AND v.owner_id=sk.owner_id
      JOIN skill_installs i ON i.org_id=sk.org_id AND i.installed_by=sk.owner_id AND i.skill_id=sk.id AND i.library_slug=?
      WHERE sk.org_id=? AND sk.owner_id=? AND sk.id=? AND sk.version=? AND sk.status='active' AND sk.active_version=sk.version
      AND sk.reviewed_version=sk.version AND sk.reviewed_instructions=? AND v.instructions=? AND v.source_url IS ?)
    AND NOT EXISTS(SELECT 1 FROM json_each(?) f WHERE NOT EXISTS(SELECT 1 FROM workspace_app_approvals a
      JOIN workspace_app_connections c ON c.id=${b("connectionId")} AND c.workspace_id=a.workspace_id AND c.state='active'
        AND c.version=${b("connectionVersion")} AND c.generation=${b("generation")} AND c.fingerprint=${b("fingerprint")}
        AND c.provider_connection_id=${b("providerConnectionId")} AND c.provider_key=${b("providerKey")}
        AND c.issuer_id=${b("issuer.userId")} AND c.issuer_account_id=${b("issuer.accountId")} AND c.issuer_version=${b("issuer.version")} AND c.issuer_role=${b("issuer.role")}
      JOIN workspace_app_grants g ON g.id=${b("grantId")} AND g.workspace_id=a.workspace_id AND g.state='active' AND g.version=${b("grantVersion")}
        AND g.connection_id=c.id AND g.connection_version=c.version AND g.generation=c.generation AND g.fingerprint=c.fingerprint
        AND g.actor_id=${b("actorId")} AND g.actor_account_id=${b("actorAccountId")} AND g.actor_version=${b("actorVersion")} AND g.actor_role=${b("actorRole")}
        AND g.manager_id=${b("grantManager.userId")} AND g.manager_account_id=${b("grantManager.accountId")} AND g.manager_version=${b("grantManager.version")} AND g.manager_role=${b("grantManager.role")}
        AND g.employee_id=? AND g.employee_version=? AND g.permissions_json LIKE '%"execute"%'
      WHERE a.id=${s("id")} AND a.workspace_id=? AND a.requester_id=? AND ${b("actorAccountId") }=?
        AND a.employee_id=? AND a.employee_version=? AND a.status='completed' AND a.input_hash=${s("inputHash")} AND a.binding_json=${s("bindingJson")}
        AND a.arguments_json=${s("argumentsJson")} AND COALESCE(a.result_json,'null')=${s("resultJson")} AND a.updated_at=${s("completedAt")}
        AND a.action_id=${s("actionId")} AND a.decision_id=${s("decisionId")} AND a.decision_account_id=${s("decisionAccountId")}
        AND a.decision_role=${s("decisionRole")} AND a.decision_version=${s("decisionVersion")}
        AND ${participant("ra", b("actorId"), b("actorAccountId"), b("actorRole"), b("actorVersion"), true)}
        AND ${participant("ri", b("issuer.userId"), b("issuer.accountId"), b("issuer.role"), b("issuer.version"), true)}
        AND ${participant("rg", b("grantManager.userId"), b("grantManager.accountId"), b("grantManager.role"), b("grantManager.version"), true)}
        AND ${participant("rd", "a.decision_id", "a.decision_account_id", "a.decision_role", "a.decision_version", true)}
        AND ${founder}${requireExportOwnership ? ` AND ${b("issuer.accountId") }=?` : ""}))`,
    values: [...actor.values, pins.expiresAt, `team:${pins.member.workspaceId}`, pins.employeeId, pins.employeeVersion, pins.employeeConfig,
      pins.libraryId, `team:${pins.member.workspaceId}`, pins.member.userId, pins.skillId, pins.skillVersion, pins.skillInstructions, pins.skillInstructions, pins.skillSource,
      JSON.stringify(pins.sources), pins.employeeId, pins.employeeVersion, pins.member.workspaceId, pins.member.userId, pins.member.accountId,
      pins.employeeId, pins.employeeVersion, COLLAB_TENANT_ID, COLLAB_TENANT_ID, COLLAB_TENANT_ID, COLLAB_TENANT_ID, ...(requireExportOwnership ? [pins.member.accountId] : [])] };
}
export function founderEvidenceReportGuard(authority: FounderEvidenceAuthority, options: { requireExportOwnership?: boolean } = {}) {
  const source = pinsGuard(authority.pins, options.requireExportOwnership);
  return { sql: `${source.sql} AND EXISTS(SELECT 1 FROM founder_evidence_reports WHERE id=? AND workspace_id=? AND owner_id=? AND owner_account_id=?
      AND state='active' AND report_hash=? AND manifest_digest=? AND authority_json=? AND markdown=? AND json=? AND expires_at=?)`,
    values: [...source.values, authority.reportId, authority.pins.member.workspaceId, authority.pins.member.userId, authority.pins.member.accountId,
      authority.reportHash, authority.manifestDigest, authority.authorityJson, authority.markdown, authority.json, authority.expiresAt] };
}

function reference(item: Source) { return { approvalId: item.id, inputHash: item.inputHash, resultDigest: item.resultDigest }; }
function metadata(item: Source) { return { ...reference(item), ...QUALIFIERS, employeeId: item.binding.employeeId, employeeVersion: item.binding.employeeVersion,
  connectionId: item.binding.connectionId, providerKey: item.binding.providerKey, actionId: item.actionId, completedAt: item.completedAt, contextExpiresAt: item.binding.founderContext?.expiresAt ?? null }; }
async function sources(env: Env, member: WorkspaceNativeMember, libraryId: string, employeeId: string, employeeVersion: number, refs?: Ref[]) {
  const rows = await env.AGENT_AUDIT.prepare(`SELECT * FROM workspace_app_approvals WHERE workspace_id=? AND requester_id=? AND employee_id=? AND employee_version=?
    AND status='completed' AND json_extract(binding_json,'$.actorAccountId')=? ${refs ? "AND id IN(SELECT json_extract(value,'$.approvalId') FROM json_each(?))" : ""} ORDER BY updated_at DESC,id LIMIT 8`)
    .bind(member.workspaceId, member.userId, employeeId, employeeVersion, member.accountId, ...(refs ? [JSON.stringify(refs)] : [])).all<ReceiptRow>();
  const found: Source[] = [];
  for (const row of rows.results) {
    try { const item = await source(row);
      if (item.binding.actorId !== member.userId || item.binding.actorAccountId !== member.accountId || item.binding.workspaceId !== member.workspaceId || !founderConnectionAllowed(libraryId, item.binding.providerKey)) continue;
      found.push(item);
    } catch (error) { if (refs) throw error; }
  }
  if (refs && (found.length !== refs.length || new Set(refs.map((item) => item.approvalId)).size !== refs.length || refs.some((ref) => !found.some((item) => item.id === ref.approvalId && item.inputHash === ref.inputHash && item.resultDigest === ref.resultDigest)))) throw new WorkspaceIntegrationError("report_receipt_changed", 409);
  return found.sort((a,b) => a.id.localeCompare(b.id));
}
async function basePins(env: Env, member: WorkspaceNativeMember, libraryId: string, input: FounderEvidenceInput): Promise<Pins> {
  await ensure(env); await assertWorkspaceMemberCurrent(env, member, true);
  const [employee, skill, install] = await Promise.all([getCustomAgentById(env, `team:${member.workspaceId}`, input.employeeId), getSkill(env, `team:${member.workspaceId}`, member.userId, input.skillId), getSkillInstall(env, `team:${member.workspaceId}`, member.userId, libraryId)]);
  const recipe = await founderConnectorRecipeHash(libraryId);
  if (!recipe || !employee || employee.version !== input.employeeVersion || !skill || install?.skillId !== skill.id || skill.version !== input.skillVersion || skill.status !== "active" || skill.activeVersion !== skill.version || skill.reviewedVersion !== skill.version || skill.reviewedInstructions !== skill.content.instructions) throw new WorkspaceIntegrationError("report_sources_changed", 409);
  const selected = await sources(env, member, libraryId, input.employeeId, input.employeeVersion, input.receipts);
  const now = Date.now();
  if (input.receipts.length < 1 || input.receipts.length > 8 || input.expiresAt <= now || input.expiresAt > now + 86_400_000 || selected.some((item) => item.binding.founderContext && input.expiresAt > item.binding.founderContext.expiresAt)) throw new WorkspaceIntegrationError("report_expiry_or_scope_invalid", 400);
  await connectionAuth(env, member, selected);
  return { member, libraryId, recipeSha256: recipe, employeeId: employee.id, employeeVersion: employee.version, employeeConfig: JSON.stringify(employee.config),
    skillId: skill.id, skillVersion: skill.version, skillInstructions: skill.content.instructions, skillSource: skill.content.sourceUrl ?? null, sources: selected, expiresAt: input.expiresAt };
}
function render(pins: Pins) {
  const evidence = { format: FORMAT, recipe: pins.libraryId, expiresAt: pins.expiresAt, evidenceNotice: "Stored sanitized and bounded action receipt excerpts. Capture and dataset completeness are unknown; business success is unverified, even if returned fields say has_more:false. Completed transport is not proof of semantic success. No new business data, metrics, sums, MRR, churn, or conclusions were inferred.",
    sources: pins.sources.map((item) => ({ ...metadata(item), argumentsOmitted: true, result: JSON.parse(item.resultJson) as unknown })) };
  const json = `${JSON.stringify(stable(evidence), null, 2)}\n`;
  // Indented JSON cannot inject Markdown headings, links, HTML, or closing fences.
  const markdown = `# Founder evidence bundle\n\n${evidence.evidenceNotice}\n\nRecipe: ${pins.libraryId}\n\nExpires: ${new Date(pins.expiresAt).toISOString()}\n\n${json.split("\n").map((line) => `    ${line}`).join("\n")}\n`;
  if (bytes(json) + bytes(markdown) > MAX_BYTES) throw new WorkspaceIntegrationError("report_evidence_limit", 413);
  return { markdown, json };
}
async function prepared(env: Env, member: WorkspaceNativeMember, libraryId: string, input: FounderEvidenceInput) {
  const pins = await basePins(env, member, libraryId, input), output = render(pins), manifestDigest = await hashToolArgs(pins);
  const reportHash = await sha256Hex(JSON.stringify([FORMAT, manifestDigest, pins.expiresAt, output.markdown, output.json]));
  return { pins, manifestDigest, reportHash, ...output };
}
function preview(member: WorkspaceNativeMember, libraryId: string, value: Awaited<ReturnType<typeof prepared>>) { return { ...scope(member, libraryId), employeeId: value.pins.employeeId, employeeVersion: value.pins.employeeVersion,
  skillId: value.pins.skillId, skillVersion: value.pins.skillVersion, receipts: value.pins.sources.map(metadata), manifestDigest: value.manifestDigest, reportHash: value.reportHash,
  expiresAt: value.pins.expiresAt, markdown: value.markdown, json: value.json, canCreate: true, authorizationMode: MODE }; }
export async function previewFounderEvidenceReport(env: Env, member: WorkspaceNativeMember, libraryId: string, input: FounderEvidenceInput, options: ReadOptions = {}) {
  const value = await prepared(env, member, libraryId, input), guard = pinsGuard(value.pins);
  await options.beforeFinalRead?.();
  if (!await env.AGENT_AUDIT.prepare(`SELECT 1 AS current WHERE ${guard.sql}`).bind(...guard.values).first()) throw new WorkspaceIntegrationError("report_sources_changed", 409);
  return preview(member, libraryId, value);
}
export async function createFounderEvidenceReport(env: Env, member: WorkspaceNativeMember, libraryId: string, input: FounderEvidenceInput & { expectedReportHash: string; requestId: string }, options: ReadOptions = {}) {
  const value = await prepared(env, member, libraryId, input);
  if (value.reportHash !== input.expectedReportHash) throw new WorkspaceIntegrationError("report_preview_changed", 409);
  const prior = await env.AGENT_AUDIT.prepare("SELECT id,report_hash FROM founder_evidence_reports WHERE workspace_id=? AND owner_account_id=? AND request_id=?").bind(member.workspaceId, member.accountId, input.requestId).first<{id:string;report_hash:string}>();
  if (prior) { if (prior.report_hash !== value.reportHash) throw new WorkspaceIntegrationError("report_request_conflict", 409); return loadStoredReport(env, member, libraryId, prior.id, options, value.pins); }
  const id = `fer_${crypto.randomUUID().replaceAll("-", "")}`, now = Date.now(), authorityJson = JSON.stringify(value.pins), guard = pinsGuard(value.pins);
  await options.beforeFinalRead?.();
  const inserted = await env.AGENT_AUDIT.prepare(`INSERT OR IGNORE INTO founder_evidence_reports(id,workspace_id,owner_id,owner_account_id,library_id,request_id,report_hash,manifest_digest,authority_json,markdown,json,state,expires_at,created_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,'active',?,? WHERE ${guard.sql} AND (SELECT COUNT(*) FROM founder_evidence_reports WHERE workspace_id=? AND owner_account_id=?)<100`)
    .bind(id, member.workspaceId, member.userId, member.accountId, libraryId, input.requestId, value.reportHash, value.manifestDigest, authorityJson, value.markdown, value.json, value.pins.expiresAt, now,
      ...guard.values, member.workspaceId, member.accountId).run();
  if (inserted.meta.changes !== 1) {
    const duplicate = await env.AGENT_AUDIT.prepare("SELECT id,report_hash FROM founder_evidence_reports WHERE workspace_id=? AND owner_account_id=? AND request_id=?").bind(member.workspaceId, member.accountId, input.requestId).first<{id:string;report_hash:string}>();
    if (!duplicate || duplicate.report_hash !== value.reportHash) throw new WorkspaceIntegrationError("report_sources_or_limit_changed", 409);
    return loadStoredReport(env, member, libraryId, duplicate.id, options, value.pins);
  }
  return loadStoredReport(env, member, libraryId, id, options, value.pins);
}
function authority(row: ReportRow, pins: Pins): FounderEvidenceAuthority { return { reportId: row.id, reportHash: row.report_hash, manifestDigest: row.manifest_digest, expiresAt: row.expires_at, markdown: row.markdown, json: row.json, pins, authorityJson: row.authority_json }; }
function dto(row: ReportRow, pins: Pins) { return { ...scope(pins.member, pins.libraryId), id: row.id, reportHash: row.report_hash, manifestDigest: row.manifest_digest, createdAt: row.created_at, expiresAt: row.expires_at,
  state: row.state, canRead: row.state === "active", canRevoke: row.state === "active", employeeId: pins.employeeId, employeeVersion: pins.employeeVersion, skillId: pins.skillId, skillVersion: pins.skillVersion,
  receipts: pins.sources.map(metadata), sourceCount: pins.sources.length, markdown: row.markdown, json: row.json, canCreate: false, authorizationMode: MODE }; }
export async function loadFounderEvidenceReport(env: Env, member: WorkspaceNativeMember, libraryId: string, reportId: string, options: ReadOptions = {}) {
  return loadStoredReport(env, member, libraryId, reportId, options);
}
async function loadStoredReport(env: Env, member: WorkspaceNativeMember, libraryId: string, reportId: string, options: ReadOptions, connectionProof?: Pins) {
  await ensure(env); await assertWorkspaceMemberCurrent(env, member, true);
  const row = await env.AGENT_AUDIT.prepare("SELECT * FROM founder_evidence_reports WHERE id=? AND workspace_id=? AND owner_id=? AND owner_account_id=? AND library_id=?")
    .bind(reportId, member.workspaceId, member.userId, member.accountId, libraryId).first<ReportRow>();
  if (!row) throw new WorkspaceIntegrationError("report_unavailable", 404);
  const pins = JSON.parse(row.authority_json) as Pins;
  if (JSON.stringify(pins.member) !== JSON.stringify(member) || pins.recipeSha256 !== await founderConnectorRecipeHash(libraryId) || await hashToolArgs(pins) !== row.manifest_digest || row.report_hash !== await sha256Hex(JSON.stringify([FORMAT, row.manifest_digest, row.expires_at, row.markdown, row.json]))) throw new WorkspaceIntegrationError("report_sources_changed", 409);
  for (const item of pins.sources) if (item.binding.founderContext) item.founderRecipeSha256 = await founderConnectorRecipeHash(item.binding.founderContext.libraryId);
  const value = authority(row, pins);
  if (!connectionProof || JSON.stringify(connectionProof.sources) !== JSON.stringify(pins.sources)) await connectionAuth(env, member, pins.sources);
  const guard = founderEvidenceReportGuard(value, options);
  await options.beforeFinalRead?.();
  if (!await env.AGENT_AUDIT.prepare(`SELECT 1 AS current WHERE ${guard.sql}`).bind(...guard.values).first()) throw new WorkspaceIntegrationError("report_sources_changed", 409);
  return { report: dto(row, pins), authority: value };
}
export async function revokeFounderEvidenceReport(env: Env, member: WorkspaceNativeMember, libraryId: string, reportId: string, reportHash: string, options: ReadOptions = {}) {
  await ensure(env); const actor = membershipSql(member, true);
  const row = await env.AGENT_AUDIT.prepare("SELECT * FROM founder_evidence_reports WHERE id=? AND workspace_id=? AND owner_id=? AND owner_account_id=? AND library_id=? AND report_hash=?")
    .bind(reportId, member.workspaceId, member.userId, member.accountId, libraryId, reportHash).first<ReportRow>();
  if (!row) throw new WorkspaceIntegrationError("report_unavailable", 404);
  await options.beforeFinalRead?.();
  const result = await env.AGENT_AUDIT.prepare(`UPDATE founder_evidence_reports SET state='revoked' WHERE id=? AND workspace_id=? AND owner_id=? AND owner_account_id=? AND library_id=? AND report_hash=? AND ${actor.sql}`)
    .bind(reportId, member.workspaceId, member.userId, member.accountId, libraryId, reportHash, ...actor.values).run();
  if (result.meta.changes !== 1) throw new WorkspaceIntegrationError("report_unavailable", 404);
  return { ...scope(member, libraryId), report: summary({ ...row, state: "revoked" }, JSON.parse(row.authority_json) as Pins, false) };
}

function summary(row: ReportRow, pins: Pins, readable: boolean) { return { id: row.id, reportHash: row.report_hash, createdAt: row.created_at, expiresAt: row.expires_at,
  state: row.state, canRead: readable, canRevoke: row.state === "active", employeeId: pins.employeeId, employeeVersion: pins.employeeVersion, sourceCount: pins.sources.length }; }
export async function listFounderEvidenceReports(env: Env, member: WorkspaceNativeMember, libraryId: string, options: ReadOptions = {}) {
  await ensure(env); const actor = membershipSql(member, true);
  await options.beforeFinalRead?.();
  // Summaries contain no receipt content; full source authorization occurs on an explicit read.
  const rows = await env.AGENT_AUDIT.prepare(`SELECT * FROM founder_evidence_reports WHERE workspace_id=? AND owner_id=? AND owner_account_id=? AND library_id=? AND ${actor.sql} ORDER BY created_at DESC,id LIMIT 100`)
    .bind(member.workspaceId, member.userId, member.accountId, libraryId, ...actor.values).all<ReportRow>();
  return { ...scope(member, libraryId), reports: rows.results.map((row) => summary(row, JSON.parse(row.authority_json) as Pins, row.state === "active" && row.expires_at > Date.now())) };
}
export async function founderEvidenceOptions(env: Env, member: WorkspaceNativeMember, libraryId: string, employeeId?: string, employeeVersion?: number, options: ReadOptions = {}) {
  await ensure(env); await assertWorkspaceMemberCurrent(env, member, true);
  if (!getFounderSkillLibraryEntry(libraryId)) throw new WorkspaceIntegrationError("report_recipe_unavailable", 404);
  const install = await getSkillInstall(env, `team:${member.workspaceId}`, member.userId, libraryId);
  const skill = install ? await getSkill(env, `team:${member.workspaceId}`, member.userId, install.skillId) : null;
  const employees = await listCustomAgents(env, `team:${member.workspaceId}`);
  const reviewed = skill && skill.status === "active" && skill.activeVersion === skill.version && skill.reviewedVersion === skill.version && skill.reviewedInstructions === skill.content.instructions;
  const selected = employeeId && employeeVersion ? await sources(env, member, libraryId, employeeId, employeeVersion) : [];
  await connectionAuth(env, member, selected);
  const employee = employees.find((item) => item.id === employeeId && item.version === employeeVersion);
  const actor = membershipSql(member, true), recipe = await founderConnectorRecipeHash(libraryId);
  const pins: Pins | null = reviewed && employee && recipe ? { member, libraryId, recipeSha256: recipe, employeeId: employee.id, employeeVersion: employee.version, employeeConfig: JSON.stringify(employee.config),
    skillId: skill!.id, skillVersion: skill!.version, skillInstructions: skill!.content.instructions, skillSource: skill!.content.sourceUrl ?? null, sources: selected,
    expiresAt: Math.min(Date.now() + 900_000, ...selected.map((item) => item.binding.founderContext?.expiresAt ?? Number.MAX_SAFE_INTEGER)) } : null;
  const guard = pins ? pinsGuard(pins) : actor;
  await options.beforeFinalRead?.();
  if (!await env.AGENT_AUDIT.prepare(`SELECT 1 AS current WHERE ${guard.sql}`).bind(...guard.values).first()) throw new WorkspaceIntegrationError("report_sources_changed", 409);
  return { ...scope(member, libraryId), employees: employees.slice(0,100).map((item) => ({ id:item.id, version:item.version, name:item.config.name })),
    skill: reviewed ? { id:skill!.id, version:skill!.version, name:skill!.content.name } : null,
    receipts: pins ? selected.map(metadata) : [], authorizationMode: MODE };
}
