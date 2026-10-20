import { access } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelConfigWire, SetupStatus, WhoamiWire } from "../../frontend/src/live-status";

const liveStatusMocks = vi.hoisted(() => ({
  useSetupStatus: vi.fn(),
  useWhoami: vi.fn(),
  useModelConfig: vi.fn(),
}));

vi.mock("../../frontend/src/live-status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../frontend/src/live-status")>();
  return {
    ...actual,
    useSetupStatus: liveStatusMocks.useSetupStatus,
    useWhoami: liveStatusMocks.useWhoami,
    useModelConfig: liveStatusMocks.useModelConfig,
  };
});

import { FirstRunWizard } from "../../frontend/src/components/FirstRunWizard";
import { ProvidersView } from "../../frontend/src/components/ProvidersView";
import { SettingsSectionBody } from "../../frontend/src/components/settings-sections";

const setupStatus: SetupStatus = {
  slack: { signingSecret: false, botToken: false, approvers: 0, channelRepos: false },
  github: { token: false, app: false, publish: false, webhookSecret: false },
  linear: { webhookSecret: false, apiToken: false, defaultRepo: false },
  slackVerification: { signingSecret: false },
  gateway: { id: "gateway", token: false, reachable: "unauthorized" },
  access: { required: false },
  betterAuth: { configured: false },
  models: { orchestrator: "", coding: "", harness: "", roles: [] },
  automations: { enabled: false, typeSafe: false },
  mailbox: { addressOverride: false, sendEnabled: false },
  doctor: { ok: true, checkedAt: 0, findings: [], roles: [] },
};

const modelConfig: ModelConfigWire = {
  connections: [],
  connectionOrder: [],
  policy: { version: 1, models: {}, updatedAt: 0 },
  purposes: [],
};

function settled<T>(data: T) {
  return { state: { kind: "data" as const, data }, reload: () => {}, inFlight: false };
}

function renderSection(section: "account" | "environments" | "models"): string {
  return renderToStaticMarkup(React.createElement(SettingsSectionBody, { section }));
}

describe("provider and settings connection surfaces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    liveStatusMocks.useSetupStatus.mockReturnValue(settled(setupStatus));
    liveStatusMocks.useWhoami.mockReturnValue(
      settled<WhoamiWire>({ agent: "test-agent", auth: "none" }),
    );
    liveStatusMocks.useModelConfig.mockReturnValue(settled(modelConfig));
  });

  it("removes GitHub credentials from Settings Account", () => {
    const html = renderSection("account");
    expect(html).not.toContain("GITHUB_TOKEN");
    expect(html).not.toContain("GITHUB_WEBHOOK_SECRET");
  });

  it("removes GitHub credentials from Settings Environments", () => {
    const html = renderSection("environments");
    expect(html).not.toContain("GITHUB_TOKEN");
    expect(html).not.toContain("GITHUB_WEBHOOK_SECRET");
  });

  it("keeps model connections on Providers, under the ACP adapter list", () => {
    const html = renderToStaticMarkup(React.createElement(ProvidersView));
    const adapters = html.indexOf("Sandbox adapters");
    const modelConnections = html.indexOf("Model connections");
    expect(adapters).toBeGreaterThan(-1);
    expect(modelConnections).toBeGreaterThan(adapters);
    expect(html).toContain("Named credentials a run can route through.");
    expect(html).toContain("Loading providers");
    expect(html).toContain('<option value="grok">grok</option>');
    expect(html).not.toContain('value="cursor"');
  });

  it("keeps model connections out of Settings Models", () => {
    const html = renderSection("models");
    expect(html).toContain("Purpose routing — which model does which job");
    expect(html).not.toContain("Model connections");
  });

  it("sends onboarding to Providers instead of the subscription connect API", () => {
    const html = renderToStaticMarkup(
      React.createElement(FirstRunWizard, {
        open: true,
        onClose: () => {},
        onNavigate: () => {},
      }),
    );
    expect(html).toContain("Loading providers");
    expect(html).toContain("Open Providers");
    expect(html).not.toContain("/api/auth/claude-subscription");
    expect(html).not.toContain("/api/auth/codex-subscription");
    expect(html).not.toContain("/api/auth/cursor-subscription");
  });

  it("no longer ships the legacy SubscriptionConnect control", async () => {
    await expect(
      access(new URL("../../frontend/src/components/SubscriptionConnect.tsx", import.meta.url)),
    ).rejects.toThrow();
  });
});
