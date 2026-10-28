import type { SavedSkill } from "./saved";

/** Saved instructions must travel with a selected skill, not just its bookmark. */
export function formatSkillInstructions(skills: SavedSkill[]): string {
  if (skills.length === 0) return "";
  return `Skills:\n${skills.map((skill) => [
    `Skill: ${skill.name}`,
    ...(skill.repoUrl ? [`Source: ${skill.repoUrl}`] : []),
    ...(skill.notes?.trim() ? [`Instructions:\n${skill.notes.trim()}`] : []),
  ].join("\n")).join("\n\n")}`;
}

export function taskWithSkillInstructions(task: string, skills: SavedSkill[]): string {
  const instructions = formatSkillInstructions(skills);
  return instructions ? `${task.trim()}\n\n${instructions}` : task.trim();
}
