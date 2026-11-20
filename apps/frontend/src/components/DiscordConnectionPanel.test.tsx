// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscordConnectionStatus, DiscordInstallation } from "@shiba/shared";
import { DiscordInstallationsClient } from "../discord-installations-client";
import { DiscordConnectionPanel, DiscordStatusChip, discordBindingInput, useDiscordConnection } from "./DiscordConnectionPanel";

const AUTHORIZE = "https://discord.com/oauth2/authorize?client_id=1&state=s";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

function guild(overrides: Partial<DiscordInstallation> = {}): DiscordInstallation {
  return {
    guildId: "111",
    guildName: "Builders",
    state: "active",
    installedBy: "ada@example.test",
    installedAt: 1_763_000_000_000,
    updatedAt: 1_763_000_000_000,
    commandsRegistered: true,
    lastError: null,
    ...overrides,
  };
}

function status(overrides: Partial<DiscordConnectionStatus> = {}): DiscordConnectionStatus {
  return {
    configured: { oauth: true, publicKey: true, botToken: true, approvers: 2 },
    interactionsUrl: "https://shiba.test/api/discord/interactions",
    installations: [guild()],
    ...overrides,
  };
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function setup(handler: Handler) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init ?? {}));
  const navigate = vi.fn();
  const client = new DiscordInstallationsClient(undefined, fetcher as unknown as typeof fetch);
  function Harness() {
    const connection = useDiscordConnection({ client, navigate });
    return (
      <>
        <div data-testid="chip">
          <DiscordStatusChip connection={connection} />
        </div>
        <DiscordConnectionPanel connection={connection} />
      </>
    );
  }
  render(<Harness />);
  return { fetcher, navigate };
}

function chip(): string {
  return screen.getByTestId("chip").textContent ?? "";
}

