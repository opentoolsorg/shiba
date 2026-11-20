/**
 * Microsoft Teams channel: Bot Framework Connector adapter and transport.
 *
 * Inbound activities carry `Authorization: Bearer <JWT>` signed by the Bot
 * Connector. The token is checked against the published Bot Framework keys
 * (RS256, issuer api.botframework.com, audience TEAMS_APP_ID, the activity's
 * serviceUrl and the key's channel endorsement). The JWT binds the
 * serviceUrl, not the body bytes.
 *
 * Outbound calls use a client-credentials token for TEAMS_APP_ID. The
 * Connector has no bot reactions, uploads (file consent / Graph), history,
 * or name lookups by id alone, so those are unsupported.
 */
import { buildChatThreadName } from "@shiba/shared";
import type { Env } from "../../env.js";
import {
  ChannelUnsupportedError,
  dedupeIds,
  type ChannelAdapter,
  type ChannelAdapterOptions,
  type ChannelCapability,
  type ChannelDefinition,
  type ChannelTransport,
  type ChannelVerification,
  type InboundEvent,
} from "../../ports/channel/index.js";
import { asString, channelFetch, readFile, readJsonObject } from "../http.js";

export const TEAMS_DEFAULT_SERVICE_URL = "https://smba.trafficmanager.net/teams/";
export const TEAMS_OPENID_CONFIG = "https://login.botframework.com/v1/.well-known/openidconfiguration";
const TEAMS_ISSUER = "https://api.botframework.com";
const TEAMS_JWKS_URI = "https://login.botframework.com/v1/.well-known/keys";
const TEAMS_SCOPE = "https://api.botframework.com/.default";
const CLOCK_SKEW_S = 300;
const KEYS_TTL_MS = 24 * 60 * 60 * 1000;
const KEYS_REFRESH_COOLDOWN_MS = 60_000;

const CAPABILITIES: ReadonlySet<ChannelCapability> = new Set<ChannelCapability>(["post", "edit", "download"]);

export interface TeamsActivity {
  type?: string;
  id?: string;
  timestamp?: string;
  serviceUrl?: string;
  action?: string;
  channelId?: string;
  from?: { id?: string; name?: string; aadObjectId?: string };
  conversation?: { id?: string; name?: string; conversationType?: string; tenantId?: string };
  recipient?: { id?: string; name?: string };
  text?: string;
  value?: unknown;
  replyToId?: string;
  entities?: Array<{ type?: string; text?: string; mentioned?: { id?: string; name?: string } }>;
  channelData?: { tenant?: { id?: string }; team?: { id?: string } };
}

export function isTeamsServiceUrl(serviceUrl: unknown): serviceUrl is string {
  return typeof serviceUrl === "string" && /^https:\/\/smba\.trafficmanager\.net(?:\/[a-z0-9-]{1,64}){1,3}\/?$/.test(serviceUrl);
}

function serviceBase(serviceUrl: string): string {
  if (!isTeamsServiceUrl(serviceUrl)) throw new Error("Invalid Teams Connector service URL.");
  return serviceUrl.endsWith("/") ? serviceUrl : `${serviceUrl}/`;
}

/** Teams marks mentions inline as <at>Name</at>; ids live only in entities. */
export function stripTeamsMentions(text: string): string {
  return text.replace(/<at>[^<]*<\/at>/gi, " ").replace(/\s+/g, " ").trim();
}

/** Names inside <at>…</at>; the activity's entities carry the ids. */
export function teamsMentions(text: string): string[] {
  return dedupeIds([...text.matchAll(/<at>([^<]+)<\/at>/gi)].map((m) => (m[1] ?? "").trim()).filter(Boolean));
}

type TeamsCredentials = {
  appId: string;
  appPassword: string;
  tenantId?: string;
};

