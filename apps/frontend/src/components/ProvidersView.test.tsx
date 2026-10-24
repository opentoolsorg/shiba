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
});
