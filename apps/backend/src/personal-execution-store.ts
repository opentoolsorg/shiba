import { personalExecutionSnapshotSchema, personalPairingScopeSchema, PERSONAL_ACCOUNT_MAX_AGE_MS, type PersonalExecutionSnapshot, type PersonalPairingScope, type ConnectedComputer } from "@shiba/shared";
import { resolveBetterAuthSessionAccount } from "@shiba/auth/better-auth";
import type { Env } from "./env.js";
import { getTeamWorkspaceMembership } from "./team-workspaces-store.js";
import { redactSecrets } from "./security.js";

export type PersonalExecutionEnv = Env & { SHIBA_PERSONAL_LOCAL_EXECUTION?: string };
export interface PersonalExecutionStopOwner { ownerAccountId: string; workspaceId: string; origin: string }
const SCHEMA = `CREATE TABLE IF NOT EXISTS personal_execution_grants (
  grant_id TEXT PRIMARY KEY, owner_account_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL, version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  snapshot_json TEXT NOT NULL, scope_json TEXT NOT NULL, expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL, revoked_at INTEGER)`;

export function personalExecutionEnabled(env: PersonalExecutionEnv): boolean {
  const pairingKey = env.PAIRING_SECRET?.trim() || env.LOCAL_ADAPTER_TOKEN?.trim() || "";
  return env.SHIBA_PERSONAL_LOCAL_EXECUTION === "1" && env.SHIBA_LOCAL_RUNTIME === "1" && pairingKey.length >= 32 &&
    (env.INTERNAL_SIGNING_KEY?.trim().length ?? 0) >= 32 && Boolean(env.LocalDispatch && env.AGENT_AUDIT);
}

export async function resolvePersonalExecutionOwner(request: Request, env: PersonalExecutionEnv): Promise<PersonalPairingScope | null> {
  if (!personalExecutionEnabled(env) || request.headers.has("authorization")) return null;
  const account = await resolveBetterAuthSessionAccount(request, env, redactSecrets);
  if (!account?.emailVerified) return null;
  const workspaceId = request.headers.get("X-Shiba-Workspace");
  if (!workspaceId) return null;
  const membership = await getTeamWorkspaceMembership(env, workspaceId, account.policy.email);
  if (!membership) return null;
  const result = personalPairingScopeSchema.safeParse({ version: 2, ownerAccountId: account.policy.accountId,
    actorId: account.policy.email, workspaceId, membershipVersion: membership.version, membershipRole: membership.role, origin: new URL(request.url).origin });
  return result.success ? result.data : null;
}

/** Stopping already owned work cannot grant execution or depend on a still active membership. */
export async function resolvePersonalExecutionStopOwner(request: Request, env: PersonalExecutionEnv): Promise<PersonalExecutionStopOwner | null> {
  if (!personalExecutionEnabled(env) || request.headers.has("authorization")) return null;
  const account = await resolveBetterAuthSessionAccount(request, env, redactSecrets);
  const workspaceId = request.headers.get("X-Shiba-Workspace");
  if (!account?.emailVerified || !workspaceId || !/^ws_[a-f0-9]{24}$/.test(workspaceId)) return null;
  return { ownerAccountId: account.policy.accountId, workspaceId, origin: new URL(request.url).origin };
}

/** Exact verified account and membership identity, independent of headers or employee occupations. */
function authority(scope: PersonalPairingScope): { sql: string; values: unknown[] } {
  return { sql: `EXISTS (SELECT 1 FROM team_workspace_memberships m
    JOIN shiba_auth_account_policy p ON p.account_id=? JOIN "user" u ON u.id=p.account_id
    WHERE m.tenant_id='self-hosted' AND m.workspace_id=? AND m.user_id=? AND m.status='active' AND m.version=? AND m.role=?
      AND p.email=? AND lower(u.email)=? AND u.emailVerified=1)`,
    values: [scope.ownerAccountId, scope.workspaceId, scope.actorId, scope.membershipVersion, scope.membershipRole, scope.actorId, scope.actorId] };
}

export async function isPersonalOwnerCurrent(env: PersonalExecutionEnv, value: unknown): Promise<boolean> {
  if (!personalExecutionEnabled(env)) return false;
  const parsed = personalPairingScopeSchema.safeParse(value);
  if (!parsed.success || !env.AGENT_AUDIT) return false;
  const guard = authority(parsed.data);
  try { return Boolean(await env.AGENT_AUDIT.prepare(`SELECT 1 AS current WHERE ${guard.sql}`).bind(...guard.values).first()); }
  catch { return false; }
}