export async function requestTeamsToken(input: TeamsCredentials, fetchImpl: typeof fetch = fetch) {
  const tenant = input.tenantId?.trim() || "botframework.com";
  if (tenant !== "botframework.com" && !/^[a-f0-9-]{36}$/i.test(tenant)) throw new Error("Invalid Teams tenant ID.");
  const response = await channelFetch(fetchImpl, "Teams token", `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: input.appId,
      client_secret: input.appPassword,
      scope: TEAMS_SCOPE,
    }).toString(),
  });
  if (!response.ok) throw new Error(`Teams token request failed (${response.status}).`);
  const json = await readJsonObject(response);
  const token = typeof json.access_token === "string" ? json.access_token : "";
  if (!token) throw new Error("Teams token response had no access_token.");
  const expiresIn = Number(json.expires_in);
  return { token, expiresAt: Date.now() + (Number.isFinite(expiresIn) ? Math.max(0, expiresIn) : 0) * 1000 };
}

export function createTeamsAdapter(input: TeamsCredentials & {
  serviceUrl?: string;
  fetch?: typeof fetch;
}): ChannelAdapter {
  const fetchImpl = input.fetch ?? fetch;
  const base = serviceBase(input.serviceUrl ?? TEAMS_DEFAULT_SERVICE_URL);
  const serviceOrigin = new URL(base).origin;
  let cached: { token: string; expiresAt: number } | null = null;
  const token = async (): Promise<string> => {
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    cached = await requestTeamsToken(input, fetchImpl);
    return cached.token;
  };
  const request = async (label: string, method: string, path: string, body: unknown): Promise<Record<string, unknown>> => {
    const response = await channelFetch(fetchImpl, `Teams ${label}`, `${base}${path}`, {
      method,
      redirect: "manual",
      headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Teams ${label} failed (${response.status}).`);
    return readJsonObject(response).catch(() => ({}));
  };
  const conversationPath = (placeId: string) => `v3/conversations/${encodeURIComponent(placeId)}/activities`;
  return {
    channel: "teams",
    capabilities: CAPABILITIES,
    async post(post) {
      const replyTo = post.replyToMessageId ?? post.threadId;
      const sent = await request(
        "post",
        "POST",
        replyTo ? `${conversationPath(post.placeId)}/${encodeURIComponent(replyTo)}` : conversationPath(post.placeId),
        {
          ...post.native,
          type: "message",
          textFormat: "plain",
          text: post.text,
          ...(replyTo ? { replyToId: replyTo } : {}),
        },
      );
      return { placeId: post.placeId, messageId: asString(sent.id), ...(post.threadId ? { threadId: post.threadId } : {}) };
    },
    async edit(edit) {
      await request("edit", "PUT", `${conversationPath(edit.ref.placeId)}/${encodeURIComponent(edit.ref.messageId)}`, {
        attachments: [],
        ...edit.native,
        type: "message",
        textFormat: "plain",
        id: edit.ref.messageId,
        text: edit.text,
      });
    },
    react() {
      return Promise.reject(new ChannelUnsupportedError("teams", "react"));
    },
    upload() {
      return Promise.reject(new ChannelUnsupportedError("teams", "upload"));
    },
    async download(url) {
      const target = new URL(url);
      if (target.protocol !== "https:") throw new Error("Teams download only fetches https URLs.");
      // The bot token only goes to the Connector host that issued the attachment.
      const headers: Record<string, string> = target.origin === serviceOrigin ? { Authorization: `Bearer ${await token()}` } : {};
      return readFile(await channelFetch(fetchImpl, "Teams download", url, { method: "GET", headers, redirect: "manual" }), "Teams download");
    },
    history() {
      return Promise.reject(new ChannelUnsupportedError("teams", "history"));
    },
    recent() {
      return Promise.reject(new ChannelUnsupportedError("teams", "recent"));
    },
    authorName() {
      return Promise.reject(new ChannelUnsupportedError("teams", "authorName"));
    },
    placeName() {
      return Promise.reject(new ChannelUnsupportedError("teams", "placeName"));
    },
    mentions: teamsMentions,
  };
}

interface Jwk { kid?: string; kty?: string; n?: string; e?: string; use?: string; endorsements?: string[] }

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(base64UrlBytes(segment)));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function parseTeamsActivity(rawBody: string): TeamsActivity | null {
  try {
    const value: unknown = JSON.parse(rawBody);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as TeamsActivity : null;
  } catch {
    return null;
  }
}

function conversationKeyFor(placeId: string): string {
  try {
    return buildChatThreadName("teams", placeId);
  } catch {
    return "";
  }
}

const DENIED: ChannelVerification = { ok: false, status: 401, error: "Invalid Teams bearer token." };

