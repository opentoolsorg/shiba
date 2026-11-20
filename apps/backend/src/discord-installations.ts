/**
 * Discord bot installation: OAuth2 install into a server (guild), the
 * guild allow-list every inbound interaction and mention is checked
 * against, and disconnect/reconnect for the dashboard.
 *
 * The bot token is a deployment secret and never stored per guild. The
 * installer's OAuth user token is used for nothing and revoked right after
 * the code exchange, so no Discord credential lands in D1.
 */
import {
  DISCORD_BOT_PERMISSIONS,
  DISCORD_INSTALL_CALLBACK_PATH,
  DISCORD_INSTALL_RESULT_PARAM,
  DISCORD_INSTALLATIONS_PATH,
  DISCORD_OAUTH_SCOPES,
  discordInstallBeginSchema,
  type DiscordConnectionStatus,
  type DiscordInstallation,
  type DiscordInstallResult,
} from "@shiba/shared";
import { DISCORD_API } from "./channels/discord/index.js";
import { rejectCrossOriginMutation, rejectNonJsonMutation } from "./dashboard-mutation.js";
import type { Env } from "./env.js";
import { resolveOrgForApiRequest } from "./org-request-auth.js";
import { isAuthorizedRequest, resolveUserId } from "./request-auth.js";
import { redactSecrets } from "./security.js";
import { isApprover, parseApproverAllowlist } from "./slack-approval.js";

const STATE_TTL_MS = 10 * 60_000;
const GUILD_ID = /^\d{1,24}$/;
const DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
const NO_STORE = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

export const DISCORD_COMMAND_NAME = "shiba";
export const DISCORD_MESSAGE_COMMAND_NAME = "Run with Shiba";

/** Guild commands registered on install: the slash command and the message context-menu command. */
export const DISCORD_GUILD_COMMANDS = [
  {
    name: DISCORD_COMMAND_NAME,
    type: 1,
    description: "Ask Shiba to do a task. It waits for an approver before it runs.",
    options: [
      { type: 3, name: "task", description: "What Shiba should do", required: true, max_length: 4000 },
      { type: 3, name: "repo", description: "GitHub repository URL (optional when this channel is mapped)", required: false },
    ],
  },
  { name: DISCORD_MESSAGE_COMMAND_NAME, type: 3 },
];

export interface DiscordInstallDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

interface InstallationRow {
  guild_id: string;
  org_id: string;
  guild_name: string;
  state: DiscordInstallation["state"];
  installed_by: string;
  installed_at: number;
  updated_at: number;
  commands_registered: number;
  last_error: string | null;
}

class DiscordInstallError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: NO_STORE });

export function discordOAuthConfigured(env: Env): boolean {
  return GUILD_ID.test(env.DISCORD_CLIENT_ID?.trim() ?? "") && Boolean(env.DISCORD_CLIENT_SECRET?.trim());
}

