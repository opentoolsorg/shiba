import type { Env } from "./env.js";
import {
  CollaborationStoreError,
  ensureCollaborationSchema,
  getCollaborationMembership,
  getCollaborationRoom,
  humanActorId,
  isCollaborationSlackRoomAudienceAuthorized,
  type CollaborationScope,
} from "./collaboration-store.js";
import { redactSecrets } from "./security.js";

export const COLLAB_MEMORY_MAX_NOTES = 20;
export const COLLAB_MEMORY_MAX_CONTENT = 4_000;
export const COLLAB_MEMORY_MAX_SELECTED = 8;
export const COLLAB_MEMORY_SNAPSHOT_CHARS = 6_000;

export interface CollaborationMemoryRef {
  id: string;
  version: number;
  sha256: string;
}

export interface CollaborationMemoryNote extends CollaborationMemoryRef {
  title: string;
  content: string;
  createdByUserId: string;
  createdAt: number;
  revokedAt: number | null;
}

const initialized = new WeakSet<D1Database>();
const ID_PATTERN = /^ctx_[A-Za-z0-9_-]{1,96}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

async function ensureSchema(env: Pick<Env, "AGENT_AUDIT">): Promise<void> {
  await ensureCollaborationSchema(env);
  if (initialized.has(env.AGENT_AUDIT)) return;
  await env.AGENT_AUDIT.prepare(`CREATE TABLE IF NOT EXISTS collaboration_memory (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, room_id TEXT NOT NULL,
    context_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version=1),
    title TEXT NOT NULL, content TEXT NOT NULL, sha256 TEXT NOT NULL,
    created_by_user_id TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER,
    PRIMARY KEY(tenant_id,workspace_id,room_id,context_id),
    FOREIGN KEY(room_id) REFERENCES collaboration_rooms(room_id) ON DELETE CASCADE
  )`).run();
  initialized.add(env.AGENT_AUDIT);
}

const READABLE = `EXISTS (SELECT 1 FROM collaboration_memberships reader
  WHERE reader.tenant_id=n.tenant_id AND reader.workspace_id=n.workspace_id AND reader.room_id=n.room_id
    AND reader.user_id=? AND reader.actor_id=? AND reader.actor_kind='human' AND reader.status='active'
    AND EXISTS (SELECT 1 FROM json_each(reader.capabilities_json) WHERE value='room.read'))`;

function note(row: Record<string, unknown>): CollaborationMemoryNote {
  return {
    id: String(row.context_id), version: Number(row.version), sha256: String(row.sha256),
    title: String(row.title), content: String(row.content), createdByUserId: String(row.created_by_user_id),
    createdAt: Number(row.created_at), revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
  };
}

async function requireAccess(env: Env, scope: CollaborationScope, roomId: string, write = false) {
  await ensureSchema(env);
  const room = await getCollaborationRoom(env, scope, roomId);
  const membership = await getCollaborationMembership(env, scope, roomId, humanActorId(scope.userId));
  if (!room || !membership || membership.actorKind !== "human" || !membership.capabilities.includes("room.read") ||
      !await isCollaborationSlackRoomAudienceAuthorized(env, scope, roomId) ||
      (write && !membership.capabilities.includes("message.send"))) {
    throw new CollaborationStoreError("Room memory is unavailable to this participant.", 404);
  }
  return membership;
}

