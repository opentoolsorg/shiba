/** Storage-only recurring founder review drafts. Never imports a model, provider or run dispatcher. */
import {
  founderReviewScheduleInputSchema, getFounderSkillLibraryEntry,
  type FounderReviewOccurrence, type FounderReviewScheduleContract,
  type FounderReviewScheduleRecord, type FounderReviewScheduleState,
} from "@shiba/shared";
import type { AuditEnv } from "./audit.js";
import type { Env } from "./env.js";
import { sha256Hex } from "./agent-tokens.js";
import { scheduleOccurrenceMs } from "./automations.js";
import { getCustomAgentById } from "./custom-agents-store.js";
import { getSkill } from "./skills-store.js";
import { getSkillInstall } from "./skill-library-store.js";
import { randomHex } from "./mailbox-store.js";
import { COLLAB_TENANT_ID } from "./collaboration-store.js";
import type { TeamSkillGrant } from "./team-skill-grant.js";
import { nativeWorkspaceAccountSql } from "./workspace-native-authority.js";

const REVIEW_TTL = 15 * 60_000;
const MAX_LIFETIME = 90 * 86_400_000;
const TICK_LIMIT = 100;
const initialized = new WeakSet<D1Database>();
const schema = [
  `CREATE TABLE IF NOT EXISTS founder_review_schedules (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL, owner_id TEXT NOT NULL, owner_account_id TEXT NOT NULL, library_id TEXT NOT NULL,
    version INTEGER NOT NULL, digest TEXT NOT NULL, contract_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('draft','enabled','paused','revoked','blocked')),
    review_expires_at INTEGER NOT NULL, next_due_at INTEGER NOT NULL,
    checked_at INTEGER NOT NULL, blocked_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(org_id,owner_account_id,library_id))`,
  `CREATE INDEX IF NOT EXISTS founder_review_due ON founder_review_schedules(state,checked_at)`,
  `CREATE TABLE IF NOT EXISTS founder_review_occurrences (
    id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, schedule_version INTEGER NOT NULL,
    digest TEXT NOT NULL, scheduled_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','dismissed','cancelled')), task TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS founder_review_pending ON founder_review_occurrences(schedule_id,status)`,
];
type Row = {
  id: string; org_id: string; owner_id: string; owner_account_id: string; library_id: string; version: number; digest: string;
  contract_json: string; state: FounderReviewScheduleState; review_expires_at: number; next_due_at: number;
  blocked_reason: string | null;
};
export class FounderReviewError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}
export interface FounderReviewActor { orgId: string; ownerId: string; ownerAccountId: string; teamGrant?: TeamSkillGrant }
const changed = (result: D1Result | undefined) => result?.meta.changes === 1;
// Production expiry is checked when D1 commits, not when an earlier read began.
// An explicit logical timestamp is reserved for deterministic store fixtures.
function commitClock(logicalNow?: number): { sql: string; values: unknown[] } {
  return logicalNow === undefined ? { sql: "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)", values: [] }
    : { sql: "?", values: [logicalNow] };
}
async function ensure(env: AuditEnv): Promise<void> {
  if (initialized.has(env.AGENT_AUDIT)) return;
  for (const sql of schema) await env.AGENT_AUDIT.prepare(sql).run();
  initialized.add(env.AGENT_AUDIT);
}

