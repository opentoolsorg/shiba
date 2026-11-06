/** Explicit human workspace grants. Occupational employee roles confer no authority. */
export const TEAM_WORKSPACE_ROLES = ["owner", "admin", "member"] as const;
export type TeamWorkspaceRole = (typeof TEAM_WORKSPACE_ROLES)[number];
export const TEAM_WORKSPACE_LIMITS = { workspacesPerMember: 50, members: 100, invitations: 100 } as const;
export const TEAM_WORKSPACE_INVITATION_TTL_MS = 24 * 60 * 60 * 1000;
export const isTeamWorkspaceId = (value: unknown): value is string => typeof value === "string" && /^ws_[a-f0-9]{24}$/.test(value);
export const isTeamWorkspaceRole = (value: unknown): value is TeamWorkspaceRole => typeof value === "string" && (TEAM_WORKSPACE_ROLES as readonly string[]).includes(value);

export interface TeamWorkspaceMembership {
  workspaceId: string;
  userId: string;
  role: TeamWorkspaceRole;
  version: number;
  joinedAt: number;
}
export interface TeamWorkspaceSummary {
  workspaceId: string;
  name: string;
  version: number;
  createdAt: number;
  membership: TeamWorkspaceMembership;
}
export interface TeamWorkspaceInvitation {
  invitationId: string;
  workspaceId: string;
  email: string;
  role: TeamWorkspaceRole;
  issuerUserId: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "accepted" | "revoked" | "expired" | "invalidated";
}
export interface TeamWorkspaceDetail extends TeamWorkspaceSummary {
  members: TeamWorkspaceMembership[];
  /** Present only for current owners and admins. Tokens are never returned here. */
  invitations?: TeamWorkspaceInvitation[];
}
export interface CreatedTeamWorkspaceInvitation {
  invitation: TeamWorkspaceInvitation;
  /** Returned once. Clients must use a URL fragment, never a query string. */
  token: string;
}
