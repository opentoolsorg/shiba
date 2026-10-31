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

  const existing = await getSkillInstall(env, orgId, slug);
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
  await recordSkillInstall(env, {
    orgId,
    librarySlug: slug,
    libraryVersion: definition.version,
    skillId: created.id,
    installedBy: ownerId,
    installedAt: Date.now(),
  });
  return { skillId: created.id, status: "draft", created: true };
}

export async function uninstallLibrarySkill(
  env: AuditEnv,
  orgId: string,
  ownerId: string,
  slug: string,
): Promise<boolean> {
  const install = await getSkillInstall(env, orgId, slug);
  if (!install) return false;
  await disableSkill(env, orgId, ownerId, install.skillId);
  return deleteSkillInstall(env, orgId, slug);
}
