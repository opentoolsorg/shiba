/**
 * Discord bot installation wire contract. The bot is installed into a
 * Discord server (guild) through OAuth2; the Worker keeps one row per
 * guild and only answers interactions and mentions from an active one.
 * No token ever appears in these shapes.
 */
import { z } from "zod";

export const DISCORD_INSTALLATIONS_PATH = "/api/discord/installations";
export const DISCORD_INSTALL_CALLBACK_PATH = "/api/discord/installations/callback";

/** bot + applications.commands: the bot joins the guild and can own guild slash commands. */
export const DISCORD_OAUTH_SCOPES = ["bot", "applications.commands"] as const;
/**
 * View Channel (1024) + Send Messages (2048) + Read Message History (65536)
 * + Send Messages in Threads (274877906944). Nothing else.
 */
export const DISCORD_BOT_PERMISSIONS = String(1024 + 2048 + 65536 + 274877906944);

export const discordInstallationStateSchema = z.enum(["active", "disconnected", "error"]);
export type DiscordInstallationState = z.infer<typeof discordInstallationStateSchema>;

export const discordInstallationSchema = z.object({
  guildId: z.string().regex(/^\d{1,24}$/),
  guildName: z.string(),
  state: discordInstallationStateSchema,
  installedBy: z.string(),
  installedAt: z.number().int(),
  updatedAt: z.number().int(),
  commandsRegistered: z.boolean(),
  lastError: z.string().nullable(),
});
export type DiscordInstallation = z.infer<typeof discordInstallationSchema>;

export const discordConnectionStatusSchema = z.object({
  configured: z.object({
    /** DISCORD_CLIENT_ID + DISCORD_CLIENT_SECRET: the dashboard can run the install flow. */
    oauth: z.boolean(),
    /** DISCORD_PUBLIC_KEY: the interactions endpoint verifies signatures. */
    publicKey: z.boolean(),
    /** DISCORD_BOT_TOKEN: the bot can post cards and results, and hold the mention connection. */
    botToken: z.boolean(),
    /** Count of DISCORD_APPROVERS user ids. Zero means nobody can approve. */
    approvers: z.number().int().nonnegative(),
  }),
  interactionsUrl: z.string(),
  installations: z.array(discordInstallationSchema),
});
export type DiscordConnectionStatus = z.infer<typeof discordConnectionStatusSchema>;

export const discordInstallBeginSchema = z.object({
  /** Reconnect: preselect the guild that was disconnected. */
  guildId: z.string().regex(/^\d{1,24}$/).optional(),
}).strict();
export type DiscordInstallBegin = z.infer<typeof discordInstallBeginSchema>;

export const discordInstallBeginResultSchema = z.object({ authorizeUrl: z.string().url() });
export type DiscordInstallBeginResult = z.infer<typeof discordInstallBeginResultSchema>;

/** Query flag the callback appends to /app/ so the dashboard can show the outcome. */
export const DISCORD_INSTALL_RESULT_PARAM = "discordInstall";
export const discordInstallResultSchema = z.enum(["connected", "denied", "failed"]);
export type DiscordInstallResult = z.infer<typeof discordInstallResultSchema>;