export function createTeamsTransport(options: ChannelAdapterOptions = {}): ChannelTransport {
  let keys: { jwks: Jwk[]; fetchedAt: number } | null = null;
  const loadKeys = async (now: number, force: boolean): Promise<Jwk[]> => {
    if (keys && !force && now - keys.fetchedAt < KEYS_TTL_MS) return keys.jwks;
    const fetchImpl = options.fetch ?? fetch;
    const configResponse = await channelFetch(fetchImpl, "Teams OpenID config", TEAMS_OPENID_CONFIG, { method: "GET", redirect: "manual" });
    if (!configResponse.ok) throw new Error("Teams OpenID metadata unavailable.");
    const config = await readJsonObject(configResponse);
    const jwksUri = asString(config.jwks_uri);
    if (jwksUri !== TEAMS_JWKS_URI) throw new Error("Unexpected Teams OpenID signing keys URI.");
    const keysResponse = await channelFetch(fetchImpl, "Teams signing keys", jwksUri, { method: "GET", redirect: "manual" });
    if (!keysResponse.ok) throw new Error("Teams signing keys unavailable.");
    const set = await readJsonObject(keysResponse);
    if (!Array.isArray(set.keys) || set.keys.length === 0) throw new Error("Teams signing keys unavailable.");
    const jwks = set.keys.filter((key): key is Jwk => typeof key === "object" && key !== null);
    keys = { jwks, fetchedAt: now };
    return jwks;
  };
  return {
    channel: "teams",
    async verify(rawBody, headers, env, now = Date.now()) {
      const appId = env.TEAMS_APP_ID?.trim() ?? "";
      if (!appId || !env.TEAMS_APP_PASSWORD?.trim()) {
        return { ok: false, status: 503, error: "Teams is not configured: set TEAMS_APP_ID and TEAMS_APP_PASSWORD." };
      }
      const bearer = /^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/i.exec(headers.get("Authorization") ?? "");
      if (!bearer) return DENIED;
      const [, h, p, s] = bearer as unknown as [string, string, string, string];
      const header = decodeJson(h);
      const claims = decodeJson(p);
      const activity = parseTeamsActivity(rawBody);
      if (!header || !claims || !activity || header.alg !== "RS256" || typeof header.kid !== "string" ||
        activity.channelId !== "msteams" || !isTeamsServiceUrl(activity.serviceUrl)) return DENIED;
      const nowS = Math.floor(now / 1000);
      const audience = Array.isArray(claims.aud) && claims.aud.length === 1 ? claims.aud[0] : claims.aud;
      if (claims.iss !== TEAMS_ISSUER || audience !== appId) return DENIED;
      if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp + CLOCK_SKEW_S < nowS) return DENIED;
      if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf - CLOCK_SKEW_S > nowS)) return DENIED;
      const { serviceurl, serviceUrl } = claims;
      if ((serviceurl ?? serviceUrl) !== activity.serviceUrl ||
        (serviceurl !== undefined && serviceUrl !== undefined && serviceurl !== serviceUrl)) return DENIED;
      let jwk: Jwk | undefined;
      try {
        jwk = (await loadKeys(now, false)).find((k) => k.kid === header.kid);
        if (!jwk && keys && now - keys.fetchedAt >= KEYS_REFRESH_COOLDOWN_MS) {
          jwk = (await loadKeys(now, true)).find((k) => k.kid === header.kid);
        }
      } catch {
        return DENIED;
      }
      if (jwk?.kty !== "RSA" || !jwk.n || !jwk.e || (jwk.use !== undefined && jwk.use !== "sig")) return DENIED;
      if (!Array.isArray(jwk.endorsements) || !jwk.endorsements.includes("msteams")) return DENIED;
      let valid = false;
      try {
        const key = await crypto.subtle.importKey(
          "jwk",
          { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        );
        valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlBytes(s), new TextEncoder().encode(`${h}.${p}`));
      } catch {
        return DENIED;
      }
      if (!valid) return DENIED;
      return { ok: true };
    },
    parse(rawBody) {
      const activity = parseTeamsActivity(rawBody);
      if (activity?.type !== "message") return null;
      const placeId = typeof activity.conversation?.id === "string" ? activity.conversation.id : "";
      const workspaceId = activity.conversation?.tenantId ?? activity.channelData?.tenant?.id;
      const actorId = activity.from?.aadObjectId ?? activity.from?.id ?? "";
      const base = {
        channel: "teams" as const,
        deliveryId: activity.id ?? "",
        conversationKey: conversationKeyFor(placeId),
        placeId,
        ...(workspaceId ? { workspaceId } : {}),
        raw: activity,
      };
      const value = activity.value as { shiba?: unknown } | undefined;
      if (value && typeof value === "object" && typeof value.shiba === "string") {
        return {
          ...base,
          kind: "action",
          ...(activity.replyToId ? { messageId: activity.replyToId } : {}),
          actorId,
          ...(activity.from?.name ? { actorName: activity.from.name } : {}),
          actionId: value.shiba,
          value: value.shiba,
        };
      }
      if (typeof activity.text !== "string") return null;
      const mentioned = dedupeIds((Array.isArray(activity.entities) ? activity.entities : [])
        .map((e) => (e?.type === "mention" ? e.mentioned?.id : undefined))
        .filter((id): id is string => typeof id === "string"));
      return {
        ...base,
        kind: "message",
        messageId: activity.id ?? "",
        ...(activity.replyToId ? { threadId: activity.replyToId } : {}),
        authorId: actorId,
        ...(activity.from?.name ? { authorName: activity.from.name } : {}),
        text: activity.text,
        mentionedUserIds: mentioned,
        isDirect: activity.conversation?.conversationType === "personal",
        isBot: false,
      };
    },
    conversationKey: (event: InboundEvent) => conversationKeyFor(event.placeId),
  };
}

export const teamsTransport = createTeamsTransport();

export function teamsAdapterFromEnv(env: Env, options: ChannelAdapterOptions & { serviceUrl?: string } = {}): ChannelAdapter | null {
  const appId = env.TEAMS_APP_ID?.trim();
  const appPassword = env.TEAMS_APP_PASSWORD?.trim();
  if (!appId || !appPassword) return null;
  const tenantId = env.TEAMS_APP_TENANT_ID?.trim();
  const serviceUrl = options.serviceUrl;
  return createTeamsAdapter({
    appId,
    appPassword,
    ...(tenantId ? { tenantId } : {}),
    ...(serviceUrl ? { serviceUrl } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

export const teamsChannel: ChannelDefinition = {
  id: "teams",
  requiredSecrets: ["TEAMS_APP_ID", "TEAMS_APP_PASSWORD"],
  transport: teamsTransport,
  createAdapter: (env: Env, options: ChannelAdapterOptions = {}) => teamsAdapterFromEnv(env, options),
};