function membershipGuard(contract: Pick<FounderReviewScheduleContract, "orgId" | "ownerId" | "membership">): { sql: string; values: unknown[] } {
  const member = contract.membership;
  if (!member) {
    if (contract.orgId.startsWith("team:")) throw new FounderReviewError("workspace_authority_changed", 403);
    return { sql: "1=1", values: [] };
  }
  if (contract.orgId !== `team:${member.workspaceId}`) throw new FounderReviewError("workspace_authority_changed", 403);
  return { sql: `EXISTS (SELECT 1 FROM team_workspace_memberships WHERE tenant_id=? AND workspace_id=? AND user_id=? AND status='active' AND role=? AND role IN ('owner','admin') AND version=?)`,
    values: [COLLAB_TENANT_ID, member.workspaceId, contract.ownerId, member.role, member.version] };
}
function actorGuard(actor: FounderReviewActor) {
  if (actor.teamGrant && actor.ownerId !== actor.teamGrant.userId) throw new FounderReviewError("workspace_authority_changed", 403);
  return identityGuard({ orgId: actor.orgId, ownerId: actor.ownerId, ownerAccountId: actor.ownerAccountId, membership: actor.teamGrant ?? null });
}
function identityGuard(contract: Pick<FounderReviewScheduleContract, "orgId" | "ownerId" | "ownerAccountId" | "membership">) {
  const membership = membershipGuard(contract);
  const native = nativeWorkspaceAccountSql({ accountId: contract.ownerAccountId, userId: contract.ownerId });
  return { sql: `${membership.sql} AND ${native.sql}`, values: [...membership.values, ...native.values] };
}
export async function isFounderReviewActorCurrent(env: AuditEnv, actor: FounderReviewActor): Promise<boolean> {
  try {
    const guard = actorGuard(actor);
    return Boolean(await env.AGENT_AUDIT.prepare(`SELECT 1 AS current WHERE ${guard.sql}`).bind(...guard.values).first());
  } catch { return false; }
}
/** All source and membership checks also appear in the final DML/read statement. */
function sourceGuard(contract: FounderReviewScheduleContract): { sql: string; values: unknown[] } {
  const member = identityGuard(contract);
  return { sql: `${member.sql}
    AND EXISTS (SELECT 1 FROM org_custom_agents WHERE org_id=? AND id=? AND version=? AND config_json=? AND archived_at IS NULL AND deleted_at IS NULL)
    AND EXISTS (SELECT 1 FROM skills s JOIN skill_versions v ON v.skill_id=s.id AND v.version=s.version
      WHERE s.org_id=? AND s.owner_id=? AND s.id=? AND s.version=? AND s.status='active'
      AND s.active_version=s.version AND s.reviewed_version=s.version AND s.reviewed_instructions=?
      AND v.instructions=? AND v.source_url IS ?)
    AND EXISTS (SELECT 1 FROM skill_installs WHERE org_id=? AND installed_by=? AND library_slug=? AND skill_id=?)`,
    values: [...member.values, contract.orgId, contract.employeeId, contract.employeeVersion, contract.employeeConfig,
      contract.orgId, contract.ownerId, contract.skillId, contract.skillVersion, contract.skillInstructions,
      contract.skillInstructions, contract.skillSource, contract.orgId, contract.ownerId, contract.libraryId, contract.skillId] };
}

function cronFor(input: { localTime: string; cadence: "daily" | "weekly"; weekday?: number }): string {
  const [hour, minute] = input.localTime.split(":").map(Number);
  return `${minute} ${hour} * * ${input.cadence === "weekly" ? input.weekday : "*"}`;
}
/**
 * Find a real future wall-clock occurrence, including gaps/repeats at DST.
 * Daily/weekly only. Candidate offsets are sampled around each local date;
 * the existing scheduler matcher is the final authority. At most 9 dates.
 */
export function nextFounderReviewDue(contract: Pick<FounderReviewScheduleContract, "timezone" | "localTime" | "cron">, afterMs: number): number {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: contract.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const parts = (at: number) => {
    const p = format.formatToParts(at);
    const n = (type: string) => Number(p.find((part) => part.type === type)?.value);
    return { year: n("year"), month: n("month"), day: n("day"), hour: n("hour"), minute: n("minute") };
  };
  const now = parts(afterMs);
  const [hour, minute] = contract.localTime.split(":").map(Number);
  const candidates: number[] = [];
  for (let day = 0; day <= 8; day++) {
    const local = Date.UTC(now.year, now.month - 1, now.day + day, hour, minute);
    const offsets = new Set<number>();
    for (const shift of [-36, -12, 0, 12, 36]) {
      const sample = local + shift * 3_600_000;
      const p = parts(sample);
      offsets.add(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - sample);
    }
    for (const offset of offsets) {
      const at = local - offset;
      if (at > afterMs && scheduleOccurrenceMs(contract.cron, at, contract.timezone) === at) candidates.push(at);
    }
  }
  if (!candidates.length) throw new FounderReviewError("schedule_occurrence_unavailable", 400);
  return Math.min(...candidates);
}