describe("DiscordConnectionPanel", () => {
  it("shows Checking… while the status loads", () => {
    setup(() => new Promise<Response>(() => {}));
    expect(chip()).toBe("Checking…");
    expect(screen.getByText("Checking Discord connection…")).toBeTruthy();
  });

  it("renders connected servers with installer details and the connect button", async () => {
    setup(() => Response.json(status({ installations: [guild(), guild({ guildId: "222", guildName: "Ops" })] })));
    await screen.findByText("Builders");
    expect(chip()).toBe("Connected (2 servers)");
    expect(screen.getAllByText(/Installed by ada@example.test/)).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Disconnect Builders" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reconnect Builders" })).toBeNull();
    expect(screen.getByRole("button", { name: "Connect a server" })).toBeTruthy();
  });

  it("lists exactly the missing settings and the interactions URL when setup is incomplete", async () => {
    setup(() =>
      Response.json(status({ configured: { oauth: false, publicKey: true, botToken: false, approvers: 0 }, installations: [] })),
    );
    const block = await screen.findByTestId("discord-setup-required");
    expect(chip()).toBe("Setup required");
    expect(block.textContent).toContain("DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET");
    expect(block.textContent).toContain("DISCORD_BOT_TOKEN");
    expect(block.textContent).toContain("DISCORD_APPROVERS");
    expect(block.textContent).not.toContain("DISCORD_PUBLIC_KEY");
    expect(block.textContent).toContain("https://shiba.test/api/discord/interactions");
    expect(screen.queryByRole("button", { name: "Connect a server" })).toBeNull();
  });

  it("shows Disconnected with a reconnect that posts the guild id and navigates", async () => {
    const { fetcher, navigate } = setup((url) =>
      url.endsWith("/begin") ? Response.json({ authorizeUrl: AUTHORIZE }) : Response.json(status({ installations: [guild({ state: "disconnected" })] })),
    );
    await screen.findByText("Builders");
    expect(chip()).toBe("Disconnected");
    fireEvent.click(screen.getByRole("button", { name: "Reconnect Builders" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(AUTHORIZE));
    const begin = fetcher.mock.calls.find(([url]) => String(url).endsWith("/begin"));
    expect(JSON.parse(String(begin?.[1]?.body))).toEqual({ guildId: "111" });
  });

  it("shows Error with the last error text and a commands warning", async () => {
    setup(() =>
      Response.json(
        status({
          installations: [
            guild({ state: "error", lastError: "Missing Access (50001)" }),
            guild({ guildId: "222", guildName: "Ops", state: "disconnected" }),
          ],
        }),
      ),
    );
    await screen.findByText("Last error: Missing Access (50001)");
    expect(chip()).toBe("Error");
    cleanup();
    setup(() => Response.json(status({ installations: [guild({ commandsRegistered: false })] })));
    await screen.findByText(/Slash commands aren't registered/);
    expect(screen.getByRole("button", { name: "Reconnect Builders" })).toBeTruthy();
  });

  it("shows the load error and the Error chip when status is unavailable", async () => {
    setup(() => Response.json({ error: "Discord storage is not bound." }, { status: 503 }));
    expect((await screen.findByRole("alert")).textContent).toBe("Discord storage is not bound.");
    expect(chip()).toBe("Error");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("connect navigates to the Discord authorize URL with an empty body", async () => {
    const { fetcher, navigate } = setup((url) => (url.endsWith("/begin") ? Response.json({ authorizeUrl: AUTHORIZE }) : Response.json(status())));
    fireEvent.click(await screen.findByRole("button", { name: "Connect a server" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(AUTHORIZE));
    expect(screen.getByRole("button", { name: "Opening Discord…" }).hasAttribute("disabled")).toBe(true);
    const begin = fetcher.mock.calls.find(([url]) => String(url).endsWith("/begin"));
    expect(JSON.parse(String(begin?.[1]?.body))).toEqual({});
  });

  it("does not navigate to a non-Discord URL and shows the error inline", async () => {
    const { navigate } = setup((url) =>
      url.endsWith("/begin") ? Response.json({ authorizeUrl: "https://evil.test/oauth2/authorize" }) : Response.json(status()),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Connect a server" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/does not point to Discord/);
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Connect a server" }).hasAttribute("disabled")).toBe(false);
  });

  it("asks for an inline confirmation, then disconnects and re-renders", async () => {
    const { fetcher } = setup((url) =>
      url.endsWith("/disconnect") ? Response.json(status({ installations: [guild({ state: "disconnected" })] })) : Response.json(status()),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Builders" }));
    expect(screen.getByRole("group", { name: "Confirm disconnecting Builders" })).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Confirm disconnecting Builders" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Builders" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm disconnect" }));
    await waitFor(() => expect(chip()).toBe("Disconnected"));
    const call = fetcher.mock.calls[1];
    expect(String(call?.[0])).toBe("/api/discord/installations/111/disconnect");
    expect(call?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({});
    expect(screen.getByRole("button", { name: "Reconnect Builders" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Confirm disconnecting Builders" })).toBeNull();
  });

  it("keeps the server and shows the error inline when disconnect fails", async () => {
    setup((url) => (url.endsWith("/disconnect") ? Response.json({ error: "Discord rejected the request." }, { status: 502 }) : Response.json(status())));
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Builders" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm disconnect" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Discord rejected the request.");
    expect(chip()).toBe("Connected (1 server)");
    expect(screen.getByRole("button", { name: "Confirm disconnect" })).toBeTruthy();
  });

  it("shows the install result once and strips it from the URL", async () => {
    window.history.replaceState(null, "", "/app/?tab=connectors&discordInstall=connected&discordGuild=111");
    setup(() => Response.json(status()));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Connected Builders."));
    expect(window.location.pathname).toBe("/app/");
    expect(window.location.search).toBe("?tab=connectors");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/Connected Builders/)).toBeNull();
    cleanup();
    window.history.replaceState(null, "", "/app/?discordInstall=denied");
    setup(() => Response.json(status()));
    expect((await screen.findByText(/authorization was cancelled/)).textContent).toBeTruthy();
    expect(window.location.search).toBe("");
  });

  it("feeds the integration catalog binding from real status", () => {
    expect(discordBindingInput({ status: null, loadError: "x" })).toBeUndefined();
    expect(discordBindingInput({ status: status(), loadError: null })).toEqual({ loading: false, configured: true, partial: true });
    expect(
      discordBindingInput({
        status: status({ configured: { oauth: false, publicKey: false, botToken: false, approvers: 0 }, installations: [] }),
        loadError: null,
      }),
    ).toEqual({ loading: false, configured: false, partial: false });
  });
});
