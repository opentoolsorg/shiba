import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/discord-mentions.js", () => ({ handleDiscordMention: vi.fn(async () => ({ outcome: "queued" })) }));

import { handleDiscordMention } from "../src/discord-mentions.js";
import { DiscordGateway, ensureDiscordGateway } from "../src/discord-gateway-do.js";

const TOKEN = "bot-token-value";

class FakeSocket extends EventTarget {
  sent: Array<{ op: number; d?: any }> = [];
  send = vi.fn((data: string) => { this.sent.push(JSON.parse(data)); });
  close = vi.fn();
  accept = vi.fn();
  emit(payload: unknown) { this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(payload) })); }
  closeWith(code: number) { this.dispatchEvent(Object.assign(new Event("close"), { code })); }
}

const flush = async () => { for (let i = 0; i < 50; i += 1) await Promise.resolve(); };

function harness(env: Record<string, unknown> = { DISCORD_BOT_TOKEN: TOKEN }) {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage = {
    get: async (key: string) => data.get(key),
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === "string") data.set(key, value);
      else for (const [k, v] of Object.entries(key)) data.set(k, v);
    },
    delete: async (key: string | string[]) => { for (const k of [key].flat()) data.delete(k); },
    setAlarm: async (at: number) => { alarm = at; },
    deleteAlarm: async () => { alarm = null; },
  };
  const waits: Promise<unknown>[] = [];
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith("https://discord.com/api/v10/gateway/bot")) {
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bot ${TOKEN}`);
      return Response.json({ url: "wss://gateway.test" });
    }
    const socket = new FakeSocket();
    sockets.push(socket);
    return { status: 101, webSocket: socket } as unknown as Response;
  });
  const gateway = new DiscordGateway(
    { storage, waitUntil: (p: Promise<unknown>) => waits.push(p) } as never,
    env as never,
    { fetch: fetchMock as typeof fetch },
  );
  const ensure = () => gateway.fetch(new Request("https://internal/ensure", { method: "POST" }));
  return { gateway, data, sockets, urls, waits, ensure, alarm: () => alarm };
}

const hello = { op: 10, d: { heartbeat_interval: 1000 } };
const ready = { op: 0, s: 1, t: "READY", d: { session_id: "sess-1", resume_gateway_url: "wss://resume.test", user: { id: "bot-1" } } };
const message = (extra: Record<string, unknown>) => ({
  op: 0, s: 2, t: "MESSAGE_CREATE",
  d: { id: "m1", channel_id: "c1", content: "<@bot-1> hi", author: { id: "u1" }, mentions: [{ id: "bot-1" }], ...extra },
});

describe("DiscordGateway", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] });
    vi.mocked(handleDiscordMention).mockClear();
  });
  afterEach(() => { vi.useRealTimers(); });

  it("identifies with non-privileged intents after HELLO and arms the alarm", async () => {
    const h = harness();
    await h.ensure();
    expect(h.urls).toEqual(["https://discord.com/api/v10/gateway/bot", "https://gateway.test/?v=10&encoding=json"]);
    expect(h.sockets[0]!.accept).toHaveBeenCalled();
    expect(h.alarm()).not.toBeNull();
    h.sockets[0]!.emit(hello);
    await flush();
    const identify = h.sockets[0]!.sent.find((p) => p.op === 2)!;
    expect(identify.d).toEqual({ token: TOKEN, intents: 1 | 512 | 4096, properties: { os: "linux", browser: "shiba", device: "shiba" } });
    expect(identify.d.intents & (1 << 15)).toBe(0);
  });

  it("heartbeats on HELLO with the last sequence and reconnects when an ACK is missed", async () => {
    const h = harness();
    await h.ensure();
    const socket = h.sockets[0]!;
    socket.emit(hello);
    await flush();
    socket.emit(ready);
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(socket.sent.filter((p) => p.op === 1)).toEqual([{ op: 1, d: 1 }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(socket.close).toHaveBeenCalledWith(4000, "reconnect");
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.sockets).toHaveLength(2);
  });

  it("resumes the stored session after RECONNECT", async () => {
    const h = harness();
    await h.ensure();
    const first = h.sockets[0]!;
    first.emit(hello);
    await flush();
    first.emit(ready);
    await flush();
    first.emit({ op: 7, d: null });
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(first.close).toHaveBeenCalledWith(4000, "reconnect");
    expect(h.urls.at(-1)).toBe("https://resume.test/?v=10&encoding=json");
    const second = h.sockets[1]!;
    second.emit(hello);
    await flush();
    expect(second.sent.find((p) => p.op === 6)).toEqual({ op: 6, d: { token: TOKEN, session_id: "sess-1", seq: 1 } });
    expect(second.sent.some((p) => p.op === 2)).toBe(false);
  });

  it("relays only human messages that mention the bot", async () => {
    const h = harness();
    await h.ensure();
    const socket = h.sockets[0]!;
    socket.emit(hello);
    await flush();
    socket.emit(ready);
    await flush();
    socket.emit(message({ mentions: [] }));
    socket.emit(message({ author: { id: "u2", bot: true } }));
    socket.emit(message({ webhook_id: "w1" }));
    await flush();
    expect(handleDiscordMention).not.toHaveBeenCalled();
    socket.emit(message({}));
    await flush();
    await Promise.all(h.waits);
    expect(handleDiscordMention).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handleDiscordMention).mock.calls[0]![1]).toMatchObject({ id: "m1", channel_id: "c1" });
    expect(vi.mocked(handleDiscordMention).mock.calls[0]![2]).toBe("bot-1");
    expect((h.data.get("session") as { seq: number }).seq).toBe(2);
  });

  it("stops on close code 4004 and reports status without secrets", async () => {
    const h = harness();
    await h.ensure();
    h.sockets[0]!.closeWith(4004);
    await vi.waitFor(() => expect(h.data.get("fatal")).toBeDefined());
    await vi.advanceTimersByTimeAsync(10_000);
    await h.ensure();
    await h.gateway.alarm();
    expect(h.sockets).toHaveLength(1);
    expect(h.alarm()).toBeNull();
    const status = await (await h.gateway.fetch(new Request("https://internal/status"))).json();
    expect(status).toMatchObject({ connected: false, lastError: "gateway closed with code 4004" });
    expect(JSON.stringify(status)).not.toContain(TOKEN);
  });
});

describe("ensureDiscordGateway", () => {
  it("is a no-op without a bot token or binding", async () => {
    const get = vi.fn();
    const namespace = { idFromName: vi.fn(() => "id"), get } as never;
    await ensureDiscordGateway({ DISCORD_GATEWAY: namespace });
    await ensureDiscordGateway({ DISCORD_BOT_TOKEN: TOKEN });
    expect(get).not.toHaveBeenCalled();
  });

  it("pokes the bot singleton when configured", async () => {
    const fetchStub = vi.fn(async () => new Response("{}"));
    const idFromName = vi.fn(() => "id");
    await ensureDiscordGateway({ DISCORD_BOT_TOKEN: TOKEN, DISCORD_GATEWAY: { idFromName, get: () => ({ fetch: fetchStub }) } as never });
    expect(idFromName).toHaveBeenCalledWith("bot");
    expect(fetchStub).toHaveBeenCalledWith("https://internal/ensure", { method: "POST" });
  });
});