async function noteHash(scope: CollaborationScope, roomId: string, value: Pick<CollaborationMemoryNote, "id" | "version" | "title" | "content" | "createdByUserId">): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({
    tenantId: scope.tenantId, workspaceId: scope.workspaceId, roomId,
    id: value.id, version: value.version, title: value.title, content: value.content, createdByUserId: value.createdByUserId,
  }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Human-authored shared data only. Private owner memory is never queried here. */
export async function createCollaborationMemory(
  env: Env, scope: CollaborationScope, roomId: string,
  input: { id: string; title: string; content: string }, now = Date.now(),
): Promise<CollaborationMemoryNote> {
  await requireAccess(env, scope, roomId, true);
  if (!input || typeof input.id !== "string" || !ID_PATTERN.test(input.id) ||
      typeof input.title !== "string" || !input.title.trim() || input.title.length > 120 ||
      typeof input.content !== "string" || !input.content.trim() || input.content.length > COLLAB_MEMORY_MAX_CONTENT ||
      new TextEncoder().encode(input.content).byteLength > 12_000) {
    throw new CollaborationStoreError("Provide a unique ctx_ id, title (1–120 characters) and note (1–4000 characters).", 400);
  }
  const value: CollaborationMemoryNote = {
    id: input.id, version: 1, title: redactSecrets(input.title.trim()), content: redactSecrets(input.content.trim()),
    createdByUserId: scope.userId, createdAt: now, revokedAt: null, sha256: "",
  };
  value.sha256 = await noteHash(scope, roomId, value);
  await env.AGENT_AUDIT.prepare(`INSERT OR IGNORE INTO collaboration_memory
    (tenant_id,workspace_id,room_id,context_id,version,title,content,sha256,created_by_user_id,created_at,revoked_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,NULL
    WHERE EXISTS (SELECT 1 FROM collaboration_memberships m WHERE m.tenant_id=? AND m.workspace_id=? AND m.room_id=?
      AND m.user_id=? AND m.actor_id=? AND m.actor_kind='human' AND m.status='active'
      AND EXISTS (SELECT 1 FROM json_each(m.capabilities_json) WHERE value='room.read')
      AND EXISTS (SELECT 1 FROM json_each(m.capabilities_json) WHERE value='message.send'))
    AND (SELECT COUNT(*) FROM collaboration_memory WHERE tenant_id=? AND workspace_id=? AND room_id=?)<?`)
    .bind(scope.tenantId, scope.workspaceId, roomId, value.id, value.version, value.title, value.content, value.sha256, scope.userId, now,
      scope.tenantId, scope.workspaceId, roomId, scope.userId, humanActorId(scope.userId),
      scope.tenantId, scope.workspaceId, roomId, COLLAB_MEMORY_MAX_NOTES).run();
  const saved = (await listCollaborationMemory(env, scope, roomId)).find((item) => item.id === value.id);
  if (!saved || saved.revokedAt !== null || saved.sha256 !== value.sha256 || saved.createdByUserId !== scope.userId) {
    throw new CollaborationStoreError("Room memory could not be created. Its ID, membership or room limit changed.", 409);
  }
  return saved;
}

export async function listCollaborationMemory(env: Env, scope: CollaborationScope, roomId: string): Promise<CollaborationMemoryNote[]> {
  await requireAccess(env, scope, roomId);
  const rows = await env.AGENT_AUDIT.prepare(`SELECT n.* FROM collaboration_memory n
    WHERE n.tenant_id=? AND n.workspace_id=? AND n.room_id=? AND n.revoked_at IS NULL AND ${READABLE}
    ORDER BY n.created_at ASC,n.context_id ASC LIMIT ?`)
    .bind(scope.tenantId, scope.workspaceId, roomId, scope.userId, humanActorId(scope.userId), COLLAB_MEMORY_MAX_NOTES)
    .all<Record<string, unknown>>();
  await requireAccess(env, scope, roomId);
  return (rows.results ?? []).map(note);
}

/** Immutable note bodies have no update path. Replace with a new ID and revoke. */
export async function revokeCollaborationMemory(
  env: Env, scope: CollaborationScope, roomId: string, input: { id: string; version: number }, now = Date.now(),
): Promise<boolean> {
  await requireAccess(env, scope, roomId, true);
  if (!input || typeof input.id !== "string" || !ID_PATTERN.test(input.id) || input.version !== 1) {
    throw new CollaborationStoreError("A current room memory ID and version are required.", 400);
  }
  const result = await env.AGENT_AUDIT.prepare(`UPDATE collaboration_memory SET revoked_at=?
    WHERE tenant_id=? AND workspace_id=? AND room_id=? AND context_id=? AND version=? AND revoked_at IS NULL
    AND EXISTS (SELECT 1 FROM collaboration_memberships m
      WHERE m.tenant_id=collaboration_memory.tenant_id AND m.workspace_id=collaboration_memory.workspace_id
      AND m.room_id=collaboration_memory.room_id AND m.user_id=? AND m.actor_id=? AND m.actor_kind='human' AND m.status='active'
      AND EXISTS (SELECT 1 FROM json_each(m.capabilities_json) WHERE value='room.read')
      AND EXISTS (SELECT 1 FROM json_each(m.capabilities_json) WHERE value='message.send')
      AND (collaboration_memory.created_by_user_id=m.user_id OR m.role='owner'))`)
    .bind(now, scope.tenantId, scope.workspaceId, roomId, input.id, input.version, scope.userId, humanActorId(scope.userId)).run();
  if (Number(result.meta?.changes ?? 0) === 1) return true;
  const member = await requireAccess(env, scope, roomId, true);
  const prior = await env.AGENT_AUDIT.prepare(`SELECT version,created_by_user_id,revoked_at FROM collaboration_memory
    WHERE tenant_id=? AND workspace_id=? AND room_id=? AND context_id=?`)
    .bind(scope.tenantId, scope.workspaceId, roomId, input.id).first<{ version: number; created_by_user_id: string; revoked_at: number | null }>();
  if (prior?.revoked_at !== null && prior?.revoked_at !== undefined && prior.version === input.version &&
      (prior.created_by_user_id === scope.userId || member.role === "owner")) return true;
  throw new CollaborationStoreError("Only the note author or room owner may revoke the current note.", 404);
}

export async function snapshotCollaborationMemory(
  env: Env, scope: CollaborationScope, roomId: string, refs: CollaborationMemoryRef[],
): Promise<CollaborationMemoryNote[]> {
  if (!Array.isArray(refs) || refs.length > COLLAB_MEMORY_MAX_SELECTED ||
      refs.some((ref) => !ref || typeof ref.id !== "string" || !ID_PATTERN.test(ref.id) || ref.version !== 1 || typeof ref.sha256 !== "string" || !HASH_PATTERN.test(ref.sha256)) ||
      new Set(refs.map((ref) => ref.id)).size !== refs.length) {
    throw new CollaborationStoreError("Select at most eight unique current room memory references.", 400);
  }
  const available = await listCollaborationMemory(env, scope, roomId);
  const selected: CollaborationMemoryNote[] = [];
  for (const ref of refs) {
    const value = available.find((item) => item.id === ref.id && item.revokedAt === null);
    if (!value || value.version !== ref.version || value.sha256 !== ref.sha256 || await noteHash(scope, roomId, value) !== ref.sha256) {
      throw new CollaborationStoreError("Selected room memory changed or was revoked. Review and request the task again.", 409);
    }
    selected.push(value);
  }
  if (selected.reduce((size, item) => size + item.title.length + item.content.length, 0) > COLLAB_MEMORY_SNAPSHOT_CHARS) {
    throw new CollaborationStoreError("Selected room memory exceeds the bounded context budget.", 400);
  }
  // Hashing crosses an await. Recheck membership and revocation before returning.
  const current = await listCollaborationMemory(env, scope, roomId);
  if (selected.some((item) => !current.some((latest) => latest.id === item.id && latest.sha256 === item.sha256 && latest.revokedAt === null))) {
    throw new CollaborationStoreError("Selected room memory is no longer available.", 409);
  }
  return selected;
}
