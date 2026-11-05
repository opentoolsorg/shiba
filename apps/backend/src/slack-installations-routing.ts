import { verifySlackRequest } from "./slack.js";
import { activeSlackInstallationForTeam, recordSlackInstallationRevocation, slackTeamHasInstallationOrRevocation, type SlackInstallationEnv } from "./slack-installations-store.js";
import { observeSlackCoworkerChallenge, confirmSlackCoworkerOnSlack, intakeSlackCoworkerEvent, invalidateSlackCoworkerMessage } from "./slack-coworker-store.js";

const paths = new Set(["/api/slack/events", "/api/slack/command", "/api/slack/interact"]);
const slackId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
/** A disabled feature cannot erase previous tenant ownership. No DDL or secret read here. */
async function managedHistory(env: SlackInstallationEnv, appId?: string, teamId?: string): Promise<boolean> {
  const tables = await env.AGENT_AUDIT.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('slack_installations','slack_installation_revocations')").all<{ name: string }>();
  for (const name of ["slack_installations", "slack_installation_revocations"]) if (tables.results.some((table) => table.name === name)) {
    const row = appId && teamId
      ? await env.AGENT_AUDIT.prepare(`SELECT 1 AS owned FROM ${name} WHERE app_id=? AND team_id=? LIMIT 1`).bind(appId, teamId).first()
      : await env.AGENT_AUDIT.prepare(`SELECT 1 AS owned FROM ${name} LIMIT 1`).first();
    if (row) return true;
  }
  return false;
}
async function boundedRaw(request: Request): Promise<string> {
  const reader = request.clone().body?.getReader(), bytes = new Uint8Array(1_048_576); let used = 0;
  try {
    if (!reader) throw new Error();
    for (;;) { const part = await reader.read(); if (part.done) break; if (used + part.value.length > bytes.length) throw new Error(); bytes.set(part.value, used); used += part.value.length; }
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, used));
  } finally { await reader?.cancel().catch(() => {}); }
}
/** Gates all callback effects before legacy handlers. An installation is never native/provider/billing authority. */
export async function handleMultiInstallationSlackCallback(request: Request, env: SlackInstallationEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!paths.has(path)) return null;
  const enabled = env.SLACK_INSTALLATIONS_ENABLED?.trim() === "true";
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  if (!enabled && !env.AGENT_AUDIT) return env.SLACK_OAUTH_APP_ID ? json({ error: "slack_installation_history_unavailable" }, 503) : null;
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let raw: string;
  try { raw = await boundedRaw(request); } catch { return json({ error: "slack_callback_invalid" }, 413); }
  if (!env.SLACK_SIGNING_SECRET) return enabled ? json({ error: "slack_installation_signature_unavailable" }, 503) : null;
  if (!await verifySlackRequest(raw, request.headers, env.SLACK_SIGNING_SECRET)) return json({ error: "Invalid Slack signature." }, 401);
  let payload: Record<string, unknown>;
  try {
    if (path === "/api/slack/events") payload = JSON.parse(raw);
    else { const form = new URLSearchParams(raw); if (path === "/api/slack/interact") { if (form.getAll("payload").length !== 1) throw new Error(); payload = JSON.parse(form.get("payload")!); }
      else { if (form.getAll("team_id").length !== 1 || form.getAll("api_app_id").length !== 1) throw new Error(); payload = Object.fromEntries(form); } }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error();
  } catch { return json({ error: "slack_callback_invalid" }, 400); }
  if (path === "/api/slack/events" && payload.type === "url_verification") return !enabled ? null : typeof payload.challenge === "string" && payload.challenge.length <= 512 ? json({ challenge: payload.challenge }) : json({ error: "slack_callback_invalid" }, 400);
  const teamObject = payload.team as { id?: unknown } | undefined;
  const teamId = payload.team_id ?? teamObject?.id, appId = payload.api_app_id;
  const event = payload.event as { type?: unknown; tokens?: { bot?: unknown } } | undefined;
  if (!enabled) {
    try {
      if (!await managedHistory(env, slackId(appId) ? appId : undefined, slackId(teamId) ? teamId : undefined)) return null;
    } catch { return json({ error: "slack_installation_history_unavailable" }, 503); }
    if (slackId(appId) && slackId(teamId) && path === "/api/slack/events" && payload.type === "event_callback" && slackId(payload.event_id) && ["app_uninstalled", "tokens_revoked"].includes(String(event?.type))) {
      const bots = event?.type === "tokens_revoked" ? event.tokens?.bot : null;
      if (bots !== null && (!Array.isArray(bots) || bots.length > 128 || !bots.every(slackId))) return json({ error: "slack_callback_invalid" }, 400);
      if (bots === null || bots.length > 0) await recordSlackInstallationRevocation(env, appId, teamId, payload.event_id, bots);
    }
    return path === "/api/slack/events" ? new Response("", { status: 200 }) : json({ response_type: "ephemeral", text: "This managed Slack installation is disabled. Operator credentials cannot replace it." });
  }
  if (!slackId(teamId) || !slackId(appId) || appId !== env.SLACK_OAUTH_APP_ID || payload.team_id !== undefined && teamObject?.id !== undefined && payload.team_id !== teamObject.id) return json({ error: "slack_installation_unavailable" }, 403);
  const authorizations = payload.authorizations;
  if (payload.enterprise_id != null || payload.enterprise != null || payload.is_enterprise_install === true ||
    Array.isArray(authorizations) && authorizations.some((item) => item?.is_enterprise_install === true || item?.enterprise_id != null)) return json({ error: "slack_enterprise_installation_unavailable" }, 403);
  if (path === "/api/slack/events" && payload.type === "event_callback" && slackId(payload.event_id) && ["app_uninstalled", "tokens_revoked"].includes(String(event?.type))) {
    const bots = event?.type === "tokens_revoked" ? event.tokens?.bot : null;
    if (bots === null || Array.isArray(bots) && bots.length <= 128 && bots.every(slackId)) {
      if (bots === null || bots.length > 0) await recordSlackInstallationRevocation(env, appId, teamId, payload.event_id, bots);
      return new Response("", { status: 200 });
    }
    return json({ error: "slack_callback_invalid" }, 400);
  }
  // An explicitly declared legacy team is the sole fallthrough. Never fall back for unknown or owned tenants.
  const installation = await activeSlackInstallationForTeam(env, appId, teamId);
  if (!installation && env.SLACK_LEGACY_MODE_ENABLED?.trim() === "true" && env.SLACK_LEGACY_TEAM_ID === teamId && env.SLACK_LEGACY_APP_ID === appId &&
    !await slackTeamHasInstallationOrRevocation(env, appId, teamId)) return null;
  if (!installation) return path === "/api/slack/events" ? new Response("", { status: 200 }) : json({ response_type: "ephemeral", text: "This Slack installation is unavailable. A native workspace owner must review its configuration." });
  if (path === "/api/slack/events" && payload.type === "event_callback" && slackId(payload.event_id) && event) {
    const incoming = event as { type?: unknown; subtype?: unknown; channel?: unknown; deleted_ts?: unknown; message?: { ts?: unknown }; user?: unknown; ts?: unknown; thread_ts?: unknown; text?: unknown; bot_id?: unknown };
    try {
      if (incoming.type === "message" && (incoming.subtype === "message_changed" || incoming.subtype === "message_deleted") && typeof incoming.channel === "string") {
        const ts = incoming.subtype === "message_deleted" ? incoming.deleted_ts : incoming.message?.ts;
        if (typeof ts === "string") await invalidateSlackCoworkerMessage(env, installation, incoming.channel, ts);
      } else if (incoming.type === "app_mention") await intakeSlackCoworkerEvent(env, installation, payload.event_id, incoming);
    } catch { return json({ error: "slack_coworker_storage_unavailable" }, 503); }
    return new Response("", { status: 200 });
  }
  if (path === "/api/slack/command") {
    const form = new URLSearchParams(raw);
    if (form.get("command") === "/shiba-link") {
      if (["command", "user_id", "text"].some((key) => form.getAll(key).length !== 1)) return json({ response_type: "ephemeral", text: "Link request unavailable." });
      try {
        const candidate = await observeSlackCoworkerChallenge(env, installation, form.get("text") ?? "", form.get("user_id") ?? "");
        if (candidate) return json({ response_type: "ephemeral", text: "Review this account link.", blocks: [
          { type: "section", text: { type: "plain_text", text: `Link your Slack identity to Shiba account ${candidate.actorId} (native account ${candidate.accountId}) in workspace ${candidate.workspaceId}? This does not grant source access or execution.` } },
          { type: "actions", elements: [ { type: "button", action_id: "shiba_link_accept", text: { type: "plain_text", text: "Accept link" }, value: candidate.id }, { type: "button", action_id: "shiba_link_reject", text: { type: "plain_text", text: "Reject" }, value: candidate.id } ] },
        ] });
      } catch { /* Do not expose identity or storage state to Slack. */ }
      return json({ response_type: "ephemeral", text: "Return to Shiba to review the Slack identity shown there." });
    }
  }
  if (path === "/api/slack/interact" && payload.type === "block_actions") {
    const user = payload.user as { id?: unknown } | undefined;
    const actions = payload.actions;
    if (slackId(user?.id) && Array.isArray(actions) && actions.length === 1 && ["shiba_link_accept", "shiba_link_reject"].includes(actions[0]?.action_id) && typeof actions[0]?.value === "string") {
      try { await confirmSlackCoworkerOnSlack(env, installation, actions[0].value, user.id, actions[0].action_id === "shiba_link_accept"); } catch { return json({ error: "slack_coworker_storage_unavailable" }, 503); }
      return json({ response_type: "ephemeral", replace_original: true, text: "Return to Shiba to complete the identity review." });
    }
  }
  // Installing a bot does not map a Slack author to a native person, source grant or payer.
  // Buffer/model execution is intentionally closed until that distinct contract exists.
  return path === "/api/slack/events" ? new Response("", { status: 200 }) : json({ response_type: "ephemeral", text: "Slack coworker execution is unavailable: link the requesting native account and explicitly grant its provider/billing scope first. Installing the bot does not grant execution." });
}
