/**
 * DiscordGateway Durable Object. Discord delivers bot mentions only over the
 * Gateway WebSocket, so one singleton ("bot") holds that connection in the
 * Worker and relays MESSAGE_CREATE events that mention the bot to the
 * mention lane. The bot token stays in the Worker; nothing here reaches a
 * container, and the token is never logged or returned.
 */
import { DurableObject } from "cloudflare:workers";
import { handleDiscordMention, type DiscordGatewayMessage } from "./discord-mentions.js";
import type { Env } from "./env.js";
import { redactSecrets } from "./security.js";

const API_GATEWAY_URL = "https://discord.com/api/v10/gateway/bot";
const FALLBACK_GATEWAY_URL = "wss://gateway.discord.gg";
const GATEWAY_QUERY = "?v=10&encoding=json";
const INTENTS = 1 | 512 | 4096;
const ALARM_MS = 60_000;
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

interface GatewaySession { sessionId: string; resumeUrl: string; seq: number }
interface GatewayPayload { op: number; d?: unknown; s?: number | null; t?: string | null }
interface FatalRecord { code: number; tokenHash: string }

export interface DiscordGatewayDeps { fetch?: typeof fetch }

export async function ensureDiscordGateway(env: Pick<Env, "DISCORD_BOT_TOKEN" | "DISCORD_GATEWAY">): Promise<void> {
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GATEWAY) return;
  const stub = env.DISCORD_GATEWAY.get(env.DISCORD_GATEWAY.idFromName("bot"));
  const response = await stub.fetch("https://internal/ensure", { method: "POST" });
  if (!response.ok) throw new Error(`discord gateway ensure failed: ${response.status}`);
}