function dto(row: Row): FounderReviewScheduleRecord {
  return { id: row.id, version: row.version, digest: row.digest, state: row.state,
    contract: JSON.parse(row.contract_json) as FounderReviewScheduleContract,
    reviewExpiresAt: row.review_expires_at, nextDueAt: row.next_due_at,
    ...(row.blocked_reason ? { blockedReason: row.blocked_reason } : {}) };
}
async function recipeCurrent(contract: FounderReviewScheduleContract): Promise<boolean> {
  const recipe = getFounderSkillLibraryEntry(contract.libraryId);
  return Boolean(recipe && contract.recipeSha256 === await sha256Hex(JSON.stringify(recipe)));
}
async function raw(env: AuditEnv, actor: FounderReviewActor, libraryId: string): Promise<Row | null> {
  const grant = actorGuard(actor);
  return env.AGENT_AUDIT.prepare(`SELECT * FROM founder_review_schedules WHERE org_id=? AND owner_id=? AND owner_account_id=? AND library_id=? AND ${grant.sql}`)
    .bind(actor.orgId, actor.ownerId, actor.ownerAccountId, libraryId, ...grant.values).first<Row>();
}

export async function prepareFounderReviewSchedule(env: AuditEnv, actor: FounderReviewActor, libraryId: string, body: unknown, now = Date.now()): Promise<FounderReviewScheduleRecord> {
  actorGuard(actor);
  const parsed = founderReviewScheduleInputSchema.safeParse(body);
  if (!parsed.success) throw new FounderReviewError("invalid_review_schedule", 400);
  const input = parsed.data;
  if (input.expiresAt <= now || input.expiresAt > now + MAX_LIFETIME) throw new FounderReviewError("schedule_expiry_out_of_range", 400);
  const entry = getFounderSkillLibraryEntry(libraryId);
  if (!entry) throw new FounderReviewError("not_found", 404);
  const [skill, employee, install] = await Promise.all([
    getSkill(env, actor.orgId, actor.ownerId, input.skillId), getCustomAgentById(env, actor.orgId, input.employeeId),
    getSkillInstall(env, actor.orgId, actor.ownerId, libraryId),
  ]);
  if (!skill || skill.status !== "active" || skill.version !== input.skillVersion || skill.activeVersion !== skill.version ||
      skill.reviewedVersion !== skill.version || skill.reviewedInstructions !== skill.content.instructions || install?.skillId !== skill.id)
    throw new FounderReviewError("reviewed_active_founder_skill_required");
  if (!employee || employee.version !== input.employeeVersion) throw new FounderReviewError("employee_version_changed");
  const { expectedVersion: _expected, ...requested } = input;
  const contract: FounderReviewScheduleContract = {
    ...requested, format: "shiba.founder-review.v1", orgId: actor.orgId, ownerId: actor.ownerId, ownerAccountId: actor.ownerAccountId, libraryId,
    recipeSha256: await sha256Hex(JSON.stringify(entry)), membership: actor.teamGrant ? {
      workspaceId: actor.teamGrant.workspaceId, version: actor.teamGrant.version, role: actor.teamGrant.role,
    } : null,
    employeeConfig: JSON.stringify(employee.config), employeeName: employee.config.name,
    skillInstructions: skill.content.instructions, skillName: skill.content.name, skillSource: skill.content.sourceUrl ?? null,
    cron: cronFor(input), task: entry.automationPrompt, requiredSources: [...entry.integrationCatalogIds],
  };
  const nextDueAt = nextFounderReviewDue(contract, now);
  await ensure(env);
  const prior = await raw(env, actor, libraryId);
  if ((input.expectedVersion ?? 0) !== (prior?.version ?? 0)) throw new FounderReviewError("schedule_version_conflict");
  const id = prior?.id ?? `frs-${randomHex(16)}`, version = (prior?.version ?? 0) + 1;
  // The reviewed digest includes this configuration revision, not just its prose.
  // Later lifecycle CAS versions do not change the reviewed configuration.
  const digest = await sha256Hex(JSON.stringify({ id, configurationVersion: version, contract }));
  const guard = sourceGuard(contract);
  const values = [version, digest, JSON.stringify(contract), now + REVIEW_TTL, nextDueAt, now, now];
  const statement = prior
    ? env.AGENT_AUDIT.prepare(`UPDATE founder_review_schedules SET version=?,digest=?,contract_json=?,state='draft',review_expires_at=?,next_due_at=?,checked_at=?,updated_at=?,blocked_reason=NULL WHERE id=? AND version=? AND ${guard.sql}`)
      .bind(...values, id, prior.version, ...guard.values)
    : env.AGENT_AUDIT.prepare(`INSERT OR IGNORE INTO founder_review_schedules (version,digest,contract_json,state,review_expires_at,next_due_at,checked_at,updated_at,id,org_id,owner_id,owner_account_id,library_id,created_at)
      SELECT ?,?,?,'draft',?,?,?,?,?,?,?,?,?,? WHERE ${guard.sql} AND (SELECT COUNT(*) FROM founder_review_schedules)<1000`)
      .bind(...values, id, actor.orgId, actor.ownerId, actor.ownerAccountId, libraryId, now, ...guard.values);
  const result = await env.AGENT_AUDIT.batch([statement,
    env.AGENT_AUDIT.prepare(`UPDATE founder_review_occurrences SET status='cancelled' WHERE schedule_id=? AND status='pending' AND changes()=1`).bind(id),
  ]);
  if (!changed(result[0])) throw new FounderReviewError("schedule_sources_or_version_changed");
  return { id, version, digest, contract, state: "draft", reviewExpiresAt: now + REVIEW_TTL, nextDueAt };
}

