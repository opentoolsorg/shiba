// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { SettingsSectionBody } from "./settings-sections";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const setupStatus = {
  slack: { signingSecret: true, botToken: true, approvers: 2, channelRepos: true },
  github: { token: true, app: false, publish: true, webhookSecret: false },
  gateway: { id: "default", token: true, reachable: "yes" },
  access: { required: true },
  automations: { enabled: true, typeSafe: false },
  mailbox: { addressOverride: false, sendEnabled: true },
  transactionalEmail: { senderConfigured: true, queueBound: false },
};

describe("Sandbox section", () => {
  it("shows the selection order, the approval note and agent-specific defaults link", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      settings: { providerId: "cloudflare" },
      effective: { source: "org", providerId: "cloudflare" },
      providers: [{ id: "cloudflare", label: "Cloudflare", configured: true, matrix: { exec: true, files: true, portsPreview: false, snapshots: false, volumes: false, edgeEgress: true } }],
    })));
    const onNavigate = vi.fn();
    render(<SettingsSectionBody section="sandbox" onNavigate={onNavigate} />);
    expect(screen.getByText("Task → Agent → Organization → Deployment")).toBeTruthy();
    expect(screen.getByText(/A configured provider is not permission to execute/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Bots →" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Manage agent-specific defaults →" }));
    expect(onNavigate).toHaveBeenCalledWith("custom-agents");
  });
});

describe("Appearance section", () => {
  it("points to notifications next", () => {
    const onSelectSection = vi.fn();
    render(<SettingsSectionBody section="appearance" onSelectSection={onSelectSection} />);
    fireEvent.click(screen.getByRole("button", { name: "Next: notifications →" }));
    expect(onSelectSection).toHaveBeenCalledWith("notifications");
  });
});

const card = (title: string) => within(screen.getByRole("heading", { name: title }).parentElement as HTMLElement);

describe("Environments section", () => {
  it("groups readiness rows into cards with Open links", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(setupStatus)));
    const onNavigate = vi.fn();
    render(<SettingsSectionBody section="environments" onNavigate={onNavigate} />);
    await screen.findByRole("heading", { name: "Gateway and access" });
    const gateway = card("Gateway and access");
    expect(gateway.getByText("AI Gateway token")).toBeTruthy();
    expect(gateway.getByText("Cloudflare Access required")).toBeTruthy();
    const slack = card("Slack readiness");
    expect(slack.getByText("Slack approvers")).toBeTruthy();
    const automations = card("Automations");
    expect(automations.getByText("TypeSafe key")).toBeTruthy();
    const mailbox = card("Mailbox");
    expect(mailbox.getByText("Transactional email queue")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open automations →" }));
    expect(onNavigate).toHaveBeenLastCalledWith("automations");
    fireEvent.click(screen.getByRole("button", { name: "Open mailbox →" }));
    expect(onNavigate).toHaveBeenLastCalledWith("inbox");
    expect(screen.getByText(/Read-only readiness surface/)).toBeTruthy();
  });
});

describe("Slack import section", () => {
  it("mounts the installations panel only when workspace and actor are provided", () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
    const view = render(<SettingsSectionBody section="slack-import" />);
    expect(screen.queryByText(/Select a verified native workspace owner/)).toBeNull();
    view.unmount();
    render(<SettingsSectionBody section="slack-import" slackWorkspaceId="bad" slackActorId="a@b.co" />);
    expect(screen.getByText(/Select a verified native workspace owner/)).toBeTruthy();
  });
});
