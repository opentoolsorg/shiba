import { z } from "zod";

export const extensionScopeSchema = z.enum(["personal", "workspace"]);
export type ExtensionScope = z.infer<typeof extensionScopeSchema>;

export const extensionViewSchema = z.enum(["personal", "workspace", "archived"]);
export type ExtensionView = z.infer<typeof extensionViewSchema>;

export const scopeEditorsSchema = z.enum(["members", "admins"]);
export type ScopeEditors = z.infer<typeof scopeEditorsSchema>;

export const extensionScopeRoleSchema = z.enum(["owner", "admin", "member", "guest"]);
export type ExtensionScopeRole = z.infer<typeof extensionScopeRoleSchema>;

export const extensionScopePolicySchema = z.object({
  workspaceExtensionsEditors: scopeEditorsSchema,
  memberCanMoveScope: z.boolean(),
});
export type ExtensionScopePolicy = z.infer<typeof extensionScopePolicySchema>;

export const DEFAULT_EXTENSION_SCOPE_POLICY: ExtensionScopePolicy = {
  workspaceExtensionsEditors: "members",
  memberCanMoveScope: true,
};

export const extensionScopeFieldsSchema = z.object({
  scope: extensionScopeSchema.optional(),
  archivedAt: z.number().optional(),
  archivedBy: z.string().optional(),
  archivedFromScope: extensionScopeSchema.optional(),
});
export type ExtensionScopeFields = z.infer<typeof extensionScopeFieldsSchema>;

export interface ExtensionScopedRow extends ExtensionScopeFields {
  id: string;
  userId: string;
  workspaceId?: string;
}

export interface ExtensionScopeActor {
  userId: string;
  role: ExtensionScopeRole | null;
  policy?: ExtensionScopePolicy;
}

export type ScopeMutationFailure =
  | "not_found"
  | "forbidden"
  | "not_creator"
  | "archived"
  | "same_scope"
  | "move_disabled"
  | "workspace_creation_restricted"
  | "already_archived"
  | "not_archived";

export type ScopeMutationResult<Patch> =
  | { ok: true; patch: Patch }
  | { ok: false; reason: ScopeMutationFailure };

export function extensionRowScope(row: ExtensionScopeFields): ExtensionScope {
  if (row.archivedAt !== undefined) return row.archivedFromScope ?? row.scope ?? "personal";
  return row.scope ?? "personal";
}

export function extensionRowView(row: ExtensionScopeFields): ExtensionView {
  return row.archivedAt !== undefined ? "archived" : extensionRowScope(row);
}

function isManager(actor: ExtensionScopeActor): boolean {
  return actor.role === "owner" || actor.role === "admin";
}

function isMember(actor: ExtensionScopeActor): boolean {
  return actor.role === "owner" || actor.role === "admin" || actor.role === "member";
}

function canEdit(row: ExtensionScopedRow, actor: ExtensionScopeActor): boolean {
  // Rows created before workspace membership existed remain creator-only.
  if (!row.workspaceId) return row.userId === actor.userId;
  if (!isMember(actor)) return false;
  return row.userId === actor.userId || (extensionRowScope(row) === "workspace" && isManager(actor));
}

/** Pure equivalent of Overlay's extension scope move planner. */
export function setScope(
  row: ExtensionScopedRow | null,
  to: ExtensionScope,
  actor: ExtensionScopeActor,
): ScopeMutationResult<{ scope: ExtensionScope }> {
  if (!row) return { ok: false, reason: "not_found" };
  if (!row.workspaceId) return { ok: false, reason: "forbidden" };
  if (!isMember(actor) || row.userId !== actor.userId) return { ok: false, reason: "not_creator" };
  if (row.archivedAt !== undefined) return { ok: false, reason: "archived" };
  if (extensionRowScope(row) === to) return { ok: false, reason: "same_scope" };

  const policy = actor.policy ?? DEFAULT_EXTENSION_SCOPE_POLICY;
  if (!policy.memberCanMoveScope && !isManager(actor)) return { ok: false, reason: "move_disabled" };
  if (to === "workspace" && policy.workspaceExtensionsEditors === "admins" && !isManager(actor)) {
    return { ok: false, reason: "workspace_creation_restricted" };
  }
  return { ok: true, patch: { scope: to } };
}

/** Pure equivalent of Overlay's extension archive planner. */
export function archive<Extra extends object = object>(
  row: ExtensionScopedRow | null,
  actor: ExtensionScopeActor,
  now: number,
  options?: { onArchive?: Extra },
): ScopeMutationResult<{ archivedAt: number; archivedBy: string; archivedFromScope: ExtensionScope } & Extra> {
  if (!row) return { ok: false, reason: "not_found" };
  if (row.archivedAt !== undefined) return { ok: false, reason: "already_archived" };
  if (!canEdit(row, actor)) return { ok: false, reason: "forbidden" };
  return {
    ok: true,
    patch: {
      archivedAt: now,
      archivedBy: actor.userId,
      archivedFromScope: extensionRowScope(row),
      ...options?.onArchive,
    } as { archivedAt: number; archivedBy: string; archivedFromScope: ExtensionScope } & Extra,
  };
}

/** Pure equivalent of Overlay's extension restore planner. */
export function restore(
  row: ExtensionScopedRow | null,
  actor: ExtensionScopeActor,
): ScopeMutationResult<{
  scope: ExtensionScope;
  archivedAt: undefined;
  archivedBy: undefined;
  archivedFromScope: undefined;
}> {
  if (!row) return { ok: false, reason: "not_found" };
  if (row.archivedAt === undefined) return { ok: false, reason: "not_archived" };
  if (!canEdit(row, actor)) return { ok: false, reason: "forbidden" };
  return {
    ok: true,
    patch: {
      scope: row.archivedFromScope ?? row.scope ?? "personal",
      archivedAt: undefined,
      archivedBy: undefined,
      archivedFromScope: undefined,
    },
  };
}

/** Named together to mirror Overlay's table-bound scopeMutations helper. */
export const scopeMutations = { setScope, archive, restore };
