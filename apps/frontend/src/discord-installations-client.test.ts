import { describe, expect, it, vi } from "vitest";
import type { DiscordConnectionStatus } from "@shiba/shared";
import { DiscordInstallationsClient, checkDiscordAuthorizeUrl } from "./discord-installations-client";

const WORKSPACE = "ws_" + "a".repeat(24);
const AUTHORIZE = "https://discord.com/oauth2/authorize?client_id=1&scope=bot+applications.commands&state=s";

function status(): DiscordConnectionStatus {
  return {
    configured: { oauth: true, publicKey: true, botToken: true, approvers: 1 },
    interactionsUrl: "https://shiba.test/api/discord/interactions",
    installations: [
      {
        guildId: "111",
        guildName: "Builders",
        state: "active",
        installedBy: "ada@example.test",
        installedAt: 1_763_000_000_000,
        updatedAt: 1_763_000_000_000,
        commandsRegistered: true,
        lastError: null,
      },
    ],
  };
}

describe("DiscordInstallationsClient", () => {
  it("reads status same-origin with the workspace header", async () => {
    const fetcher = vi.fn(async () => Response.json(status()));
    const result = await new DiscordInstallationsClient(WORKSPACE, fetcher).read(new AbortController().signal);
    expect(result.installations[0]?.guildName).toBe("Builders");
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/discord/installations");
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("same-origin");
    expect((init.headers as Record<string, string>)["X-Shiba-Workspace"]).toBe(WORKSPACE);
  });

  it("omits the workspace header in personal scope", async () => {
    const fetcher = vi.fn(async () => Response.json(status()));
    await new DiscordInstallationsClient(undefined, fetcher).read(new AbortController().signal);
    const init = fetcher.mock.calls[0]?.[1 as never] as unknown as RequestInit;
    expect((init.headers as Record<string, string>)["X-Shiba-Workspace"]).toBeUndefined();
  });

  it("begins a new install with an empty body and a reconnect with the guild id", async () => {
    const fetcher = vi.fn(async () => Response.json({ authorizeUrl: AUTHORIZE }));
    const client = new DiscordInstallationsClient(WORKSPACE, fetcher);
    expect(await client.begin(undefined, new AbortController().signal)).toBe(AUTHORIZE);
    expect(await client.begin("111", new AbortController().signal)).toBe(AUTHORIZE);
    const calls = fetcher.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0]?.[0]).toBe("/api/discord/installations/begin");
    expect(calls[0]?.[1].method).toBe("POST");
    expect((calls[0]?.[1].headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(calls[0]?.[1].body))).toEqual({});
    expect(JSON.parse(String(calls[1]?.[1].body))).toEqual({ guildId: "111" });
  });

  it("refuses an authorize URL that is not Discord's OAuth2 page", async () => {
    for (const bad of [
      "https://evil.test/oauth2/authorize",
      "http://discord.com/oauth2/authorize",
      "https://discord.com.evil.test/oauth2/authorize",
      "https://discord.com/oauth2/token",
      "https://user:pass@discord.com/oauth2/authorize",
    ]) {
      expect(() => checkDiscordAuthorizeUrl(bad)).toThrow();
      const client = new DiscordInstallationsClient(WORKSPACE, async () => Response.json({ authorizeUrl: bad }));
      await expect(client.begin(undefined, new AbortController().signal)).rejects.toThrow();
    }
  });

  it("rejects an invalid guild id before sending anything", async () => {
    const fetcher = vi.fn(async () => Response.json(status()));
    const client = new DiscordInstallationsClient(WORKSPACE, fetcher);
    await expect(client.begin("../x", new AbortController().signal)).rejects.toThrow(/Invalid Discord server id/);
    await expect(client.disconnect("abc", new AbortController().signal)).rejects.toThrow(/Invalid Discord server id/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("disconnects a guild and returns the new status", async () => {
    const next = status();
    next.installations[0]!.state = "disconnected";
    const fetcher = vi.fn(async () => Response.json(next));
    const result = await new DiscordInstallationsClient(WORKSPACE, fetcher).disconnect("111", new AbortController().signal);
    expect(result.installations[0]?.state).toBe("disconnected");
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/discord/installations/111/disconnect");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({});
  });

  it("surfaces the server error text, falls back by status, and refuses malformed status", async () => {
    const signal = new AbortController().signal;
    await expect(
      new DiscordInstallationsClient(WORKSPACE, async () => Response.json({ error: "Discord storage is not bound." }, { status: 503 })).read(signal),
    ).rejects.toMatchObject({ message: "Discord storage is not bound.", status: 503 });
    await expect(new DiscordInstallationsClient(WORKSPACE, async () => new Response("no", { status: 403 })).read(signal)).rejects.toThrow(
      /permission/,
    );
    await expect(new DiscordInstallationsClient(WORKSPACE, async () => Response.json({ installations: "nope" })).read(signal)).rejects.toThrow(
      /could not be read/,
    );
  });
});