export async function readFounderReviewSchedule(env: AuditEnv, actor: FounderReviewActor, libraryId: string): Promise<{ schedule: FounderReviewScheduleRecord | null; occurrences: FounderReviewOccurrence[]; unavailableReason?: string; staleSchedule?: Pick<FounderReviewScheduleRecord, "id" | "version" | "digest" | "state"> }> {
  await ensure(env);
  const row = await raw(env, actor, libraryId);
  if (!row) {
    if (!await isFounderReviewActorCurrent(env, actor)) throw new FounderReviewError("founder_authority_changed", 403);
    return { schedule: null, occurrences: [] };
  }
  const schedule = dto(row), guard = sourceGuard(schedule.contract);
  if (!await recipeCurrent(schedule.contract)) {
    const latest = await raw(env, actor, libraryId);
    if (!latest && !await isFounderReviewActorCurrent(env, actor)) throw new FounderReviewError("founder_authority_changed", 403);
    return latest ? { schedule: null, occurrences: [], unavailableReason: "recipe_changed", staleSchedule: { id: latest.id, version: latest.version, digest: latest.digest, state: latest.state } } : { schedule: null, occurrences: [] };
  }
  const occurrences = await env.AGENT_AUDIT.prepare(`SELECT id,schedule_id AS scheduleId,schedule_version AS scheduleVersion,digest,scheduled_at AS scheduledAt,created_at AS createdAt,status,task FROM founder_review_occurrences WHERE schedule_id=? ORDER BY created_at DESC,id DESC LIMIT 50`).bind(row.id).all<FounderReviewOccurrence>();
  const current = await env.AGENT_AUDIT.prepare(`SELECT * FROM founder_review_schedules WHERE id=? AND version=? AND ${guard.sql}`)
    .bind(row.id, row.version, ...guard.values).first<Row>();
  if (!current) {
    // Return only non-content lifecycle metadata, fenced against the current actor.
    const latest = await raw(env, actor, libraryId);
    if (!latest && !await isFounderReviewActorCurrent(env, actor)) throw new FounderReviewError("founder_authority_changed", 403);
    return latest ? { schedule: null, occurrences: [], unavailableReason: "schedule_sources_or_authority_changed",
      staleSchedule: { id: latest.id, version: latest.version, digest: latest.digest, state: latest.state } } : { schedule: null, occurrences: [] };
  }
  return { schedule: dto(current), occurrences: occurrences.results ?? [] };
}

