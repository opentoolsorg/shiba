import {
  validateEmployeeBundle,
  type EmployeeBundle,
  type EmployeeBundleImportResult,
  type EmployeeBundlePreview,
} from "@shiba/shared";
import type { AuditEnv } from "./audit.js";
import { getCustomAgentById } from "./custom-agents-store.js";
import { getSkill } from "./skills-store.js";
import { randomHex } from "./mailbox-store.js";

const PREVIEW_TTL = 15 * 60_000;
const initialized = new WeakSet<D1Database>();

export class EmployeeBundleError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

async function ensureTables(env: AuditEnv): Promise<void> {
  if (initialized.has(env.AGENT_AUDIT)) return;
  // These public reads initialize the existing schemas without changing their contracts.
  await getCustomAgentById(env, "_bundle_schema", "_bundle_schema");
  await getSkill(env, "_bundle_schema", "_bundle_schema", "_bundle_schema");
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS employee_bundle_profile_owners (
      org_id TEXT NOT NULL, employee_id TEXT NOT NULL, owner_id TEXT NOT NULL,
      PRIMARY KEY (org_id, employee_id))`,
    `CREATE TABLE IF NOT EXISTS employee_bundle_previews (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, owner_id TEXT NOT NULL,
      digest TEXT NOT NULL, recipe_json TEXT NOT NULL, expires_at INTEGER NOT NULL,
      consumed_import_id TEXT)`,
    `CREATE TABLE IF NOT EXISTS employee_bundle_imports (
      org_id TEXT NOT NULL, owner_id TEXT NOT NULL, import_id TEXT NOT NULL,
      preview_id TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, employee_id TEXT NOT NULL,
      recipe_json TEXT NOT NULL, result_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (org_id, owner_id, import_id))`,
  ]) await env.AGENT_AUDIT.prepare(sql).run();
  initialized.add(env.AGENT_AUDIT);
}

/** Capture only at authenticated creation; never infer ownership from org-wide visibility. */
export async function recordEmployeeBundleProfileOwner(
  env: AuditEnv, orgId: string, employeeId: string, ownerId: string,
): Promise<void> {
  await ensureTables(env);
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO employee_bundle_profile_owners (org_id,employee_id,owner_id) VALUES (?,?,?)
     ON CONFLICT (org_id,employee_id) DO NOTHING`,
  ).bind(orgId, employeeId, ownerId).run();
}

export async function employeeBundleDigest(recipe: EmployeeBundle): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(validateEmployeeBundle(recipe)));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function previewEmployeeBundle(
  env: AuditEnv, orgId: string, ownerId: string, input: unknown, now = Date.now(),
): Promise<EmployeeBundlePreview> {
  const recipe = validateEmployeeBundle(input);
  const digest = await employeeBundleDigest(recipe);
  await ensureTables(env);
  const previewId = `ebp-${randomHex(16)}`;
  const expiresAt = now + PREVIEW_TTL;
  await env.AGENT_AUDIT.prepare(
    `DELETE FROM employee_bundle_previews WHERE org_id=? AND owner_id=? AND expires_at<=? AND consumed_import_id IS NULL`,
  ).bind(orgId, ownerId, now).run();
  const inserted = await env.AGENT_AUDIT.prepare(
    `INSERT INTO employee_bundle_previews (id,org_id,owner_id,digest,recipe_json,expires_at)
     SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM employee_bundle_previews
       WHERE org_id=? AND owner_id=? AND expires_at>? AND consumed_import_id IS NULL)<50`,
  ).bind(previewId, orgId, ownerId, digest, JSON.stringify(recipe), expiresAt, orgId, ownerId, now).run();
  if (inserted.meta.changes !== 1) throw new EmployeeBundleError("too_many_pending_bundle_previews", 429);
  return { previewId, digest, expiresAt, recipe };
}

