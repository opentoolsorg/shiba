import { buildDecisionData, isTeamWorkspaceId } from "@shiba/shared";
import type { Env } from "../../env.js";
import type { ChannelAdapter } from "../../ports/channel/index.js";
import { isTeamsServiceUrl, teamsAdapterFromEnv, type TeamsActivity } from "./index.js";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function teamsSettings(env: Env) {
  const workspaceId = env.TEAMS_WORKSPACE_ID?.trim();
  const appId = env.TEAMS_APP_ID?.trim();
  const tenantId = env.TEAMS_APP_TENANT_ID?.trim().toLowerCase();
  const appPassword = env.TEAMS_APP_PASSWORD?.trim();
  if (!isTeamWorkspaceId(workspaceId) || !appId || !UUID.test(appId) || !tenantId || !UUID.test(tenantId) || !appPassword) return null;
  return { workspaceId, appId, tenantId, appPassword };
}

type Settings = NonNullable<ReturnType<typeof teamsSettings>>;

export function teamsSettingsKey(settings: Settings) {
  return [settings.workspaceId, settings.appId, settings.tenantId] as const;
}

export function teamsActivityTenant(activity: TeamsActivity): string | null {
  const conversation = activity.conversation?.tenantId;
  const channel = activity.channelData?.tenant?.id;
  const tenant = conversation ?? channel;
  if (typeof tenant !== "string" || !UUID.test(tenant)) return null;
  if (conversation !== undefined && channel !== undefined && (typeof channel !== "string" || tenant.toLowerCase() !== channel.toLowerCase())) return null;
  return tenant.toLowerCase();
}

export async function teamsGeneration(env: Env, settings: Settings) {
  return (await env.AGENT_AUDIT.prepare(
    "SELECT generation FROM teams_connections WHERE workspace_id=? AND app_id=? AND tenant_id=?",
  ).bind(...teamsSettingsKey(settings)).first<{ generation: string | null }>())?.generation ?? null;
}

export async function recordTeamsInstallation(env: Env, settings: Settings, activity: TeamsActivity) {
  if (activity.action !== "add" && activity.action !== "remove") return;
  const id = activity.conversation?.id;
  if (typeof id !== "string" || !/^[A-Za-z0-9:@._;=-]{1,256}$/.test(id)) return;
  const eventAt = typeof activity.timestamp === "string" ? Date.parse(activity.timestamp) : NaN;
  if (!Number.isFinite(eventAt)) return;
  await env.AGENT_AUDIT.prepare(`INSERT INTO teams_installations
    (workspace_id, app_id, tenant_id, conversation_id, installed, event_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(workspace_id,app_id,tenant_id,conversation_id) DO UPDATE SET
      installed=excluded.installed, event_at=excluded.event_at WHERE excluded.event_at > teams_installations.event_at`)
    .bind(...teamsSettingsKey(settings), id, activity.action === "add" ? 1 : 0, eventAt).run();
}

export interface TeamsReply {
  thread_key: string;
  conversation_id: string;
  activity_id: string;
  service_url: string;
  bot_id: string;
  recipient_id: string;
}

export async function reserveTeamsReply(env: Env, settings: Settings, generation: string, threadKey: string, activity: TeamsActivity & {
  id: string; serviceUrl: string; conversation: { id: string };
}, botId: string, recipientId: string): Promise<boolean> {
  const result = await env.AGENT_AUDIT.prepare(`INSERT INTO teams_task_replies
    (thread_key, generation, conversation_id, activity_id, service_url, bot_id, recipient_id)
    SELECT ?, generation, ?, ?, ?, ?, ? FROM teams_connections
    WHERE workspace_id=? AND app_id=? AND tenant_id=? AND generation=?
    ON CONFLICT(thread_key) DO NOTHING`)
    .bind(threadKey, activity.conversation.id, activity.id, activity.serviceUrl, botId, recipientId, ...teamsSettingsKey(settings), generation).run();
  return result.meta.changes === 1;
}

export async function saveTeamsApproval(env: Env, threadKey: string, approvalId: string) {
  await env.AGENT_AUDIT.prepare(
    "UPDATE teams_task_replies SET approval_id=? WHERE thread_key=? AND approval_id IS NULL",
  ).bind(approvalId, threadKey).run();
}

export async function replaceTeamsApproval(env: Env, threadKey: string, approvalId: string) {
  await env.AGENT_AUDIT.prepare(
    "UPDATE teams_task_replies SET approval_id=?, card_activity_id=NULL WHERE thread_key=?",
  ).bind(approvalId, threadKey).run();
}

