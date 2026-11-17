// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AcpProviderCard, AcpProvidersSnapshot } from "@shiba/shared";
import { ProvidersView } from "./ProvidersView";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function card(overrides: Partial<AcpProviderCard["connection"]> = {}): AcpProviderCard {
  return {
    id: "codex",
    label: "Codex",
    blurb: "Codex via sign-in.",
    adapter: "codex-acp",
    packageName: "codex-acp",
    license: "Apache-2.0",
    harness: "codex-acp",
    protocol: "acp",
    spawn: ["codex"],
    defaultModel: "openai/gpt-5.3-codex",
    docsUrl: "https://example.com",
    capabilities: {
      streamsText: true,
      toolCalls: true,
      permissions: true,
      setModel: true,
      oauth: true,
      apiKey: true,
      acp: true,
    },
    credentialEnv: ["AI_GATEWAY_TOKEN"],
    isDefault: false,
    connection: {
      phase: "waiting",
      authMode: "oauth",
      message: "Enter the code, then finish.",
      userCode: "UPYX-F4F7",
      verificationUri: "https://auth.openai.com/codex/device",
      expiresAt: Date.now() + 60_000,
      testedAt: null,
      testOk: null,
      ...overrides,
    },
  };
}

function snapshot(connection?: Partial<AcpProviderCard["connection"]>): AcpProvidersSnapshot {
  return { org: "self-hosted", defaultProviderId: null, providers: [card(connection)] };
}