export async function exportEmployeeBundle(
  env: AuditEnv, orgId: string, ownerId: string,
  input: { employeeId: string; expectedVersion: number; skillPins: Array<{ skillId: string; version: number }>;
    requirements?: EmployeeBundle["requirements"]; routines?: EmployeeBundle["routines"] },
): Promise<EmployeeBundle> {
  await ensureTables(env);
  const ownership = await env.AGENT_AUDIT.prepare(
    `SELECT employee_id FROM employee_bundle_profile_owners WHERE org_id=? AND employee_id=? AND owner_id=?`,
  ).bind(orgId, input.employeeId, ownerId).first();
  if (!ownership) throw new EmployeeBundleError("profile_owner_required", 404);
  const profile = await getCustomAgentById(env, orgId, input.employeeId, { includeArchived: true });
  if (!profile) throw new EmployeeBundleError("profile_unavailable", 404);
  if (profile.version !== input.expectedVersion) throw new EmployeeBundleError("profile_version_changed", 409);
  const previousImport = await env.AGENT_AUDIT.prepare(
    `SELECT recipe_json FROM employee_bundle_imports WHERE org_id=? AND owner_id=? AND employee_id=?`,
  ).bind(orgId, ownerId, profile.id).first<{ recipe_json: string }>();
  const previousRecipe = previousImport ? validateEmployeeBundle(JSON.parse(previousImport.recipe_json)) : null;
  if (input.skillPins.length > 5 || new Set(input.skillPins.map((pin) => pin.skillId)).size !== input.skillPins.length)
    throw new EmployeeBundleError("invalid_skill_selection");
  const skills: EmployeeBundle["skills"] = [];
  for (const pin of input.skillPins) {
    const skill = await getSkill(env, orgId, ownerId, pin.skillId, { includeSharedActive: true });
    // Only currently active exact versions are portable, including the owner's sources.
    if (!skill || skill.status !== "active" || skill.activeVersion !== pin.version || skill.content.version !== pin.version)
      throw new EmployeeBundleError("skill_source_changed_or_unavailable", 409);
    skills.push({ name: skill.content.name, instructions: skill.content.instructions,
      provenance: { kind: "managed-skill", id: skill.id, revision: String(pin.version) } });
  }
  const config = profile.config;
  return validateEmployeeBundle({
    format: "shiba.employee-bundle.v1", audience: "personal",
    profile: { name: config.name, instructions: config.instructions, harness: config.harness,
      ...(config.codingModel ? { codingModel: config.codingModel } : {}),
      ...(config.emoji ? { emoji: config.emoji } : {}),
      ...(config.mascotPreset ? { mascotPreset: config.mascotPreset } : {}),
      ...(config.look ? { look: config.look } : {}),
      ...(config.roleTemplateId ? { roleTemplateId: config.roleTemplateId } : {}),
      expectedDeliverables: config.expectedDeliverables ?? [],
      provenance: { kind: "employee", id: profile.id, revision: String(profile.version) } },
    skills, requirements: input.requirements ?? previousRecipe?.requirements ?? [],
    routines: input.routines ?? previousRecipe?.routines ?? [],
  });
}

async function receipt(env: AuditEnv, orgId: string, ownerId: string, importId: string) {
  return env.AGENT_AUDIT.prepare(
    `SELECT digest,result_json FROM employee_bundle_imports WHERE org_id=? AND owner_id=? AND import_id=?`,
  ).bind(orgId, ownerId, importId).first<{ digest: string; result_json: string }>();
}