async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class DiscordGateway extends DurableObject<Env> {
  private socket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private acked = true;
  private ready = false;
  private seq: number | null = null;
  private botUserId: string | null = null;
  private lastEventAt: number | null = null;
  private readonly fetcher: typeof fetch;

  constructor(ctx: DurableObjectState, env: Env, deps: DiscordGatewayDeps = {}) {
    super(ctx, env);
    this.fetcher = deps.fetch ?? ((input, init) => fetch(input, init));
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/ensure") {
      await this.ensure();
      return Response.json({ ok: true });
    }
    if (pathname === "/status" && request.method === "GET") {
      return Response.json({
        connected: this.socket !== null && this.ready,
        botUserId: this.botUserId ?? (await this.ctx.storage.get<string>("botUserId")) ?? null,
        lastError: (await this.ctx.storage.get<string>("lastError")) ?? null,
        lastEventAt: this.lastEventAt,
      });
    }
    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.ensure();
  }

  private async ensure(): Promise<void> {
    const token = this.env.DISCORD_BOT_TOKEN;
    if (!token) return;
    const fatal = await this.ctx.storage.get<FatalRecord>("fatal");
    if (fatal && fatal.tokenHash === (await tokenHash(token))) return;
    await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
    if (this.socket || this.connecting) return this.connecting ?? undefined;
    this.connecting = this.open(token).catch((error: unknown) => {
      console.error("discord gateway connect failed", redactSecrets(String(error)));
    }).finally(() => { this.connecting = null; });
    await this.connecting;
  }

  private async open(token: string): Promise<void> {
    this.botUserId ??= (await this.ctx.storage.get<string>("botUserId")) ?? null;
    const session = await this.ctx.storage.get<GatewaySession>("session");
    let base = session?.resumeUrl;
    if (!base) {
      base = FALLBACK_GATEWAY_URL;
      const discovery = await this.fetcher(API_GATEWAY_URL, { headers: { Authorization: `Bot ${token}` } }).catch(() => null);
      if (discovery?.ok) {
        const body = (await discovery.json().catch(() => null)) as { url?: unknown } | null;
        if (typeof body?.url === "string" && body.url) base = body.url;
      }
    }
    const response = await this.fetcher(`${base.replace(/^wss:/, "https:").replace(/\/+$/, "")}/${GATEWAY_QUERY}`, {
      headers: { Upgrade: "websocket" },
    });
    const ws = response.webSocket;
    if (!ws) throw new Error(`gateway upgrade failed: ${response.status}`);
    ws.accept();
    this.socket = ws;
    this.ready = false;
    this.seq = session?.seq ?? null;
    ws.addEventListener("message", (event) => {
      if (this.socket === ws) void this.onMessage(ws, String(event.data));
    });
    ws.addEventListener("close", (event) => {
      if (this.socket === ws) void this.onClose(event.code);
    });
  }

  private send(ws: WebSocket, payload: GatewayPayload): void {
    ws.send(JSON.stringify(payload));
  }

  private after(ms: number, fn: () => void): void {
    this.timers.push(setTimeout(fn, ms));
  }

  private teardown(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.socket = null;
    this.ready = false;
  }

  private reconnect(ws: WebSocket, delayMs: number): void {
    this.teardown();
    setTimeout(() => void this.ensure(), delayMs);
    try { ws.close(4000, "reconnect"); } catch { return; }
  }

  private async identifyOrResume(ws: WebSocket): Promise<void> {
    const token = this.env.DISCORD_BOT_TOKEN;
    if (!token || this.socket !== ws) return;
    const session = await this.ctx.storage.get<GatewaySession>("session");
    if (session) {
      this.send(ws, { op: 6, d: { token, session_id: session.sessionId, seq: session.seq } });
      return;
    }
    this.send(ws, {
      op: 2,
      d: { token, intents: INTENTS, properties: { os: "linux", browser: "shiba", device: "shiba" } },
    });
  }

  private beat(ws: WebSocket): void {
    if (this.socket !== ws) return;
    if (!this.acked) {
      this.reconnect(ws, 1_000);
      return;
    }
    this.acked = false;
    this.send(ws, { op: 1, d: this.seq });
  }

  private async onMessage(ws: WebSocket, raw: string): Promise<void> {
    let payload: GatewayPayload;
    try { payload = JSON.parse(raw) as GatewayPayload; } catch { return; }
    this.lastEventAt = Date.now();
    switch (payload.op) {
      case 10: {
        const interval = Number((payload.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval) || 41_250;
        this.acked = true;
        this.after(Math.floor(interval * Math.random()), () => {
          this.beat(ws);
          this.heartbeat = setInterval(() => this.beat(ws), interval);
        });
        return this.identifyOrResume(ws);
      }
      case 11: this.acked = true; return;
      case 1: return this.send(ws, { op: 1, d: this.seq });
      case 7: return this.reconnect(ws, 0);
      case 9: {
        if (payload.d !== true) await this.ctx.storage.delete("session");
        this.after(1_000 + Math.floor(Math.random() * 4_000), () => void this.identifyOrResume(ws));
        return;
      }
      case 0: return this.onDispatch(payload);
    }
  }

  private async onDispatch(payload: GatewayPayload): Promise<void> {
    if (typeof payload.s === "number") {
      this.seq = payload.s;
      const session = await this.ctx.storage.get<GatewaySession>("session");
      if (session) await this.ctx.storage.put("session", { ...session, seq: payload.s });
    }
    if (payload.t === "READY") {
      const d = payload.d as { session_id: string; resume_gateway_url: string; user: { id: string } };
      this.botUserId = d.user.id;
      this.ready = true;
      await this.ctx.storage.put({
        session: { sessionId: d.session_id, resumeUrl: d.resume_gateway_url, seq: this.seq ?? 0 },
        botUserId: d.user.id,
      });
      await this.ctx.storage.delete(["lastError", "fatal"]);
      return;
    }
    if (payload.t === "RESUMED") { this.ready = true; return; }
    if (payload.t !== "MESSAGE_CREATE") return;
    const message = payload.d as DiscordGatewayMessage;
    const botUserId = this.botUserId;
    if (!botUserId || message.author?.bot || message.webhook_id) return;
    if (!message.mentions?.some((user) => user.id === botUserId)) return;
    this.ctx.waitUntil(handleDiscordMention(this.env, message, botUserId).then(() => undefined, (error: unknown) => {
      console.error("discord mention failed", redactSecrets(String(error)));
    }));
  }

  private async onClose(code: number): Promise<void> {
    this.teardown();
    const token = this.env.DISCORD_BOT_TOKEN;
    if (FATAL_CLOSE_CODES.has(code)) {
      await this.ctx.storage.put("lastError", `gateway closed with code ${code}`);
      if (token) await this.ctx.storage.put("fatal", { code, tokenHash: await tokenHash(token) } satisfies FatalRecord);
      await this.ctx.storage.delete("session");
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (code === 4007 || code === 4009) await this.ctx.storage.delete("session");
    setTimeout(() => void this.ensure(), 1_000 + Math.floor(Math.random() * 4_000));
  }
}
