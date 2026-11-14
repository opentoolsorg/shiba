import type { CustomAgentConfig } from "@shiba/shared";
import { collaborationEmployeeOrgId, type CollaborationScope } from "./collaboration-store.js";
import { listCustomAgents } from "./custom-agents-store.js";
import { ensureCoordinationSchema } from "./coordination-schema.js";
import type { Env } from "./env.js";

export const ROUTER_MARGIN = 2;

export interface RankedBot {
  actorId: string;
  userId: string;
  name: string;
  profileVersion: number | null;
  text: string;
  skills: string[];
  recentSuccess: number;
  score: number;
  reason: string;
}

function tokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 4);
}

function scoreBot(message: string, bot: Pick<RankedBot, "name" | "text" | "skills" | "recentSuccess">): { score: number; reason: string } {
  const words = new Set(tokens(message));
  let score = Math.min(bot.recentSuccess, 3);
  const matched = new Set<string>();
  for (const token of tokens(`${bot.name} ${bot.text}`)) {
    if (words.has(token)) {
      score += 2;
      matched.add(token);
    }
  }
  let reason = matched.size ? `${bot.name} matches ${[...matched].slice(0, 3).join(", ")}` : `${bot.name} is available`;
  for (const skill of bot.skills) {
    if (tokens(skill).some((token) => words.has(token))) {
      score += 3;
      reason = `${bot.name} handles ${skill}`;
    }
  }
  return { score, reason };
}

export async function loadRankedBots(
  env: Env,
  scope: CollaborationScope,
  roomId: string,
  channelKind: string,
  message: string,
): Promise<RankedBot[]> {
  const memberships = await env.AGENT_AUDIT.prepare(
    `SELECT actor_id, MIN(user_id) AS user_id, MIN(display_name) AS display_name, MIN(profile_version) AS profile_version
     FROM collaboration_memberships
     WHERE tenant_id=? AND workspace_id=? AND status='active' AND actor_kind='agent'
       AND (room_id=? OR ?='dm')
     GROUP BY actor_id`,
  )
    .bind(scope.tenantId, scope.workspaceId, roomId, channelKind)
    .all<{ actor_id: string; user_id: string; display_name: string; profile_version: number | null }>();
  const agents = await listCustomAgents(env, collaborationEmployeeOrgId(scope)).catch(() => []);
  const byActor = new Map<string, { name: string; text: string; skills: string[] }>();
  for (const agent of agents) {
    const config = agent.config as CustomAgentConfig;
    const profile = {
      name: config.name,
      text: config.instructions,
      skills: [...(config.toolScopes ?? []), ...(config.expectedDeliverables ?? [])],
    };
    byActor.set(`agent:${agent.slug}`, profile);
    byActor.set(`agent:${agent.id}`, profile);
  }
  const done = await env.AGENT_AUDIT.prepare(
    `SELECT owner_actor_id, COUNT(*) AS n FROM collaboration_task_threads
     WHERE tenant_id=? AND workspace_id=? AND status='done' GROUP BY owner_actor_id`,
  )
    .bind(scope.tenantId, scope.workspaceId)
    .all<{ owner_actor_id: string; n: number }>();
  const success = new Map((done.results ?? []).map((row) => [row.owner_actor_id, Number(row.n)]));
  return (memberships.results ?? []).map((row) => {
    const profile = byActor.get(row.actor_id) ?? { name: row.display_name, text: "", skills: [] };
    const base = {
      name: profile.name || row.display_name,
      text: profile.text,
      skills: profile.skills,
      recentSuccess: success.get(row.actor_id) ?? 0,
    };
    const scored = scoreBot(message, base);
    return {
      actorId: row.actor_id,
      userId: row.user_id,
      profileVersion: row.profile_version,
      ...base,
      score: scored.score,
      reason: scored.reason,
    };
  }).sort((a, b) => b.score - a.score || a.actorId.localeCompare(b.actorId));
}

/** One grok-4.7 call at temperature 0. Off unless SHIBA_ROUTER_CLASSIFY=1. */
export async function classifyRoute(
  env: Env,
  message: string,
  ranked: RankedBot[],
): Promise<{ actorId: string; confidence: number; reason: string } | null> {
  if (env.SHIBA_ROUTER_CLASSIFY !== "1" || typeof env.AI?.gateway !== "function") return null;
  const allowed = new Set(ranked.map((bot) => bot.actorId));
  try {
    const base = await env.AI.gateway(env.GATEWAY_ID || "default").getUrl("grok");
    const url = new URL(base);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/chat/completions`;
    const headers = new Headers({ "content-type": "application/json" });
    if (env.AI_GATEWAY_TOKEN) headers.set("cf-aig-authorization", `Bearer ${env.AI_GATEWAY_TOKEN}`);
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "grok-4.7",
        temperature: 0,
        messages: [
          { role: "system", content: "Choose one actorId from the closed list. Reply with JSON {actorId, confidence, reason} only." },
          { role: "user", content: JSON.stringify({ message, candidates: ranked.map((bot) => ({ actorId: bot.actorId, name: bot.name })) }) },
        ],
      }),
    });
    if (!response.ok) return null;
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1)) as {
      actorId?: string;
      confidence?: number;
      reason?: string;
    };
    if (!parsed.actorId || !allowed.has(parsed.actorId)) return null;
    return { actorId: parsed.actorId, confidence: Number(parsed.confidence) || 0, reason: String(parsed.reason ?? "").slice(0, 200) };
  } catch {
    return null;
  }
}

export async function primaryActorId(env: Env, scope: CollaborationScope): Promise<string | null> {
  await ensureCoordinationSchema(env);
  const saved = await env.AGENT_AUDIT.prepare(
    "SELECT actor_id FROM workspace_primary_bot WHERE tenant_id=? AND workspace_id=?",
  ).bind(scope.tenantId, scope.workspaceId).first<{ actor_id: string }>();
  if (saved?.actor_id) return saved.actor_id;
  const agents = await listCustomAgents(env, collaborationEmployeeOrgId(scope)).catch(() => []);
  const earliest = [...agents].sort((a, b) => a.createdAt - b.createdAt)[0];
  if (earliest) return `agent:${earliest.slug}`;
  const member = await env.AGENT_AUDIT.prepare(
    `SELECT actor_id FROM collaboration_memberships
     WHERE tenant_id=? AND workspace_id=? AND actor_kind='agent' AND status='active'
     ORDER BY created_at, actor_id LIMIT 1`,
  ).bind(scope.tenantId, scope.workspaceId).first<{ actor_id: string }>();
  return member?.actor_id ?? null;
}