function redirectUriFor(env: Env, origin: string): string {
  return env.DISCORD_OAUTH_REDIRECT_URI?.trim() || new URL(DISCORD_INSTALL_CALLBACK_PATH, origin).href;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function publicInstallation(row: InstallationRow): DiscordInstallation {
  return {
    guildId: row.guild_id,
    guildName: row.guild_name,
    state: row.state,
    installedBy: row.installed_by,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
    commandsRegistered: row.commands_registered === 1,
    lastError: row.last_error,
  };
}

function db(env: Env): D1Database {
  if (!env.AGENT_AUDIT) throw new DiscordInstallError("discord_storage_unavailable", 503);
  return env.AGENT_AUDIT;
}

export async function getDiscordInstallation(env: Env, guildId: string): Promise<InstallationRow | null> {
  return db(env).prepare("SELECT * FROM discord_installations WHERE guild_id=?").bind(guildId).first<InstallationRow>();
}

export type DiscordGuildAccess = { ok: true } | { ok: false; message: string };

/**
 * Whether a signed interaction or a gateway message from this guild may
 * reach Shiba. With the install flow configured, only an active install
 * passes; without it the deployment keeps its operator-configured mode.
 */
export async function checkDiscordGuildAccess(env: Env, guildId: string | undefined): Promise<DiscordGuildAccess> {
  if (!env.DISCORD_CLIENT_ID && !env.DISCORD_CLIENT_SECRET) return { ok: true };
  if (!discordOAuthConfigured(env)) return { ok: false, message: "Discord installation setup is incomplete." };
  if (!guildId || !GUILD_ID.test(guildId)) {
    return { ok: false, message: "Shiba only works inside a connected Discord server." };
  }
  let row: InstallationRow | null;
  try {
    row = await getDiscordInstallation(env, guildId);
  } catch {
    return { ok: false, message: "Shiba could not check this server's connection. Try again shortly." };
  }
  if (!row) return { ok: false, message: "This server is not connected to Shiba. Connect it from the Shiba dashboard." };
  if (row.state !== "active") {
    return { ok: false, message: "This server is disconnected from Shiba. Reconnect it from the Shiba dashboard." };
  }
  return { ok: true };
}

export async function readDiscordConnectionStatus(env: Env, orgId: string, origin: string): Promise<DiscordConnectionStatus> {
  const rows = await db(env)
    .prepare("SELECT * FROM discord_installations WHERE org_id=? ORDER BY installed_at DESC LIMIT 50")
    .bind(orgId)
    .all<InstallationRow>();
  return {
    configured: {
      oauth: discordOAuthConfigured(env),
      publicKey: Boolean(env.DISCORD_PUBLIC_KEY?.trim()),
      botToken: Boolean(env.DISCORD_BOT_TOKEN?.trim()),
      approvers: parseApproverAllowlist(env.DISCORD_APPROVERS).length,
    },
    interactionsUrl: new URL("/api/discord/interactions", origin).href,
    installations: (rows.results ?? []).map(publicInstallation),
  };
}

export async function beginDiscordInstall(
  env: Env,
  input: { orgId: string; userId: string; origin: string; guildId?: string },
  deps: DiscordInstallDeps = {},
): Promise<{ authorizeUrl: string }> {
  if (!discordOAuthConfigured(env)) throw new DiscordInstallError("discord_oauth_not_configured", 503);
  if (input.guildId && (await getDiscordInstallation(env, input.guildId))?.org_id !== input.orgId) {
    throw new DiscordInstallError("discord_installation_not_found", 404);
  }
  const now = (deps.now ?? Date.now)();
  const state = randomState();
  const redirectUri = redirectUriFor(env, input.origin);
  await db(env).batch([
    db(env).prepare("DELETE FROM discord_install_states WHERE expires_at<?").bind(now),
    db(env)
      .prepare("INSERT INTO discord_install_states(state_hash,org_id,user_id,redirect_uri,expected_guild_id,expires_at) VALUES(?,?,?,?,?,?)")
      .bind(await sha256Hex(state), input.orgId, input.userId, redirectUri, input.guildId ?? null, now + STATE_TTL_MS),
  ]);
  const url = new URL(DISCORD_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID!.trim(),
    response_type: "code",
    scope: DISCORD_OAUTH_SCOPES.join(" "),
    permissions: DISCORD_BOT_PERMISSIONS,
    integration_type: "0",
    redirect_uri: redirectUri,
    state,
    prompt: "consent",
    ...(input.guildId ? { guild_id: input.guildId, disable_guild_select: "true" } : {}),
  }).toString();
  return { authorizeUrl: url.href };
}

function basicAuth(env: Env): string {
  return `Basic ${btoa(`${env.DISCORD_CLIENT_ID!.trim()}:${env.DISCORD_CLIENT_SECRET!.trim()}`)}`;
}

