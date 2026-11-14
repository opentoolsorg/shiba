import { COLLAB_TENANT_ID } from "../collaboration-store.js";
import type { Env } from "../env.js";
import { getTeamWorkspaceMembership } from "../team-workspaces-store.js";
import { GovernanceError } from "./governance-store.js";

type StoreEnv = Pick<Env, "AGENT_AUDIT">;

export interface ArchivedItem {
  resourceKind: string;
  resourceId: string;
  title: string;
  archivedAt: number;
  restoreSupported: boolean;
}

async function safeQuery<T>(run: () => Promise<{ results: T[] }>): Promise<T[]> {
  try {
    return (await run()).results;
  } catch {
    return [];
  }
}

export async function listArchivedCenter(
  env: StoreEnv,
  workspaceId: string,
  userId: string,
): Promise<ArchivedItem[]> {
  if (!/^ws_[a-f0-9]{24}$/.test(workspaceId))
    throw new GovernanceError("Workspace not found.", 404);
  const membership = await getTeamWorkspaceMembership(env, workspaceId, userId);
  if (!membership) throw new GovernanceError("Workspace not found.", 404);
  const items: ArchivedItem[] = [];
  const skills = await safeQuery(() =>
    env
      .AGENT_AUDIT!.prepare(
        `SELECT skill_id AS resourceId, name AS title, archived_at AS archivedAt
     FROM org_extension_skills WHERE tenant_id=? AND workspace_id=? AND archived_at IS NOT NULL LIMIT 50`,
      )
      .bind(COLLAB_TENANT_ID, workspaceId)
      .all<{ resourceId: string; title: string; archivedAt: number }>(),
  );
  for (const row of skills) {
    items.push({
      resourceKind: "skill",
      resourceId: row.resourceId,
      title: row.title,
      archivedAt: row.archivedAt,
      restoreSupported: true,
    });
  }
  const tasks = await safeQuery(() =>
    env
      .AGENT_AUDIT!.prepare(
        `SELECT task_id AS resourceId, title, archived_at AS archivedAt
     FROM team_work_tasks WHERE tenant_id=? AND workspace_id=? AND archived_at IS NOT NULL LIMIT 50`,
      )
      .bind(COLLAB_TENANT_ID, workspaceId)
      .all<{ resourceId: string; title: string; archivedAt: number }>(),
  );
  for (const row of tasks) {
    items.push({
      resourceKind: "task",
      resourceId: row.resourceId,
      title: row.title,
      archivedAt: row.archivedAt,
      restoreSupported: true,
    });
  }
  const agents = await safeQuery(() =>
    env
      .AGENT_AUDIT!.prepare(
        `SELECT agent_id AS resourceId, name AS title, archived_at AS archivedAt
     FROM custom_agents WHERE workspace_id=? AND archived_at IS NOT NULL LIMIT 50`,
      )
      .bind(workspaceId)
      .all<{ resourceId: string; title: string; archivedAt: number }>(),
  );
  for (const row of agents) {
    items.push({
      resourceKind: "custom_agent",
      resourceId: row.resourceId,
      title: row.title,
      archivedAt: row.archivedAt,
      restoreSupported: true,
    });
  }
  items.sort((a, b) => b.archivedAt - a.archivedAt);
  return items;
}