describe("ProvidersView sign-in", () => {
  it("keeps a rejected Claude token in the paste state and disables sign-in while checking", async () => {
    const claude = {
      ...card({ signInKind: "claude-setup-token", userCode: null, verificationUri: null, message: "Paste your setup token." }),
      id: "claude",
      label: "Claude Code",
      harness: "claude-acp",
    } satisfies AcpProviderCard;
    const rejected = "Anthropic rejected this token. Run claude setup-token again and paste the new token.";
    let finishCheck: () => void = () => {};
    const checking = new Promise<void>((resolve) => { finishCheck = resolve; });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/providers/claude/verify") {
        expect(JSON.parse(String(init?.body))).toEqual({ credential: "test-setup-token" });
        await checking;
        return Response.json({ org: "self-hosted", defaultProviderId: null, providers: [{ ...claude, connection: { ...claude.connection, message: rejected } }] });
      }
      if (url === "/api/providers") {
        return Response.json({ org: "self-hosted", defaultProviderId: null, providers: [claude] });
      }
      return Response.json({ connections: [], connectionOrder: [], policy: { version: 1, models: {}, updatedAt: 0 }, purposes: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ProvidersView />);
    const input = await screen.findByTestId("provider-setup-token-claude");
    fireEvent.change(input, { target: { value: "test-setup-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Finish sign-in" }));
    expect((screen.getByRole("button", { name: "Checking…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((input as HTMLInputElement).disabled).toBe(true);
    finishCheck();
    const message = await screen.findByText(rejected);
    expect(screen.getByTestId("provider-status-claude").textContent).toContain("Sign-in pending");
    expect(input.getAttribute("aria-describedby")).toBe(message.id);
    expect(input.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((screen.getByRole("button", { name: "Finish sign-in" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a Default badge for an automatically selected provider", async () => {
    const provider = { ...card({ phase: "connected", userCode: null, verificationUri: null }), isDefault: true };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url === "/api/providers" ? { org: "self-hosted", defaultProviderId: "codex", providers: [provider] } : { connections: [], connectionOrder: [], policy: { version: 1, models: {}, updatedAt: 0 }, purposes: [] } })));
    render(<ProvidersView />);
    expect(await screen.findByText("Default")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set as my default" })).toBeNull();
  });

  it("shows a timed-out sign-in as muted text with a reconnect action", async () => {
    const message = "The last sign-in timed out. Connect again when you're ready.";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url === "/api/providers" ? snapshot({ phase: "disconnected", authMode: null, message, userCode: null, verificationUri: null, expiresAt: null }) : { connections: [], connectionOrder: [], policy: { version: 1, models: {}, updatedAt: 0 }, purposes: [] } })));
    render(<ProvidersView />);
    const notice = await screen.findByText(message);
    expect(notice.className).toContain("text-[var(--muted-foreground-2)]");
    expect(notice.getAttribute("role")).not.toBe("alert");
    expect(screen.getByTestId("provider-connect-oauth-codex")).toBeTruthy();
    expect(screen.getByTestId("provider-status-codex").textContent).not.toContain("failed");
  });

  it("opens the vendor page and finishes at Connected", async () => {
    const open = vi.fn(() => ({ closed: false }) as Window);
    vi.stubGlobal("open", open);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/providers" && !init?.method) {
        return { ok: true, json: async () => snapshot() };
      }
      if (url === "/api/providers/codex/verify") {
        const body = JSON.parse(String(init?.body)) as { userCode?: string };
        expect(body.userCode).toBe("UPYX-F4F7");
        return {
          ok: true,
          json: async () => snapshot({ phase: "connected", userCode: null, verificationUri: null, message: "ChatGPT subscription is connected." }),
        };
      }
      return { ok: true, json: async () => ({ connections: [], connectionOrder: [], policy: { version: 1, models: {}, updatedAt: 0 }, purposes: [] }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ProvidersView />);
    expect((await screen.findByTestId("provider-status-codex")).textContent).toContain("Sign-in pending");
    const link = screen.getByTestId("provider-open-codex");
    expect(link.getAttribute("href")).toBe("https://auth.openai.com/codex/device");
    fireEvent.click(link);
    expect(open).toHaveBeenCalledWith("https://auth.openai.com/codex/device", "_blank", "noopener,noreferrer");

    fireEvent.click(screen.getByRole("button", { name: "Finish sign-in" }));
    await waitFor(() => {
      expect(screen.getByTestId("provider-status-codex").textContent).toContain("Connected");
    });
    expect(screen.getByTestId("provider-signin-message-codex").textContent).toMatch(/connected/i);
  });

  it("shows the ChatGPT task lane separately from registry ACP metadata and checks only on request", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/providers") return { ok: true, json: async () => snapshot({ phase: "connected", signInKind: "chatgpt-device", testOk: true, userCode: null, verificationUri: null, message: "Saved account is present." }) };
      return { ok: true, json: async () => ({ connections: [], connectionOrder: [], policy: { version: 1, models: {}, updatedAt: 0 }, purposes: [] }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ProvidersView />);
    const route = await screen.findByTestId("provider-route-codex");
    expect(route.textContent).toContain("codex-subscription");
    expect(route.textContent).toContain("Signed-in user's ChatGPT plan");
    expect(screen.getByTestId("provider-status-codex").textContent).toContain("Configuration checked");
    expect(screen.getByRole("button", { name: "Check saved configuration" })).toBeTruthy();
    expect(screen.getByText(/Registry adapter/).parentElement?.textContent).toContain("codex-acp");
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/test") || String(url).endsWith("/default"))).toBe(false);
  });

  it.each(["Access expired. Sign in again.", "Provider quota exceeded.", "Selected computer is offline."])("preserves a failed check without promising inference or changing accounts: %s", async (message) => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/providers") return { ok: true, json: async () => snapshot({ phase: "connected", testOk: false, message, userCode: null, verificationUri: null }) };
      return { ok: true, json: async () => ({ connections: [], connectionOrder: [], policy: { version: 1, models: {}, updatedAt: 0 }, purposes: [] }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ProvidersView />);
    expect((await screen.findByTestId("provider-status-codex")).textContent).toContain("Test failed");
    expect(screen.getByTestId("provider-signin-message-codex").textContent).toBe(message);
    expect(screen.queryByText("Ready")).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => /\/(connect|verify|default|test)$/.test(String(url)))).toBe(false);
  });

  it("describes paired Claude account reuse for bounded artifacts separately from legacy tokens", async () => {
    const claude = { ...card({ phase: "connected", signInKind: "claude-daemon", testOk: true, userCode: null, verificationUri: null }), id: "claude", label: "Claude Code", harness: "claude-acp" } satisfies AcpProviderCard;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url === "/api/providers" ? { org: "self-hosted", defaultProviderId: null, providers: [claude] } : { connections: [], connectionOrder: [], policy: { version: 1, models: {}, updatedAt: 0 }, purposes: [] } })));
    render(<ProvidersView />);
    const route = await screen.findByTestId("provider-route-claude");
    expect(route.textContent).toContain("claude-code");
    expect(route.textContent).toContain("Paired local computer · repositories and bounded artifacts");
    expect(route.textContent).toContain("identity and billing are not reported");
    expect(screen.getByText(/Local artifacts require explicit complete output paths/)).toBeTruthy();
  });

  it("describes the saved Claude setup-token task route", async () => {
    const claude = { ...card({ phase: "connected", signInKind: "claude-setup-token", userCode: null, verificationUri: null }), id: "claude", label: "Claude Code", harness: "claude-acp" } satisfies AcpProviderCard;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url === "/api/providers" ? { org: "self-hosted", defaultProviderId: null, providers: [claude] } : { connections: [], connectionOrder: [], policy: { version: 1, models: {}, updatedAt: 0 }, purposes: [] } })));
    render(<ProvidersView />);
    expect((await screen.findByTestId("provider-route-claude")).textContent).toContain("claude-subscription");
    expect(screen.getByText(/set Claude as your default for tasks/)).toBeTruthy();
  });

  it("keeps a Codex API credential separate from ChatGPT billing", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url === "/api/providers" ? snapshot({ phase: "connected", authMode: "api-key", userCode: null, verificationUri: null }) : { connections: [], connectionOrder: [], policy: { version: 1, models: {}, updatedAt: 0 }, purposes: [] } })));
    render(<ProvidersView />);
    const route = await screen.findByTestId("provider-route-codex");
    expect(route.textContent).toContain("codex or codex-acp (sandbox)");
    expect(route.textContent).toContain("Configured API credential");
    expect(route.textContent).not.toContain("ChatGPT plan");
  });

  it("connects and disconnects a personal API key from the shared Settings panel", async () => {
    const provider = { ...card({ phase: "disconnected", authMode: null }), id: "openrouter", label: "OpenRouter", capabilities: { ...card().capabilities, oauth: false } } satisfies AcpProviderCard;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/connect")) {
        const body = JSON.parse(String(init?.body));
        expect(body.mode).toBe("api-key");
        expect(Boolean(body.credential)).toBe(true);
        provider.connection = { ...provider.connection, phase: "connected", authMode: "api-key" };
      } else if (url.endsWith("/default")) {
        provider.isDefault = true;
      } else if (url.endsWith("/disconnect")) {
        provider.connection = { ...provider.connection, phase: "disconnected", authMode: null };
      }
      return Response.json({ org: "self", defaultProviderId: provider.isDefault ? provider.id : null, providers: [provider] });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<ProvidersView embedded />);
    const keyInput = await screen.findByLabelText("OpenRouter API key");
    fireEvent.change(keyInput, { target: { value: "test-credential" } });
    fireEvent.click(screen.getByRole("button", { name: "Use API credential" }));
    fireEvent.click(await screen.findByRole("button", { name: "Set as my default" }));
    expect(await screen.findByText("Default")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByLabelText("OpenRouter API key")).toBeTruthy();
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith("/api/providers"))).toBe(true);
  });

  it("renders breadcrumbs in the header", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url === "/api/providers" ? snapshot() : { connections: [], connectionOrder: [], policy: { version: 1, models: {}, updatedAt: 0 }, purposes: [] } })));
    render(<ProvidersView scope="workspace" />);
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(nav.textContent).toContain("Workspace");
    expect(nav.textContent).toContain("Extensions");
    expect(nav.textContent).toContain("Providers");
  });
});