export async function decideFounderReviewSchedule(env: AuditEnv, actor: FounderReviewActor, libraryId: string, action: "enable" | "pause" | "resume" | "revoke", input: { expectedVersion: number; digest: string; reviewed: true }, logicalNow?: number): Promise<FounderReviewScheduleRecord> {
  if (input.reviewed !== true) throw new FounderReviewError("exact_review_decision_required", 400);
  await ensure(env);
  const row = await raw(env, actor, libraryId);
  if (!row || row.version !== input.expectedVersion || row.digest !== input.digest) throw new FounderReviewError("schedule_version_conflict");
  const schedule = dto(row), guard = action === "revoke" ? actorGuard(actor) : sourceGuard(schedule.contract);
  if (action !== "revoke" && !await recipeCurrent(schedule.contract)) throw new FounderReviewError("recipe_changed");
  const now = logicalNow ?? Date.now(), clock = commitClock(logicalNow);
  if (action === "enable" && (row.state !== "draft" || row.review_expires_at <= now)) throw new FounderReviewError("schedule_review_expired_or_changed");
  if (action === "resume" && row.state !== "paused") throw new FounderReviewError("schedule_not_paused");
  if (action === "pause" && row.state !== "enabled") throw new FounderReviewError("schedule_not_enabled");
  if (row.state === "revoked") throw new FounderReviewError("schedule_revoked");
  const state = action === "enable" || action === "resume" ? "enabled" : action === "pause" ? "paused" : "revoked";
  if (state === "enabled" && schedule.contract.expiresAt <= now) throw new FounderReviewError("schedule_expired");
  const nextDueAt = state === "enabled" ? nextFounderReviewDue(schedule.contract, now) : row.next_due_at;
  const result = await env.AGENT_AUDIT.batch([
    env.AGENT_AUDIT.prepare(`UPDATE founder_review_schedules SET version=version+1,state=?,next_due_at=?,updated_at=?,blocked_reason=NULL WHERE id=? AND version=? AND digest=? AND state=? AND ${guard.sql}
      AND (?<>'enabled' OR json_extract(contract_json,'$.expiresAt')>${clock.sql}) AND (?<>'enable' OR review_expires_at>${clock.sql})`)
      .bind(state, nextDueAt, now, row.id, row.version, input.digest, row.state, ...guard.values, state, ...clock.values, action, ...clock.values),
    env.AGENT_AUDIT.prepare(`UPDATE founder_review_occurrences SET status='cancelled' WHERE schedule_id=? AND status='pending' AND changes()=1`).bind(row.id),
  ]);
  if (!changed(result[0])) throw new FounderReviewError("schedule_sources_or_version_changed");
  return { ...schedule, version: row.version + 1, state, nextDueAt };
}

export async function dismissFounderReviewOccurrence(env: AuditEnv, actor: FounderReviewActor, libraryId: string, occurrenceId: string, input: { expectedVersion: number; digest: string; reviewed: true }): Promise<void> {
  if (input.reviewed !== true) throw new FounderReviewError("exact_review_decision_required", 400);
  await ensure(env);
  const row = await raw(env, actor, libraryId);
  if (!row || row.version !== input.expectedVersion || row.digest !== input.digest) throw new FounderReviewError("schedule_version_conflict");
  const contract = dto(row).contract, guard = sourceGuard(contract);
  if (!await recipeCurrent(contract)) throw new FounderReviewError("recipe_changed");
  const result = await env.AGENT_AUDIT.prepare(`UPDATE founder_review_occurrences SET status='dismissed' WHERE id=? AND schedule_id=? AND status='pending'
    AND EXISTS (SELECT 1 FROM founder_review_schedules WHERE id=? AND version=? AND state='enabled' AND ${guard.sql})`)
    .bind(occurrenceId, row.id, row.id, row.version, ...guard.values).run();
  if (!changed(result)) throw new FounderReviewError("review_occurrence_changed");
}

