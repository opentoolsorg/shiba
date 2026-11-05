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

  it("describes paired Claude artifacts separately from cloud subscription and legacy tokens", async () => {
    const claude = { ...card({ phase: "connected", signInKind: "claude-daemon", testOk: true, userCode: null, verificationUri: null }), id: "claude", label: "Claude Code", harness: "claude-acp" } satisfies AcpProviderCard;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url === "/api/providers" ? { org: "self-hosted", defaultProviderId: null, providers: [claude] } : { connections: [], connectionOrder: [], policy: { version: 1, models: {}, updatedAt: 0 }, purposes: [] } })));
    render(<ProvidersView />);
    const route = await screen.findByTestId("provider-route-claude");
    expect(route.textContent).toContain("claude-code");
    expect(route.textContent).toContain("Paired local computer · repositories and explicit artifacts");
    expect(route.textContent).toContain("identity and billing are not reported");
    expect(screen.getByText(/Artifacts require explicit UTF-8 output paths/)).toBeTruthy();
  });

  it("labels a saved legacy token as deployment-gated rather than native cloud login", async () => {
    const claude = { ...card({ phase: "connected", signInKind: "claude-setup-token", userCode: null, verificationUri: null }), id: "claude", label: "Claude Code", harness: "claude-acp" } satisfies AcpProviderCard;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url === "/api/providers" ? { org: "self-hosted", defaultProviderId: null, providers: [claude] } : { connections: [], connectionOrder: [], policy: { version: 1, models: {}, updatedAt: 0 }, purposes: [] } })));
    render(<ProvidersView />);
    expect((await screen.findByTestId("provider-route-claude")).textContent).toContain("claude-subscription (legacy opt-in)");
    expect(screen.getByText(/Storing a token does not enable this runtime/)).toBeTruthy();
  });

  it("keeps a Codex API credential separate from ChatGPT billing", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url === "/api/providers" ? snapshot({ phase: "connected", authMode: "api-key", userCode: null, verificationUri: null }) : { connections: [], connectionOrder: [], policy: { version: 1, models: {}, updatedAt: 0 }, purposes: [] } })));
    render(<ProvidersView />);
    const route = await screen.findByTestId("provider-route-codex");
    expect(route.textContent).toContain("codex or codex-acp (sandbox)");
    expect(route.textContent).toContain("Configured API credential");
    expect(route.textContent).not.toContain("ChatGPT plan");
  });
});
