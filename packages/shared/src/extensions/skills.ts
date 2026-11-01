import { z } from "zod";
import { extensionScopeFieldsSchema } from "./scope.js";

export const skillSchema = z.object({
  id: z.string().min(1),
  ...extensionScopeFieldsSchema.shape,
  workspaceId: z.string().optional(),
  userId: z.string().min(1),
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  enabled: z.boolean().optional(),
  version: z.number().int().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Skill = z.infer<typeof skillSchema>;

/** Small directory item; instruction text is loaded separately when needed. */
export const skillDirectoryItemSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
});
export type SkillDirectoryItem = z.infer<typeof skillDirectoryItemSchema>;

export function toSkillDirectoryItem(skill: Skill): SkillDirectoryItem {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    enabled: skill.enabled ?? true,
  };
}
