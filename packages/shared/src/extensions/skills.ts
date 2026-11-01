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

/** Wire contracts for Overlay-compatible, workspace-scoped extension skills. */
export type ExtensionSkillScope = "personal" | "workspace";
export type ExtensionSkillView = ExtensionSkillScope | "archived";

export interface ExtensionSkillPermissions {
  canEdit: boolean;
  canMove: boolean;
  canArchive: boolean;
  canRestore: boolean;
  canDelete: boolean;
}

export interface ExtensionSkillRecord {
  _id: string;
  userId: string;
  workspaceId?: string;
  scope?: ExtensionSkillScope;
  archivedAt?: number;
  archivedBy?: string;
  archivedFromScope?: ExtensionSkillScope;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  version: number;
  createdAt: number;
  updatedAt: number;
  /** Capabilities for the current viewer; omitted from stored records. */
  permissions?: ExtensionSkillPermissions;
}

export interface ExtensionSkillDirectoryEntry {
  _id: string;
  name: string;
  description: string;
  enabled: boolean;
}

export interface ExtensionSkillInstructions {
  _id: string;
  name: string;
  instructions: string;
}

export interface CreateExtensionSkillRequest {
  name: string;
  description: string;
  instructions: string;
  enabled?: boolean;
  scope?: ExtensionSkillScope;
}

export interface UpdateExtensionSkillRequest {
  skillId: string;
  name?: string;
  description?: string;
  instructions?: string;
  enabled?: boolean;
}
