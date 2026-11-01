import type { SavedSkill } from "./saved";

/** Saved instructions must travel with a selected skill, not just its bookmark. */
export function formatSkillInstructions(skills: SavedSkill[]): string {
  if (skills.length === 0) return "";
  return `Skills:\n${skills.map((skill) => [
    `Skill: ${skill.name} (${skill.id}@${skill.version})`,
    ...(skill.sourceUrl ? [`Source: ${skill.sourceUrl}`] : []),
    ...(skill.instructions.trim() ? [`Reviewed instructions:\n${skill.instructions.trim()}`] : []),
  ].join("\n")).join("\n\n")}`;
}

export function taskWithSkillInstructions(task: string, skills: SavedSkill[]): string {
  const instructions = formatSkillInstructions(skills);
  return instructions ? `${task.trim()}\n\n${instructions}` : task.trim();
}
