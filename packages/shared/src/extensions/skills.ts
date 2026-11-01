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