/** One transaction creates the archived profile, immutable versions, draft skills and receipt. */
export async function importEmployeeBundle(
  env: AuditEnv, orgId: string, ownerId: string,
  input: { previewId: string; expectedDigest: string; importId: string; recipe: unknown },
  now = Date.now(),
): Promise<EmployeeBundleImportResult> {
  const recipe = validateEmployeeBundle(input.recipe);
  const digest = await employeeBundleDigest(recipe);
  if (digest !== input.expectedDigest) throw new EmployeeBundleError("preview_digest_mismatch", 409);
  await ensureTables(env);
  const previous = await receipt(env, orgId, ownerId, input.importId);
  if (previous) {
    if (previous.digest !== digest) throw new EmployeeBundleError("import_id_conflict", 409);
    return JSON.parse(previous.result_json) as EmployeeBundleImportResult;
  }
  const employeeId = `cag-${randomHex(12)}`;
  const skillIds = recipe.skills.map(() => `skill-${randomHex(12)}`);
  const result: EmployeeBundleImportResult = { employeeId, skillIds, profileState: "archived_pending_review",
    skillState: "draft", requirementsState: "unconfigured", routinesState: "descriptions_only" };
  const config = JSON.stringify({ name: recipe.profile.name, instructions: recipe.profile.instructions,
    harness: recipe.profile.harness, ...(recipe.profile.emoji ? { emoji: recipe.profile.emoji } : {}),
    ...(recipe.profile.codingModel ? { codingModel: recipe.profile.codingModel } : {}),
    ...(recipe.profile.mascotPreset ? { mascotPreset: recipe.profile.mascotPreset } : {}),
    ...(recipe.profile.look ? { look: recipe.profile.look } : {}),
    ...(recipe.profile.roleTemplateId ? { roleTemplateId: recipe.profile.roleTemplateId } : {}),
    expectedDeliverables: recipe.profile.expectedDeliverables, approvalPolicy: "standard" });
  const gate = `EXISTS (SELECT 1 FROM employee_bundle_imports WHERE org_id=? AND owner_id=? AND import_id=? AND employee_id=?)`;
  const gateArgs = [orgId, ownerId, input.importId, employeeId];
  const statements = [
    env.AGENT_AUDIT.prepare(
      `INSERT INTO employee_bundle_imports (org_id,owner_id,import_id,preview_id,digest,employee_id,recipe_json,result_json,created_at)
       SELECT ?,?,?,?,?,?,?,?,? FROM employee_bundle_previews
       WHERE id=? AND org_id=? AND owner_id=? AND digest=? AND recipe_json=? AND expires_at>? AND consumed_import_id IS NULL`,
    ).bind(orgId, ownerId, input.importId, input.previewId, digest, employeeId, JSON.stringify(recipe), JSON.stringify(result), now,
      input.previewId, orgId, ownerId, digest, JSON.stringify(recipe), now),
    env.AGENT_AUDIT.prepare(
      `UPDATE employee_bundle_previews SET consumed_import_id=? WHERE id=? AND ${gate}`,
    ).bind(input.importId, input.previewId, ...gateArgs),
    env.AGENT_AUDIT.prepare(
      `INSERT INTO org_custom_agents (id,org_id,slug,version,config_json,created_at,updated_at,archived_at)
       SELECT ?,?,?,1,?,?,?,? WHERE ${gate}`,
    ).bind(employeeId, orgId, `import-${randomHex(10)}`, config, now, now, now, ...gateArgs),
    env.AGENT_AUDIT.prepare(
      `INSERT INTO org_custom_agent_versions (agent_id,org_id,version,config_json,saved_at)
       SELECT ?,?,1,?,? WHERE ${gate}`,
    ).bind(employeeId, orgId, config, now, ...gateArgs),
    env.AGENT_AUDIT.prepare(
      `INSERT INTO employee_bundle_profile_owners (org_id,employee_id,owner_id) SELECT ?,?,? WHERE ${gate}`,
    ).bind(orgId, employeeId, ownerId, ...gateArgs),
  ];
  for (const [index, skill] of recipe.skills.entries()) {
    statements.push(env.AGENT_AUDIT.prepare(
      `INSERT INTO skills (id,org_id,owner_id,version,status,created_at,updated_at) SELECT ?,?,?,1,'draft',?,? WHERE ${gate}`,
    ).bind(skillIds[index], orgId, ownerId, now, now, ...gateArgs));
    statements.push(env.AGENT_AUDIT.prepare(
      `INSERT INTO skill_versions (skill_id,org_id,owner_id,version,name,instructions,created_at)
       SELECT ?,?,?,1,?,?,? WHERE ${gate}`,
    ).bind(skillIds[index], orgId, ownerId, skill.name, skill.instructions, now, ...gateArgs));
  }
  try {
    const writes = await env.AGENT_AUDIT.batch(statements);
    if (writes[0]?.meta.changes !== 1) throw new EmployeeBundleError("preview_expired_used_or_unavailable", 409);
  } catch (error) {
    // A concurrent identical retry may have committed. Unknown transport failures are reconciled by the durable receipt.
    const committed = await receipt(env, orgId, ownerId, input.importId);
    if (committed?.digest === digest) return JSON.parse(committed.result_json) as EmployeeBundleImportResult;
    throw error;
  }
  return result;
}