export async function teamsApprovalThread(env: Env, generation: string, conversationId: string, approvalId: string) {
  return env.AGENT_AUDIT.prepare(`SELECT thread_key, card_activity_id FROM teams_task_replies
    WHERE approval_id=? AND generation=? AND conversation_id=?`)
    .bind(approvalId, generation, conversationId).first<{ thread_key: string; card_activity_id: string | null }>();
}

export async function saveTeamsCard(env: Env, threadKey: string, cardActivityId: string) {
  await env.AGENT_AUDIT.prepare("UPDATE teams_task_replies SET card_activity_id=? WHERE thread_key=?")
    .bind(cardActivityId, threadKey).run();
}

export function teamsReplyAddress(conversationId: string, tenantId: string, botId: string, recipientId: string) {
  return {
    channelId: "msteams",
    conversation: { id: conversationId, tenantId },
    from: { id: botId },
    recipient: { id: recipientId },
  };
}

export function teamsApprovalCard(text: string, approvalId: string): Record<string, unknown> {
  return {
    contentType: "application/vnd.microsoft.card.adaptive",
    content: {
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.4",
      body: [{ type: "TextBlock", text: text.replace(/([\\`*_~\[\]])/g, "\\$1"), wrap: true }],
      actions: [
        { type: "Action.Submit", title: "Approve", data: { shiba: buildDecisionData(true, approvalId) } },
        { type: "Action.Submit", title: "Reject", data: { shiba: buildDecisionData(false, approvalId) } },
      ],
    },
  };
}

/** Post the second publication approval and repoint this conversation's active approval pointer at it. */
export async function postTeamsPublicationApproval(env: Env, threadKey: string, text: string, approvalId: string, deps: { adapter?: ChannelAdapter } = {}): Promise<boolean> {
  const settings = teamsSettings(env);
  if (!settings) return false;
  const destination = await env.AGENT_AUDIT.prepare(`SELECT r.* FROM teams_task_replies r JOIN teams_connections c
    ON c.generation=r.generation WHERE r.thread_key=? AND c.workspace_id=? AND c.app_id=? AND c.tenant_id=?`)
    .bind(threadKey, ...teamsSettingsKey(settings)).first<TeamsReply>();
  if (!destination) return false;
  if (!isTeamsServiceUrl(destination.service_url)) throw new Error("Invalid saved Teams Connector service URL.");
  const adapter = deps.adapter ?? teamsAdapterFromEnv(env, { serviceUrl: destination.service_url });
  if (!adapter) throw new Error("Teams Connector is not configured.");
  await replaceTeamsApproval(env, threadKey, approvalId);
  const posted = await adapter.post({
    placeId: destination.conversation_id,
    replyToMessageId: destination.activity_id,
    text: "",
    native: {
      ...teamsReplyAddress(destination.conversation_id, settings.tenantId, destination.bot_id, destination.recipient_id),
      attachments: [teamsApprovalCard(text.slice(0, 4000), approvalId)],
    },
  });
  if (/^[A-Za-z0-9@:_;=-][A-Za-z0-9@:_;=.\-]{0,255}$/.test(posted.messageId)) await saveTeamsCard(env, threadKey, posted.messageId);
  return true;
}

export async function postTeamsTaskReply(env: Env, threadKey: string, text: string): Promise<void> {
  const settings = teamsSettings(env);
  if (!settings) return;
  const destination = await env.AGENT_AUDIT.prepare(`SELECT r.* FROM teams_task_replies r JOIN teams_connections c
    ON c.generation=r.generation WHERE r.thread_key=? AND c.workspace_id=? AND c.app_id=? AND c.tenant_id=?`)
    .bind(threadKey, ...teamsSettingsKey(settings)).first<TeamsReply>();
  if (!destination) return;
  if (!isTeamsServiceUrl(destination.service_url)) throw new Error("Invalid saved Teams Connector service URL.");
  const adapter = teamsAdapterFromEnv(env, { serviceUrl: destination.service_url });
  if (!adapter) throw new Error("Teams Connector is not configured.");
  await adapter.post({
    placeId: destination.conversation_id,
    replyToMessageId: destination.activity_id,
    text: text.slice(0, 4000),
    native: teamsReplyAddress(destination.conversation_id, settings.tenantId, destination.bot_id, destination.recipient_id),
  });
}
