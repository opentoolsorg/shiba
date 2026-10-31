import type { AuditEnv } from "../audit.js";
import { getLibrarySkill } from "./index.js";
import { deleteSkillInstall, getSkillInstall, recordSkillInstall } from "../skill-library-store.js";
import { createSkill, disableSkill, getSkill } from "../skills-store.js";

export async function installLibrarySkill(
  env: AuditEnv,
  orgId: string,
  ownerId: string,
  slug: string,
): Promise<{ skillId: string; status: "draft"; created: boolean }> {
  const definition = getLibrarySkill(slug);
  if (!definition) throw new Error("unknown_slug");

  const existing = await getSkillInstall(env, orgId, ownerId, slug);
  if (existing) {
    const skill = await getSkill(env, orgId, ownerId, existing.skillId);
    if (skill && skill.status !== "disabled") {
      return { skillId: existing.skillId, status: "draft", created: false };
    }
  }

  const created = await createSkill(env, orgId, ownerId, {
    name: definition.name,
    instructions: definition.instructions,
    sourceUrl: definition.sourceUrl,
  });
  try {
    const claimed = await recordSkillInstall(env, {
      orgId,
      librarySlug: slug,
      libraryVersion: definition.version,
      skillId: created.id,
      installedBy: ownerId,
      installedAt: Date.now(),
    }, existing?.skillId);
    if (claimed) return { skillId: created.id, status: "draft", created: true };
  } catch (error) {
    await disableSkill(env, orgId, ownerId, created.id);
    throw error;
  }

  await disableSkill(env, orgId, ownerId, created.id);
  const winner = await getSkillInstall(env, orgId, ownerId, slug);
  if (!winner) throw new Error("skill_install_conflict");
  return { skillId: winner.skillId, status: "draft", created: false };
}

export async function uninstallLibrarySkill(
  env: AuditEnv,
  orgId: string,
  ownerId: string,
  slug: string,
): Promise<boolean> {
  const install = await getSkillInstall(env, orgId, ownerId, slug);
  if (!install) return false;
  await disableSkill(env, orgId, ownerId, install.skillId);
  return deleteSkillInstall(env, orgId, ownerId, slug);
}