async function registerGuildCommands(env: Env, guildId: string, fetchImpl: typeof fetch): Promise<string | null> {
  const botToken = env.DISCORD_BOT_TOKEN?.trim();
  if (!botToken) return "DISCORD_BOT_TOKEN is not set, so the /shiba command was not registered.";
  const response = await fetchImpl(`${DISCORD_API}/applications/${env.DISCORD_CLIENT_ID!.trim()}/guilds/${guildId}/commands`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bot ${botToken}` },
    body: JSON.stringify(DISCORD_GUILD_COMMANDS),
  }).catch(() => null);
  if (!response) return "Discord did not answer the command registration.";
  if (!response.ok) return `Discord refused the command registration (${response.status}).`;
  return null;
}

/**
 * Finish the OAuth2 install. Returns the dashboard result flag; every
 * failure is recorded without echoing Discord's response body.
 */
export async function completeDiscordInstall(
  request: Request,
  env: Env,
  deps: DiscordInstallDeps = {},
): Promise<{ result: DiscordInstallResult; guildId?: string }> {
  const url = new URL(request.url);
  const fetchImpl = deps.fetch ?? fetch;
  const now = (deps.now ?? Date.now)();
  const state = url.searchParams.get("state") ?? "";
  if (!discordOAuthConfigured(env) || !state || state.length > 128) return { result: "failed" };
  const stateHash = await sha256Hex(state);
  const pending = await db(env)
    .prepare("SELECT * FROM discord_install_states WHERE state_hash=? AND consumed_at IS NULL AND expires_at>?")
    .bind(stateHash, now)
    .first<{ org_id: string; user_id: string; redirect_uri: string; expected_guild_id: string | null }>();
  if (!pending || pending.redirect_uri !== url.origin + url.pathname || request.headers.has("authorization")) return { result: "failed" };
  const userId = await isAuthorizedRequest(request, env) ? await resolveUserId(request, env) : null;
  const consumed = await db(env)
    .prepare("UPDATE discord_install_states SET consumed_at=? WHERE state_hash=? AND consumed_at IS NULL")
    .bind(now, stateHash)
    .run();
  if (consumed.meta.changes !== 1) return { result: "failed" };
  if (!userId || userId !== pending.user_id || !isApprover(userId, parseApproverAllowlist(env.DASHBOARD_APPROVERS))) return { result: "failed" };
  if (url.searchParams.has("error")) return { result: "denied" };
  const code = url.searchParams.get("code") ?? "";
  const guildParam = url.searchParams.get("guild_id") ?? "";
  if (!code || code.length > 2048 || (guildParam && (
    !GUILD_ID.test(guildParam) || (pending.expected_guild_id && guildParam !== pending.expected_guild_id)
  ))) return { result: "failed" };

  const exchanged = await fetchImpl(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuth(env) },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: pending.redirect_uri }),
  }).catch(() => null);
  if (!exchanged?.ok) return { result: "failed" };
  const token = (await exchanged.json().catch(() => ({}))) as {
    access_token?: unknown;
    refresh_token?: unknown;
    guild?: { id?: unknown; name?: unknown };
  };
  const tokens = [token.access_token, token.refresh_token];
  for (const credential of tokens) {
    if (typeof credential !== "string") continue;
    await fetchImpl(`${DISCORD_API}/oauth2/token/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuth(env) },
      body: new URLSearchParams({ token: credential, token_type_hint: credential === token.refresh_token ? "refresh_token" : "access_token" }),
    }).catch(() => null);
  }
  const guildId = typeof token.guild?.id === "string" ? token.guild.id : "";
  if (!GUILD_ID.test(guildId) || (guildParam && guildId !== guildParam) ||
    (pending.expected_guild_id && guildId !== pending.expected_guild_id)) return { result: "failed" };
  const guildName = typeof token.guild?.name === "string" ? token.guild.name.slice(0, 100) : guildId;

  const prior = await getDiscordInstallation(env, guildId);
  if (prior && prior.org_id !== pending.org_id) return { result: "failed" };
  const commandError = await registerGuildCommands(env, guildId, fetchImpl);
  const saved = await db(env)
    .prepare(`INSERT INTO discord_installations(guild_id,org_id,guild_name,state,installed_by,installed_at,updated_at,commands_registered,last_error)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(guild_id) DO UPDATE SET org_id=excluded.org_id,guild_name=excluded.guild_name,state=excluded.state,
        installed_by=excluded.installed_by,installed_at=excluded.installed_at,updated_at=excluded.updated_at,
        commands_registered=excluded.commands_registered,last_error=excluded.last_error
        WHERE discord_installations.org_id=excluded.org_id`)
    .bind(guildId, pending.org_id, guildName, "active", userId, now, now, commandError ? 0 : 1, commandError)
    .run();
  if (saved.meta.changes !== 1) return { result: "failed" };
  return { result: "connected", guildId };
}