export function canonicalPersonalRepository(value: unknown): string {
  if (typeof value !== "string" || !/^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(value)) throw new Error("public_github_repository_required");
  const parts = value.slice("https://github.com/".length).split("/");
  const owner = parts[0]?.toLowerCase(), repo = parts[1]?.replace(/\.git$/i, "").toLowerCase();
  if (!owner || !repo || [owner, repo].some((part) => part === "." || part === "..")) throw new Error("public_github_repository_required");
  return `https://github.com/${owner}/${repo}`;
}

/** No operator GitHub token, cookies or credential fallback is used for this check. */
export async function isPublicPersonalRepository(repoUrl: string): Promise<boolean> {
  try {
    if (canonicalPersonalRepository(repoUrl) !== repoUrl) return false;
    const response = await fetch(`https://api.github.com/repos/${repoUrl.slice("https://github.com/".length)}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Shiba-Personal-Execution" },
      redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return false;
    const body = await response.json() as { private?: unknown; html_url?: unknown };
    return body.private === false && canonicalPersonalRepository(body.html_url) === repoUrl;
  } catch { return false; }
}

export function personalComputerMatches(computer: ConnectedComputer, scope: PersonalPairingScope, snapshot?: PersonalExecutionSnapshot, now = Date.now()): boolean {
  const binding = computer.personalExecution;
  if (!binding || computer.status === "offline" || computer.lastHeartbeat > now + 5_000 || now - computer.lastHeartbeat > PERSONAL_ACCOUNT_MAX_AGE_MS ||
      JSON.stringify(binding.scope) !== JSON.stringify(scope)) return false;
  if (!snapshot) return true;
  return computer.machineId === snapshot.machineId && binding.revision === snapshot.machineRevision && binding.accounts.some((account) =>
    account.harness === snapshot.harness && account.billingMode === snapshot.billingMode && account.accountFingerprint === snapshot.accountFingerprint &&
    account.authVersion === snapshot.authVersion && Number.isSafeInteger(account.receivedAt) && account.receivedAt <= now && now - account.receivedAt <= PERSONAL_ACCOUNT_MAX_AGE_MS);
}

async function ensure(env: PersonalExecutionEnv): Promise<D1Database> {
  if (!personalExecutionEnabled(env) || !env.AGENT_AUDIT) throw new Error("personal_execution_storage_unavailable");
  await env.AGENT_AUDIT.prepare(SCHEMA).run();
  return env.AGENT_AUDIT;
}

export async function createPersonalExecutionGrant(env: PersonalExecutionEnv, scope: PersonalPairingScope, input: Omit<PersonalExecutionSnapshot, "version" | "grantId" | "grantVersion" | "ownerAccountId" | "actorId" | "workspaceId" | "membershipVersion" | "allowedPhases">): Promise<PersonalExecutionSnapshot> {
  const now = Date.now();
  if (input.expiresAt <= now || input.expiresAt > now + 86_400_000) throw new Error("personal_execution_expiry_invalid");
  const snapshot = personalExecutionSnapshotSchema.parse({ ...input, version: 1, grantId: `plex_${crypto.randomUUID().replaceAll("-", "")}`, grantVersion: 1,
    ownerAccountId: scope.ownerAccountId, actorId: scope.actorId, workspaceId: scope.workspaceId, membershipVersion: scope.membershipVersion, allowedPhases: ["local_repository_task"] });
  const db = await ensure(env), guard = authority(scope);
  const result = await db.prepare(`INSERT INTO personal_execution_grants
    (grant_id,owner_account_id,actor_id,workspace_id,version,status,snapshot_json,scope_json,expires_at,created_at)
    SELECT ?,?,?,?,1,'active',?,?,?,? WHERE ${guard.sql}`).bind(snapshot.grantId, scope.ownerAccountId, scope.actorId, scope.workspaceId,
      JSON.stringify(snapshot), JSON.stringify(scope), snapshot.expiresAt, now, ...guard.values).run();
  if (result.meta.changes !== 1) throw new Error("personal_execution_authority_changed");
  return snapshot;
}

export async function personalGrantFence(env: PersonalExecutionEnv, scope: PersonalPairingScope, value: unknown): Promise<boolean> {
  const parsed = personalExecutionSnapshotSchema.safeParse(value);
  if (!parsed.success || !await isPersonalOwnerCurrent(env, scope)) return false;
  const snapshot = parsed.data;
  if (snapshot.ownerAccountId !== scope.ownerAccountId || snapshot.actorId !== scope.actorId || snapshot.workspaceId !== scope.workspaceId || snapshot.membershipVersion !== scope.membershipVersion) return false;
  const db = await ensure(env), guard = authority(scope);
  return Boolean(await db.prepare(`SELECT 1 AS current FROM personal_execution_grants
    WHERE grant_id=? AND owner_account_id=? AND workspace_id=? AND status='active' AND version=? AND snapshot_json=? AND expires_at>? AND ${guard.sql}`)
    .bind(snapshot.grantId, scope.ownerAccountId, scope.workspaceId, snapshot.grantVersion, JSON.stringify(snapshot), Date.now(), ...guard.values).first());
}

export async function listPersonalExecutionGrants(env: PersonalExecutionEnv, scope: PersonalPairingScope) {
  const db = await ensure(env), guard = authority(scope);
  const result = await db.prepare(`SELECT snapshot_json,status,version FROM personal_execution_grants WHERE owner_account_id=? AND workspace_id=? AND ${guard.sql} ORDER BY created_at DESC LIMIT 100`)
    .bind(scope.ownerAccountId, scope.workspaceId, ...guard.values).all<{ snapshot_json: string; status: string; version: number }>();
  return result.results.map((row) => ({ snapshot: personalExecutionSnapshotSchema.parse(JSON.parse(row.snapshot_json)), status: row.status, version: row.version }));
}

export async function revokePersonalExecutionGrant(env: PersonalExecutionEnv, scope: PersonalPairingScope, grantId: string, expectedVersion: number): Promise<boolean> {
  const db = await ensure(env), guard = authority(scope);
  const result = await db.prepare(`UPDATE personal_execution_grants SET status='revoked',version=version+1,revoked_at=?
    WHERE grant_id=? AND owner_account_id=? AND workspace_id=? AND version=? AND status='active' AND ${guard.sql}`)
    .bind(Date.now(), grantId, scope.ownerAccountId, scope.workspaceId, expectedVersion, ...guard.values).run();
  return result.meta.changes === 1;
}

export async function personalComputerRows(env: PersonalExecutionEnv, scope: PersonalPairingScope): Promise<ConnectedComputer[]> {
  if (!env.LocalDispatch || !await isPersonalOwnerCurrent(env, scope)) return [];
  const stub = env.LocalDispatch.get(env.LocalDispatch.idFromName("local-dispatch"));
  const response = await stub.fetch(new Request("https://local-dispatch/personal-computers", { method: "POST", body: JSON.stringify({ scope }) }));
  if (!response.ok) return [];
  const body = await response.json() as { computers?: ConnectedComputer[] };
  return Array.isArray(body.computers) ? body.computers.filter((computer) => personalComputerMatches(computer, scope)) : [];
}

export async function revalidatePersonalExecutionSnapshot(env: PersonalExecutionEnv, value: unknown): Promise<boolean> {
  try {
    const snapshot = personalExecutionSnapshotSchema.parse(value), db = await ensure(env);
    const row = await db.prepare("SELECT scope_json FROM personal_execution_grants WHERE grant_id=? AND owner_account_id=? AND workspace_id=?")
      .bind(snapshot.grantId, snapshot.ownerAccountId, snapshot.workspaceId).first<{ scope_json: string }>();
    if (!row) return false;
    const scope = personalPairingScopeSchema.parse(JSON.parse(row.scope_json));
    if (!await personalGrantFence(env, scope, snapshot)) return false;
    const computers = await personalComputerRows(env, scope);
    if (!computers.some((computer) => personalComputerMatches(computer, scope, snapshot)) || !await isPublicPersonalRepository(snapshot.repoUrl)) return false;
    return await personalGrantFence(env, scope, snapshot) && snapshot.expiresAt > Date.now();
  } catch { return false; }
}

export async function resolvePersonalExecutionGrant(env: PersonalExecutionEnv, owner: PersonalPairingScope, grantId: string, requested: { machineId?: string; harness?: string; repoUrl?: string; codingModel?: string } = {}): Promise<PersonalExecutionSnapshot | null> {
  try {
    const grants = await listPersonalExecutionGrants(env, owner);
    const snapshot = grants.find((grant) => grant.snapshot.grantId === grantId && grant.status === "active")?.snapshot;
    if (!snapshot || Object.entries(requested).some(([key, value]) => value !== undefined && snapshot[key as keyof PersonalExecutionSnapshot] !== value)) return null;
    return await revalidatePersonalExecutionSnapshot(env, snapshot) ? snapshot : null;
  } catch { return null; }
}
