import type { Env } from "./env.js";

type StoreEnv = Pick<Env, "AGENT_AUDIT">;

export interface RepoClaimConflict {
  runId: string;
  actorId: string;
  branch: string;
  repo: string;
  roomId: string | null;
}

export type ClaimResult =
  | { ok: true; branch: string }
  | { ok: false; conflict: RepoClaimConflict };

const LEASE_MS = 30 * 60 * 1000;

export async function peekRepoClaim(
  env: StoreEnv,
  workspaceId: string,
  repo: string,
  branch: string,
  now = Date.now(),
): Promise<RepoClaimConflict | null> {
  if (!env.AGENT_AUDIT) return null;
  const current = await env.AGENT_AUDIT.prepare(
    `SELECT run_id, actor_id, branch, room_id, lease_until FROM repo_work_claims
     WHERE workspace_id = ? AND repo = ? AND branch = ?`,
  ).bind(workspaceId, repo.trim(), branch.trim() || "main").first<{ run_id: string; actor_id: string; branch: string; room_id: string | null; lease_until: number }>();
  if (!current || current.lease_until <= now) return null;
  return { runId: current.run_id, actorId: current.actor_id, branch: current.branch, repo: repo.trim(), roomId: current.room_id };
}

export async function claimRepoWork(
  env: StoreEnv,
  input: { workspaceId: string; repo: string; branch: string; runId: string; actorId: string; roomId?: string | null },
  now = Date.now(),
): Promise<ClaimResult> {
  if (!env.AGENT_AUDIT) return { ok: true, branch: input.branch };
  const repo = input.repo.trim();
  const branch = input.branch.trim() || "main";
  const current = await env.AGENT_AUDIT.prepare(
    `SELECT run_id, actor_id, branch, room_id, lease_until FROM repo_work_claims
     WHERE workspace_id = ? AND repo = ? AND branch = ?`,
  ).bind(input.workspaceId, repo, branch).first<{ run_id: string; actor_id: string; branch: string; room_id: string | null; lease_until: number }>();
  if (current && current.lease_until > now && current.run_id !== input.runId) {
    return {
      ok: false,
      conflict: { runId: current.run_id, actorId: current.actor_id, branch: current.branch, repo, roomId: current.room_id },
    };
  }
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO repo_work_claims (workspace_id, repo, branch, run_id, actor_id, room_id, lease_until)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, repo, branch) DO UPDATE SET
       run_id = excluded.run_id, actor_id = excluded.actor_id, room_id = excluded.room_id, lease_until = excluded.lease_until`,
  ).bind(input.workspaceId, repo, branch, input.runId, input.actorId, input.roomId ?? null, now + LEASE_MS).run();
  return { ok: true, branch };
}

export function freshBranchName(runId: string): string {
  const slug = runId.replace(/[^a-z0-9]+/gi, "").slice(0, 12).toLowerCase() || "work";
  return `shiba/${slug}`;
}

export async function releaseRepoClaim(env: StoreEnv, workspaceId: string, runId: string): Promise<void> {
  if (!env.AGENT_AUDIT) return;
  await env.AGENT_AUDIT.prepare(
    "DELETE FROM repo_work_claims WHERE workspace_id = ? AND run_id = ?",
  ).bind(workspaceId, runId).run();
}