/**
 * Reuses the platform cron cadence, with D1-only effects. A batch atomically
 * invalidates stale jobs, inserts at most one pending draft and advances due.
 * A lost response/restart cannot dispatch a command: no dispatcher exists here.
 */
export async function tickFounderReviewSchedules(env: Pick<Env, "AGENT_AUDIT">, logicalNow?: number): Promise<{ created: number; blocked: number }> {
  if (!env.AGENT_AUDIT) return { created: 0, blocked: 0 };
  const clock = commitClock(logicalNow);
  await ensure(env as AuditEnv);
  const rows = await env.AGENT_AUDIT.prepare(`SELECT * FROM founder_review_schedules WHERE state='enabled' ORDER BY checked_at,id LIMIT ?`).bind(TICK_LIMIT).all<Row>();
  let created = 0, blocked = 0;
  for (const row of rows.results ?? []) {
    const contract = dto(row).contract, guard = sourceGuard(contract);
    const recipeValid = await recipeCurrent(contract);
    const now = logicalNow ?? Date.now();
    const nextDue = row.next_due_at <= now ? nextFounderReviewDue(contract, now) : row.next_due_at;
    const occurrenceId = `${row.id}:${row.version}:${row.next_due_at}`;
    const result = await env.AGENT_AUDIT.batch([
      env.AGENT_AUDIT.prepare(`UPDATE founder_review_schedules SET state='blocked',version=version+1,blocked_reason='schedule_sources_authority_or_expiry_changed',checked_at=?,updated_at=?
        WHERE id=? AND version=? AND state='enabled' AND (?=0 OR ?<=${clock.sql} OR NOT (${guard.sql}))`)
        .bind(now, now, row.id, row.version, recipeValid ? 1 : 0, contract.expiresAt, ...clock.values, ...guard.values),
      env.AGENT_AUDIT.prepare(`UPDATE founder_review_occurrences SET status='cancelled' WHERE schedule_id=? AND status='pending' AND EXISTS (SELECT 1 FROM founder_review_schedules WHERE id=? AND state='blocked')`).bind(row.id, row.id),
      env.AGENT_AUDIT.prepare(`INSERT OR IGNORE INTO founder_review_occurrences(id,schedule_id,schedule_version,digest,scheduled_at,created_at,status,task)
        SELECT ?,id,version,digest,next_due_at,?,'pending',? FROM founder_review_schedules WHERE id=? AND version=? AND state='enabled' AND next_due_at<=? AND ?=1 AND ?>${clock.sql} AND ${guard.sql}
        AND NOT EXISTS (SELECT 1 FROM founder_review_occurrences WHERE schedule_id=? AND status='pending')`)
        .bind(occurrenceId, now, contract.task, row.id, row.version, now, recipeValid ? 1 : 0, contract.expiresAt, ...clock.values, ...guard.values, row.id),
      env.AGENT_AUDIT.prepare(`UPDATE founder_review_schedules SET next_due_at=?,checked_at=?,updated_at=? WHERE id=? AND version=? AND state='enabled' AND ${guard.sql}`)
        .bind(nextDue, now, now, row.id, row.version, ...guard.values),
      env.AGENT_AUDIT.prepare(`DELETE FROM founder_review_occurrences WHERE schedule_id=? AND status<>'pending' AND id NOT IN (SELECT id FROM founder_review_occurrences WHERE schedule_id=? ORDER BY created_at DESC,id DESC LIMIT 50)`).bind(row.id, row.id),
    ]);
    if (changed(result[0])) blocked++;
    if (changed(result[2])) created++;
  }
  return { created, blocked };
}