/** Make the bot leave the guild and stop answering it. Reconnect is a fresh install. */
export async function disconnectDiscordInstallation(
  env: Env,
  orgId: string,
  guildId: string,
  deps: DiscordInstallDeps = {},
): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const fenced = await db(env)
    .prepare(`UPDATE discord_installations
      SET state='disconnected',updated_at=MAX(?,updated_at+1),commands_registered=0,last_error=NULL
      WHERE guild_id=? AND org_id=? RETURNING updated_at`)
    .bind(now, guildId, orgId)
    .first<{ updated_at: number }>();
  if (!fenced) throw new DiscordInstallError("discord_installation_not_found", 404);
  const botToken = env.DISCORD_BOT_TOKEN?.trim();
  let lastError: string | null = null;
  if (botToken) {
    const left = await (deps.fetch ?? fetch)(`${DISCORD_API}/users/@me/guilds/${guildId}`, {
      method: "DELETE",
      headers: { Authorization: `Bot ${botToken}` },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!left) lastError = "Discord did not answer; the bot may still be in the server. Remove it from Server Settings → Integrations.";
    else if (!left.ok && left.status !== 404) lastError = `Discord refused to remove the bot (${left.status}). Remove it from Server Settings → Integrations.`;
  } else {
    lastError = "DISCORD_BOT_TOKEN is not set, so the bot could not leave the server. Remove it from Server Settings → Integrations.";
  }
  if (lastError) {
    await db(env)
      .prepare("UPDATE discord_installations SET last_error=? WHERE guild_id=? AND org_id=? AND state='disconnected' AND updated_at=?")
      .bind(lastError, guildId, orgId, fenced.updated_at)
      .run();
  }
}

async function readBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > 4096) throw new DiscordInstallError("discord_request_too_large", 413);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new DiscordInstallError("discord_request_invalid", 400);
  }
}

/**
 * /api/discord/installations routes. The callback is a top-level browser
 * redirect from Discord; the rest are dashboard JSON calls.
 */
export async function handleDiscordInstallations(
  request: Request,
  env: Env,
  deps: DiscordInstallDeps = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== DISCORD_INSTALLATIONS_PATH && !url.pathname.startsWith(`${DISCORD_INSTALLATIONS_PATH}/`)) return null;
  try {
    if (url.pathname === DISCORD_INSTALL_CALLBACK_PATH) {
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
      const outcome = await completeDiscordInstall(request, env, deps).catch((error: unknown) => {
        console.error("Discord install failed", redactSecrets(String(error)));
        return { result: "failed" as const, guildId: undefined };
      });
      const target = new URL("/app/?view=integrations", url.origin);
      target.searchParams.set(DISCORD_INSTALL_RESULT_PARAM, outcome.result);
      if (outcome.guildId) target.searchParams.set("discordGuild", outcome.guildId);
      return new Response(null, { status: 303, headers: { Location: target.href, ...NO_STORE } });
    }
    if (request.method !== "GET") {
      const denied = rejectCrossOriginMutation(request) ?? rejectNonJsonMutation(request);
      if (denied) return denied;
    }
    const auth = await resolveOrgForApiRequest(request, env);
    if (auth instanceof Response) return auth;
    const userId = auth.principal || auth.workspace ? null : await resolveUserId(request, env);
    if (!userId || !isApprover(userId, parseApproverAllowlist(env.DASHBOARD_APPROVERS))) {
      return json({ error: "Discord setup requires a deployment operator listed in DASHBOARD_APPROVERS." }, 403);
    }
    if (request.method === "GET" && url.pathname === DISCORD_INSTALLATIONS_PATH) {
      return json(await readDiscordConnectionStatus(env, auth.orgId, url.origin));
    }
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const body = await readBody(request);
    if (url.pathname === `${DISCORD_INSTALLATIONS_PATH}/begin`) {
      const parsed = discordInstallBeginSchema.safeParse(body);
      if (!parsed.success) return json({ error: "discord_request_invalid" }, 400);
      return json(await beginDiscordInstall(env, {
        orgId: auth.orgId,
        userId,
        origin: url.origin,
        ...(parsed.data.guildId ? { guildId: parsed.data.guildId } : {}),
      }, deps));
    }
    const match = /^\/api\/discord\/installations\/(\d{1,24})\/disconnect$/.exec(url.pathname);
    if (!match) return json({ error: "not_found" }, 404);
    await disconnectDiscordInstallation(env, auth.orgId, match[1]!, deps);
    return json(await readDiscordConnectionStatus(env, auth.orgId, url.origin));
  } catch (error) {
    if (error instanceof DiscordInstallError) return json({ error: error.code }, error.status);
    console.error("Discord installations route failed", redactSecrets(String(error)));
    return json({ error: "discord_installation_unavailable" }, 503);
  }
}
