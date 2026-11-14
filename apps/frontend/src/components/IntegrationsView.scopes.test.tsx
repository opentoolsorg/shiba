// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { IntegrationsView } from "./IntegrationsView";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubIntegrationsFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/v1/extensions/skills")) return Response.json([]);
    if (url.startsWith("/api/skills")) return Response.json({ ok: true, skills: [] });
    if (url.startsWith("/api/v1/extensions/connectors")) return Response.json({ connectors: [] });
    if (url === "/api/setup/status") {
      return Response.json({
        slack: { signingSecret: true, botToken: true, approvers: 1, channelRepos: true },
        github: { token: true, app: false, publish: true, webhookSecret: true },
        linear: { webhookSecret: false, apiToken: false, defaultRepo: false },
        slackVerification: { signingSecret: true },
        gateway: { id: "gw", token: true, reachable: "yes" },
        access: { required: false },
        betterAuth: { configured: true },
        models: { orchestrator: "test", coding: "test", harness: "test", roles: [] },
        automations: { enabled: false, typeSafe: true },
        mailbox: { addressOverride: false, sendEnabled: false },
        doctor: { ok: true, checkedAt: 1, findings: [], roles: [] },
      });
    }
    if (url === "/api/integrations/provider/meta") {
      return Response.json({
        ok: true,
        provider: "openconnector",
        health: { provider: "openconnector", status: "unconfigured", checkedAt: Date.now() },
      });
    }
    if (url.startsWith("/api/integrations/provider/")) {
      return Response.json({ ok: true, provider: "openconnector", connections: [], items: [] });
    }
    if (url === "/api/mailboxes") return Response.json({ mailboxes: [] });
    if (url === "/api/v1/mcp/servers") return Response.json({ servers: [] });
    if (url === "/api/v1/mcp/catalog-connections") return Response.json({ ok: true, connections: [] });
    if (url.endsWith("/api/reason-network/status")) return Response.json({ state: "setup_required", enabled: false });
    return Response.json({});
  }));
}

describe("IntegrationsView scopes", () => {
  it("renders Personal, Workspace, and Archived tabs for skills", async () => {
    stubIntegrationsFetch();
    render(<IntegrationsView actorId="owner@example.test" />);
    const skillsTab = await screen.findByRole("tab", { name: "Skills" });
    skillsTab.click();
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Personal" })).toBeTruthy();
      expect(screen.getByRole("tab", { name: "Workspace" })).toBeTruthy();
      expect(screen.getByRole("tab", { name: "Archived" })).toBeTruthy();
    });
  });
});