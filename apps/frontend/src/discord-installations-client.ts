import {
  DISCORD_INSTALLATIONS_PATH,
  discordConnectionStatusSchema,
  discordInstallBeginResultSchema,
  type DiscordConnectionStatus,
} from "@shiba/shared";
import { withAuthTimeout } from "./auth-timeout";
import { teamWorkspaceHeaders } from "./team-workspaces-client";

const DISCORD_AUTHORIZE_ORIGIN = "https://discord.com";
const DISCORD_AUTHORIZE_PATH = "/oauth2/authorize";
const GUILD_ID = /^\d{1,24}$/;

export class DiscordInstallationsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DiscordInstallationsError";
  }
}

function fallbackMessage(status: number): string {
  if (status === 401) return "Your session expired. Sign in again to manage Discord.";
  if (status === 403) return "You don't have permission to manage the Discord connection.";
  if (status === 404) return "That Discord server is not connected to Shiba.";
  if (status === 503) return "Discord connection storage is unavailable right now.";
  return `Discord request failed (HTTP ${status}).`;
}

async function errorMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (typeof body?.error === "string" && body.error.trim()) return body.error.trim().slice(0, 300);
  return fallbackMessage(response.status);
}

/** The browser is only ever sent to Discord's OAuth2 authorize page; any other destination is refused before navigating. */
export function checkDiscordAuthorizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Discord returned an invalid authorization link.");
  }
  if (url.origin !== DISCORD_AUTHORIZE_ORIGIN || url.pathname !== DISCORD_AUTHORIZE_PATH || url.username || url.password) {
    throw new Error("The authorization link does not point to Discord. Nothing was opened.");
  }
  return url.href;
}

export class DiscordInstallationsClient {
  constructor(
    private readonly workspaceId?: string,
    private readonly fetcher?: typeof fetch,
  ) {}

  private async request(path: string, signal: AbortSignal, body?: object): Promise<unknown> {
    const init: RequestInit = {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal,
      headers: {
        Accept: "application/json",
        ...teamWorkspaceHeaders(this.workspaceId),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    const url = DISCORD_INSTALLATIONS_PATH + path;
    const response = await withAuthTimeout(this.fetcher ? this.fetcher(url, init) : globalThis.fetch(url, init), 20_000);
    if (!response.ok) throw new DiscordInstallationsError(await errorMessage(response), response.status);
    return response.json().catch(() => {
      throw new DiscordInstallationsError("Discord connection status could not be read.", response.status);
    });
  }

  private parseStatus(value: unknown): DiscordConnectionStatus {
    const parsed = discordConnectionStatusSchema.safeParse(value);
    if (!parsed.success) throw new DiscordInstallationsError("Discord connection status could not be read.", 200);
    return parsed.data;
  }

  async read(signal: AbortSignal): Promise<DiscordConnectionStatus> {
    return this.parseStatus(await this.request("", signal));
  }

  async begin(guildId: string | undefined, signal: AbortSignal): Promise<string> {
    if (guildId !== undefined && !GUILD_ID.test(guildId)) throw new Error("Invalid Discord server id.");
    const raw = await this.request("/begin", signal, guildId === undefined ? {} : { guildId });
    const parsed = discordInstallBeginResultSchema.safeParse(raw);
    if (!parsed.success) throw new Error("Discord returned an invalid authorization link.");
    return checkDiscordAuthorizeUrl(parsed.data.authorizeUrl);
  }

  async disconnect(guildId: string, signal: AbortSignal): Promise<DiscordConnectionStatus> {
    if (!GUILD_ID.test(guildId)) throw new Error("Invalid Discord server id.");
    return this.parseStatus(await this.request(`/${guildId}/disconnect`, signal, {}));
  }
}
