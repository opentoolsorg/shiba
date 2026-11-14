import { getAgentByName } from "agents/routing";
import { COLLAB_TENANT_ID, humanActorId } from "./collaboration-store.js";
import { listCustomAgents } from "./custom-agents-store.js";
import type { Env } from "./env.js";

export type PaletteBotState = "working" | "needs_you" | "idle";

export interface PaletteBot {
  agentId: string;
  actorId: string;
  name: string;
  avatar: { mascotPreset?: string; look?: unknown } | null;
  pinnedSlot: number | null;
  preview: string | null;
  previewAt: number | null;
  roomId: string | null;
  threadRootId: string | null;
  state: PaletteBotState;
  unread: null;
}

export interface PaletteBotHit {
  agentId: string;
  actorId: string;
  name: string;
  preview: string | null;
  roomId: string | null;
  updatedAt: number | null;
}

type StoreEnv = Pick<Env, "AGENT_AUDIT" | "CodingOrchestrator">;

interface ActivityRow {
  actor_id: string;
  room_id: string;
  last_message_id: string;
  preview: string;
  last_speaker_actor_id: string;
  last_at: number;
  speaker_name: string | null;
}

const threadColumn = new WeakMap<D1Database, boolean>();

function spoken(preview: string, speakerId: string, botActorId: string, viewerActorId: string, speakerName: string | null): string {
  const text = preview.replace(/\s+/g, " ").trim();
  if (speakerId === botActorId) return text;
  if (speakerId === viewerActorId) return `You: ${text}`;
  return `${(speakerName ?? "").trim() || "Someone"}: ${text}`;
}

async function hasThreadColumn(db: D1Database): Promise<boolean> {
  const cached = threadColumn.get(db);
  if (cached !== undefined) return cached;
  try {
    await db.prepare("SELECT thread_root_id FROM collaboration_messages LIMIT 0").first();
    threadColumn.set(db, true);
    return true;
  } catch {
    threadColumn.set(db, false);
    return false;
  }
}

async function activityForViewer(env: StoreEnv, workspaceId: string, userId: string): Promise<ActivityRow[]> {
  if (!env.AGENT_AUDIT) return [];
  const { results } = await env.AGENT_AUDIT.prepare(
    `SELECT a.actor_id, a.room_id, a.last_message_id, a.preview, a.last_speaker_actor_id, a.last_at, s.display_name AS speaker_name
     FROM bot_room_activity a
     LEFT JOIN collaboration_memberships s
       ON s.tenant_id = a.tenant_id AND s.workspace_id = a.workspace_id AND s.room_id = a.room_id
      AND s.actor_id = a.last_speaker_actor_id AND s.status = 'active'
     WHERE a.tenant_id = ? AND a.workspace_id = ?
       AND EXISTS (
         SELECT 1 FROM collaboration_memberships m
         WHERE m.tenant_id = a.tenant_id AND m.workspace_id = a.workspace_id
           AND m.room_id = a.room_id AND m.user_id = ? AND m.status = 'active')`,
  ).bind(COLLAB_TENANT_ID, workspaceId, userId).all<ActivityRow>();
  return results;
}

function newestActivity(rows: ActivityRow[]): Map<string, ActivityRow> {
  const map = new Map<string, ActivityRow>();
  for (const row of rows) {
    const current = map.get(row.actor_id);
    if (!current || row.last_at > current.last_at || (row.last_at === current.last_at && row.last_message_id > current.last_message_id)) {
      map.set(row.actor_id, row);
    }
  }
  return map;
}

async function threadRoots(env: StoreEnv, workspaceId: string, ids: string[]): Promise<Map<string, string | null>> {
  const roots = new Map<string, string | null>();
  if (!env.AGENT_AUDIT || ids.length === 0 || !(await hasThreadColumn(env.AGENT_AUDIT))) return roots;
  const marks = ids.map(() => "?").join(",");
  const { results } = await env.AGENT_AUDIT.prepare(
    `SELECT message_id, thread_root_id FROM collaboration_messages
     WHERE tenant_id = ? AND workspace_id = ? AND message_id IN (${marks})`,
  ).bind(COLLAB_TENANT_ID, workspaceId, ...ids).all<{ message_id: string; thread_root_id: string | null }>();
  for (const row of results) roots.set(row.message_id, row.thread_root_id);
  return roots;
}

