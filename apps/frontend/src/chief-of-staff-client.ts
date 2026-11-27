import type { CustomAgentWire } from "./components/CustomAgentsView";
import { teamWorkspaceHeaders, teamWorkspaceRequest } from "./team-workspaces-client";

/** Seeded team chief record; its saved profile name is the workspace chief's name. */
export const CHIEF_OF_STAFF_SLUG = "chief-of-staff";

export async function loadPersonalChiefName(): Promise<string | null> {
  const body = await teamWorkspaceRequest<{ name?: unknown }>("/api/chief-of-staff");
  return typeof body.name === "string" && body.name ? body.name : null;
}

export async function savePersonalChiefName(name: string): Promise<string> {
  const body = await teamWorkspaceRequest<{ name: string }>("/api/chief-of-staff", { method: "PUT", body: JSON.stringify({ name }) });
  return body.name;
}

/** Renames through the existing custom-agent PATCH, so the same version and manage checks apply. */
export async function renameTeamChief(workspaceId: string, chief: CustomAgentWire, name: string): Promise<CustomAgentWire> {
  const body = await teamWorkspaceRequest<{ agent: CustomAgentWire }>(`/api/custom-agents/${encodeURIComponent(chief.id)}`, {
    method: "PATCH",
    headers: teamWorkspaceHeaders(workspaceId),
    body: JSON.stringify({ config: { ...chief.config, name }, expectedVersion: chief.version }),
  });
  return body.agent;
}

export async function canManageEmployee(workspaceId: string, employeeId: string): Promise<boolean> {
  try {
    const body = await teamWorkspaceRequest<{ level?: string }>(`/api/governance/employees/${encodeURIComponent(employeeId)}/access`, { headers: teamWorkspaceHeaders(workspaceId) });
    return body.level === "manage";
  } catch { return false; }
}
