import type { AuditEnv } from "../audit.js";
import { getLibrarySkill, type LibrarySkill } from "./index.js";
import { deleteSkillInstall, getSkillInstall, recordSkillInstall } from "../skill-library-store.js";
import { createSkill, disableSkill, getSkill, type SkillStatus } from "../skills-store.js";
import { teamSkillWriteGuard, type SkillMutationOptions } from "../team-skill-grant.js";

type InstallResult = { skillId: string; status: SkillStatus; created: boolean };

export async function installLibrarySkill(
  env: AuditEnv,
  orgId: string,
  ownerId: string,
  slug: string,
  options: SkillMutationOptions = {},
): Promise<InstallResult> {
  const definition = getLibrarySkill(slug);
  if (!definition) throw new Error("unknown_slug");
  return installSkillDefinition(env, orgId, ownerId, definition, options);
}

/** Shared owner-scoped CAS installation for trusted built-in catalog definitions. */
export async function installSkillDefinition(
  env: AuditEnv,
  orgId: string,
  ownerId: string,
  definition: Pick<LibrarySkill, "slug" | "name" | "version" | "instructions" | "sourceUrl">,
  options: SkillMutationOptions = {},
): Promise<InstallResult> {
  teamSkillWriteGuard(orgId, ownerId, options.teamGrant);
  const slug = definition.slug;

  const existing = await getSkillInstall(env, orgId, ownerId, slug);
  if (existing) {
    const skill = await getSkill(env, orgId, ownerId, existing.skillId);
    if (skill && skill.status !== "disabled") {
      return { skillId: existing.skillId, status: skill.status, created: false };
    }
  }

  const created = await createSkill(env, orgId, ownerId, {
    name: definition.name,
    instructions: definition.instructions,
    sourceUrl: definition.sourceUrl,
  }, Date.now(), options);
  try {
    const claimed = await recordSkillInstall(env, {
      orgId,
      librarySlug: slug,
      libraryVersion: definition.version,
      skillId: created.id,
      installedBy: ownerId,
      installedAt: Date.now(),
    }, existing?.skillId, options);
    if (claimed) return { skillId: created.id, status: "draft", created: true };
  } catch (error) {
    await disableSkill(env, orgId, ownerId, created.id, Date.now(), options);
    throw error;
  }

  await disableSkill(env, orgId, ownerId, created.id, Date.now(), options);
  const winner = await getSkillInstall(env, orgId, ownerId, slug);
  if (!winner) throw new Error("skill_install_conflict");
  const skill = await getSkill(env, orgId, ownerId, winner.skillId);
  if (!skill) throw new Error("skill_install_conflict");
  return { skillId: winner.skillId, status: skill.status, created: false };
}

export async function uninstallLibrarySkill(
  env: AuditEnv,
  orgId: string,
  ownerId: string,
  slug: string,
  options: SkillMutationOptions = {},
): Promise<boolean> {
  teamSkillWriteGuard(orgId, ownerId, options.teamGrant);
  const install = await getSkillInstall(env, orgId, ownerId, slug);
  if (!install) return false;
  await disableSkill(env, orgId, ownerId, install.skillId, Date.now(), options);
  return deleteSkillInstall(env, orgId, ownerId, slug, options);
}