async function botStates(env: StoreEnv, workspaceId: string, ownerId: string): Promise<{ working: Set<string>; needs: Set<string> }> {
  const working = new Set<string>();
  const needs = new Set<string>();
  if (!env.AGENT_AUDIT) return { working, needs };
  try {
    const { results } = await env.AGENT_AUDIT.prepare(
      `SELECT recipient_actor_id, run_id, approval_id FROM collaboration_handoffs
       WHERE tenant_id = ? AND workspace_id = ? AND status = 'active'`,
    ).bind(COLLAB_TENANT_ID, workspaceId).all<{ recipient_actor_id: string; run_id: string | null; approval_id: string | null }>();
    for (const row of results) {
      if (row.run_id) working.add(row.recipient_actor_id);
      else if (row.approval_id) needs.add(row.recipient_actor_id);
    }
  } catch { /* Handoff table is created with collaboration storage. */ }
  try {
    const { results } = await env.AGENT_AUDIT.prepare(
      `SELECT h.recipient_actor_id FROM ask_user_pending a
       JOIN collaboration_handoffs h ON h.tenant_id = a.tenant_id AND h.run_id = a.run_id
       WHERE a.tenant_id = ? AND a.owner_id = ? AND a.status = 'pending' AND h.workspace_id = ?`,
    ).bind(COLLAB_TENANT_ID, ownerId, workspaceId).all<{ recipient_actor_id: string }>();
    for (const row of results) needs.add(row.recipient_actor_id);
  } catch { /* Asks are absent until that migration has run. */ }
  try {
    const now = Date.now();
    const { results } = await env.AGENT_AUDIT.prepare(
      `SELECT actor_id FROM repo_work_claims WHERE workspace_id = ? AND lease_until > ?`,
    ).bind(workspaceId, now).all<{ actor_id: string }>();
    for (const row of results) working.add(row.actor_id);
  } catch { /* Claims are optional for state. */ }
  return { working, needs };
}

async function sessionFallbacks(env: StoreEnv, userId: string): Promise<Map<string, { name: string; updatedAt: number }>> {
  const map = new Map<string, { name: string; updatedAt: number }>();
  if (!env.CodingOrchestrator) return map;
  try {
    const stub = await getAgentByName(env.CodingOrchestrator, userId);
    const response = await stub.fetch("https://internal/internal/web-sessions");
    if (!response.ok) return map;
    const body = await response.json() as { sessions?: Array<{ name?: string; updatedAt?: number; deletingAt?: number; metadata?: { customAgentId?: unknown } }> };
    for (const session of body.sessions ?? []) {
      if (session.deletingAt) continue;
      const agentId = session.metadata?.customAgentId;
      if (typeof agentId !== "string" || !agentId) continue;
      const updatedAt = Number(session.updatedAt ?? 0);
      const current = map.get(agentId);
      if (!current || updatedAt > current.updatedAt) map.set(agentId, { name: String(session.name || "Chat"), updatedAt });
    }
  } catch { /* Session registry is optional for the preview fallback. */ }
  return map;
}

