import { z } from "zod";
import { extensionScopeFieldsSchema } from "./scope.js";

export const workspaceConnectorSchema = z.object({
  id: z.string().min(1),
  ...extensionScopeFieldsSchema.shape,
  workspaceId: z.string().min(1),
  userId: z.string().min(1),
  providerKey: z.string(),
  connectedAccountId: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type WorkspaceConnector = z.infer<typeof workspaceConnectorSchema>;

/** Shared connector rows expose account references only to the person who connected them. */
export const workspaceConnectorListItemSchema = z.object({
  id: z.string().min(1),
  userId: z.string(),
  workspaceId: z.string(),
  providerKey: z.string(),
  scope: z.enum(["personal", "workspace"]),
  archivedAt: z.number().optional(),
  archivedFromScope: z.enum(["personal", "workspace"]).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  connectedAccountId: z.string().optional(),
});
export type WorkspaceConnectorListItem = z.infer<typeof workspaceConnectorListItemSchema>;

export function toWorkspaceConnectorListItem(
  connector: WorkspaceConnector,
  viewerUserId: string,
): WorkspaceConnectorListItem {
  return {
    id: connector.id,
    userId: connector.userId,
    workspaceId: connector.workspaceId,
    providerKey: connector.providerKey,
    scope: connector.scope ?? "personal",
    ...(connector.archivedAt !== undefined ? { archivedAt: connector.archivedAt } : {}),
    ...(connector.archivedFromScope !== undefined ? { archivedFromScope: connector.archivedFromScope } : {}),
    createdAt: connector.createdAt,
    updatedAt: connector.updatedAt,
    ...(connector.userId === viewerUserId ? { connectedAccountId: connector.connectedAccountId } : {}),
  };
}