export async function listPaletteBots(env: StoreEnv, workspaceId: string, orgId: string, userId: string): Promise<PaletteBot[]> {
  if (!env.AGENT_AUDIT) return [];
  const [agents, rows, pins, states, sessions] = await Promise.all([
    listCustomAgents(env, orgId),
    activityForViewer(env, workspaceId, userId),
    env.AGENT_AUDIT.prepare(
      `SELECT actor_id, slot FROM palette_pins WHERE tenant_id = ? AND workspace_id = ? AND user_id = ?`,
    ).bind(COLLAB_TENANT_ID, workspaceId, userId).all<{ actor_id: string; slot: number }>(),
    botStates(env, workspaceId, userId),
    sessionFallbacks(env, userId),
  ]);
  const activity = newestActivity(rows);
  const pinByActor = new Map(pins.results.map((row) => [row.actor_id, row.slot]));
  const viewerActorId = humanActorId(userId);
  const roots = await threadRoots(env, workspaceId, [...activity.values()].map((row) => row.last_message_id));
  const bots = agents.map((agent) => {
    const actorId = `agent:${agent.id}`;
    const row = activity.get(actorId);
    const session = sessions.get(agent.id);
    const avatar = agent.config.mascotPreset || agent.config.look
      ? { ...(agent.config.mascotPreset ? { mascotPreset: agent.config.mascotPreset } : {}), ...(agent.config.look ? { look: agent.config.look } : {}) }
      : null;
    let state: PaletteBotState = "idle";
    if (states.working.has(actorId)) state = "working";
    else if (states.needs.has(actorId)) state = "needs_you";
    return {
      agentId: agent.id,
      actorId,
      name: agent.config.name,
      avatar,
      pinnedSlot: pinByActor.get(actorId) ?? null,
      preview: row ? spoken(row.preview, row.last_speaker_actor_id, actorId, viewerActorId, row.speaker_name) : session ? `Last chat · ${session.name}` : null,
      previewAt: row?.last_at ?? session?.updatedAt ?? null,
      roomId: row?.room_id ?? null,
      threadRootId: row ? roots.get(row.last_message_id) ?? null : null,
      state,
      unread: null,
    } satisfies PaletteBot;
  });
  bots.sort((a, b) => {
    if (a.pinnedSlot != null && b.pinnedSlot != null) return a.pinnedSlot - b.pinnedSlot || a.name.localeCompare(b.name);
    if (a.pinnedSlot != null) return -1;
    if (b.pinnedSlot != null) return 1;
    return (b.previewAt ?? 0) - (a.previewAt ?? 0) || a.name.localeCompare(b.name);
  });
  return bots;
}

export async function searchPaletteBots(env: StoreEnv, workspaceId: string, orgId: string, userId: string, query: string, limit: number): Promise<PaletteBotHit[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const bots = await listPaletteBots(env, workspaceId, orgId, userId);
  return bots.filter((bot) => bot.name.toLowerCase().includes(needle) || (bot.preview ?? "").toLowerCase().includes(needle))
    .slice(0, limit)
    .map((bot) => ({ agentId: bot.agentId, actorId: bot.actorId, name: bot.name, preview: bot.preview, roomId: bot.roomId, updatedAt: bot.previewAt }));
}

export async function setPalettePin(env: StoreEnv, workspaceId: string, userId: string, actorId: string, slot: number): Promise<void> {
  if (!env.AGENT_AUDIT) throw new Error("Palette storage is unavailable.");
  await env.AGENT_AUDIT.batch([
    env.AGENT_AUDIT.prepare(
      `DELETE FROM palette_pins WHERE tenant_id = ? AND workspace_id = ? AND user_id = ? AND actor_id = ? AND slot != ?`,
    ).bind(COLLAB_TENANT_ID, workspaceId, userId, actorId, slot),
    env.AGENT_AUDIT.prepare(
      `INSERT INTO palette_pins (tenant_id, workspace_id, user_id, actor_id, slot) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id, user_id, slot) DO UPDATE SET actor_id = excluded.actor_id`,
    ).bind(COLLAB_TENANT_ID, workspaceId, userId, actorId, slot),
  ]);
}

export async function clearPalettePin(env: StoreEnv, workspaceId: string, userId: string, slot: number): Promise<void> {
  if (!env.AGENT_AUDIT) return;
  await env.AGENT_AUDIT.prepare(
    `DELETE FROM palette_pins WHERE tenant_id = ? AND workspace_id = ? AND user_id = ? AND slot = ?`,
  ).bind(COLLAB_TENANT_ID, workspaceId, userId, slot).run();
}
