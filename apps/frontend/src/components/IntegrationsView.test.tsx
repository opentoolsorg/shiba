// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { INTEGRATION_CATALOG } from "@shiba/shared";
import { IntegrationsView } from "./IntegrationsView";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function defaultSetup() {
  return {
    slack: { signingSecret: true, botToken: true, approvers: 2, channelRepos: true },
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
  };
}

function reasonNetworkJson() {
  return {
    status: {
      state: "setup_required",
      enabled: false,
      dispatchConfigured: false,
      networkMembership: "not_checked",
      activeGrants: 0,
      pendingApprovals: 0,
    },
    grants: [] as unknown[],
    approvals: [] as unknown[],
    operations: [] as unknown[],
  };
}

function providerMetaUnconfigured() {
  return {
    ok: true,
    provider: "openconnector",
    health: {
      provider: "openconnector",
      status: "unconfigured",
      checkedAt: Date.now(),
      message: "Set OPEN_CONNECTOR_ADMIN_TOKEN",
    },
  };
}

function stubIntegrationsFetch(setup = defaultSetup()) {
  const reason = reasonNetworkJson();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/setup/status") return Response.json(setup);
    if (url === "/api/mailboxes") return Response.json({ mailboxes: [{ address: "ops@example.test" }] });
    if (url === "/api/connections/gmail") return Response.json({ configured: false, connection: null, grants: [] });
    if (url === "/api/v1/mcp/servers") return Response.json({ servers: [{ id: "server-1" }] });
    if (url === "/api/v1/mcp/catalog-connections") return Response.json({ ok: true, connections: [] });
    if (url === "/api/integrations/provider/meta") return Response.json(providerMetaUnconfigured());
    if (url.startsWith("/api/integrations/provider/catalog")) {
      return Response.json({ ok: true, provider: "openconnector", items: [], nextCursor: null, hasMore: false, fallbackCatalog: true });
    }
    if (url === "/api/integrations/provider/connections") {
      return Response.json({ ok: true, provider: "openconnector", connections: [] });
    }
    if (url.endsWith("/api/reason-network/status")) return Response.json(reason.status);
    if (url.endsWith("/api/reason-network/grants") && (init?.method ?? "GET") === "GET") {
      return Response.json({ grants: reason.grants });
    }
    if (url.includes("/api/reason-network/approvals") && (init?.method ?? "GET") === "GET") {
      return Response.json({ approvals: reason.approvals });
    }
    if (url.endsWith("/api/reason-network/v1/operations") && (init?.method ?? "GET") === "GET") {
      return Response.json({ operations: reason.operations });
    }
    if (url === "/api/providers") return Response.json({ org: "local", defaultProviderId: "codex", providers: [] });
    if (url.startsWith("/api/capabilities")) return Response.json({ entries: [] });
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  return fetchMock;
}

describe("IntegrationsView Viktor catalog", () => {
  it("renders Connected and Available sections with search and domain filter", async () => {
    stubIntegrationsFetch();
    render(<IntegrationsView />);
    expect(await screen.findByRole("heading", { name: "Connected" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Available" })).toBeTruthy();
    expect(screen.getByText(new RegExp(`of ${INTEGRATION_CATALOG.length} catalog rows`))).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search integrations"), { target: { value: "hubspot" } });
    expect(await screen.findByTestId("integration-catalog-row-hubspot")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search integrations"), { target: { value: "stripe" } });
    expect(screen.getByTestId("integration-catalog-row-stripe")).toBeTruthy();
    expect(screen.queryByTestId("integration-catalog-row-slack")).toBeNull();

    fireEvent.change(screen.getByLabelText("Search integrations"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Filter by domain"), { target: { value: "ops" } });
    expect(screen.getByTestId("integration-catalog-row-slack")).toBeTruthy();
    expect(screen.queryByTestId("integration-catalog-row-stripe")).toBeNull();
  });

  it("shows live GitHub under Connected and HubSpot under Available", async () => {
    stubIntegrationsFetch();
    render(<IntegrationsView />);
    await screen.findByTestId("integration-catalog-row-github");
    const githubRow = screen.getByTestId("integration-catalog-row-github");
    expect(githubRow.textContent).toMatch(/Connected/);
    fireEvent.change(screen.getByLabelText("Search integrations"), { target: { value: "hubspot" } });
    const hubspotRow = await screen.findByTestId("integration-catalog-row-hubspot");
    expect(hubspotRow.textContent).toMatch(/Available|Catalog/i);
    expect(screen.getByText(/OPEN_CONNECTOR_ADMIN_TOKEN/i)).toBeTruthy();
  });

  it("preserves setup detail panels behind Show setup details", async () => {
    stubIntegrationsFetch();
    render(<IntegrationsView />);
    await screen.findByRole("heading", { name: "Connected" });
    fireEvent.click(screen.getByRole("button", { name: "Show setup details" }));
    expect(await screen.findByTestId("integration-linear")).toBeTruthy();
    expect(screen.getAllByText("GitHub").length).toBeGreaterThan(0);
  });
});

describe("IntegrationsView capability catalog", () => {
  it("uses API-backed connection facts and saved skills without running provider actions", async () => {
    const setup = defaultSetup();
    const provider = {
      id: "codex", label: "Codex", blurb: "Codex provider", adapter: "codex-acp", packageName: "codex-acp",
      license: "Apache-2.0", harness: "codex-acp", protocol: "acp", spawn: ["codex"], defaultModel: "model",
      docsUrl: "https://example.invalid", capabilities: { streamsText: true, toolCalls: true, permissions: true, setModel: true, oauth: true, apiKey: true, acp: true },
      credentialEnv: [], isDefault: false, connection: { phase: "connected", authMode: "oauth", message: "connected", userCode: null, verificationUri: null, expiresAt: null, testedAt: Date.now(), testOk: true },
    };
    const calls: { url: string; method: string }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url === "/api/setup/status") return Response.json(setup);
      if (url === "/api/mailboxes") return Response.json({ mailboxes: [{ address: "ops@example.test" }] });
      if (url === "/api/connections/gmail") return Response.json({ configured: false, connection: null, grants: [] });
      if (url === "/api/v1/mcp/servers") return Response.json({ servers: [] });
      if (url.endsWith("/api/reason-network/status")) {
        return Response.json({
          state: "setup_required",
          enabled: false,
          dispatchConfigured: false,
          networkMembership: "not_checked",
          activeGrants: 0,
          pendingApprovals: 0,
        });
      }
      if (url.endsWith("/api/reason-network/grants")) return Response.json({ grants: [] });
      if (url.includes("/api/reason-network/approvals")) return Response.json({ approvals: [] });
      if (url.endsWith("/api/reason-network/v1/operations")) return Response.json({ operations: [] });
      if (url === "/api/providers") return Response.json({ org: "local", defaultProviderId: "codex", providers: [provider] });
      if (url === "/api/capabilities?limit=50") return Response.json({ entries: [{
        id: "mcp:shiba:gmail_search", name: "gmail_search", source: "mcp:shiba", version: "1",
        requiredScope: "gmail:read", allowed: false, status: "available", verification: "not_checked",
        writeEffect: "read_only", approval: "not_inferred_from_mcp_metadata",
        description: "Search explicitly granted Gmail read-only connection.", annotations: { readOnlyHint: true },
      }], totalRegistered: 1, returned: 1, truncated: false, liveChecksPerformed: false });
      if (url === "/api/capabilities/invocations?limit=25") return Response.json({ entries: [{
        invocationId: "inv-1", createdAt: 10, updatedAt: 20, principal: "local-agent",
        tool: "gmail_search", argsHash: "a".repeat(64), status: "unknown_outcome", errorCode: "handler_threw",
      }] });
      return Response.json({ connections: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => key === "shiba-skills-v1" ? JSON.stringify([{ id: "brief", name: "Brief writing", notes: "Keep it concise." }]) : null,
      setItem: vi.fn(),
    });

    const onNavigate = vi.fn();
    render(<IntegrationsView onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("button", { name: "Browse capability catalog" }));
    expect(await screen.findByText("Test passed")).toBeTruthy();
    expect(screen.getByText("ops@example.test")).toBeTruthy();
    expect(screen.getByText("Brief writing")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
    expect(screen.getByText(/stored sign-in was checked by Shiba/)).toBeTruthy();
    const toolRow = await screen.findByRole("button", { name: /gmail_search/ });
    fireEvent.click(toolRow);
    expect(screen.getAllByText("gmail:read").length).toBeGreaterThan(0);
    expect(screen.getByText(/This is a catalog entry, not an assigned permission/)).toBeTruthy();
    expect(screen.getByText("unknown outcome")).toBeTruthy();
    expect(screen.getByText("inv-1")).toBeTruthy();
    expect(screen.queryByText(/private email body/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Configure" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Agents & MCP" }));
    expect(onNavigate).toHaveBeenCalledWith("agents");
    fireEvent.click(screen.getByRole("button", { name: "Approvals & call history" }));
    expect(onNavigate).toHaveBeenCalledWith("approvals");
    await waitFor(() => expect(calls.some((call) => call.url === "/api/providers")).toBe(true));
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(onNavigate).toHaveBeenCalledWith("providers");
  });

  it("uses no-store refreshes and marks retained provider data as stale after a refresh failure", async () => {
    const provider = {
      id: "codex", label: "Codex", blurb: "Provider", adapter: "codex-acp", packageName: "codex-acp",
      license: "Apache-2.0", harness: "codex-acp", protocol: "acp", spawn: ["codex"], defaultModel: "model",
      docsUrl: "https://example.invalid", capabilities: { streamsText: true, toolCalls: true, permissions: true, setModel: true, oauth: true, apiKey: true, acp: true },
      credentialEnv: [], isDefault: false, connection: { phase: "connected", authMode: "oauth", message: "connected", userCode: null, verificationUri: null, expiresAt: null, testedAt: 1, testOk: true },
    };
    let providerReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/providers")) {
        providerReads += 1;
        return providerReads === 1
          ? Response.json({ org: "local", defaultProviderId: "codex", providers: [provider] })
          : Response.json({ error: "temporarily unavailable" }, { status: 503 });
      }
      if (url === "/api/setup/status") return Response.json({
        slack: { signingSecret: false, botToken: false, approvers: 0, channelRepos: false },
        github: { token: false, app: false, publish: false, webhookSecret: false },
        linear: { webhookSecret: false, apiToken: false, defaultRepo: false },
      });
      if (url === "/api/mailboxes") return Response.json({ mailboxes: [] });
      if (url === "/api/connections/gmail") return Response.json({ configured: false, connection: null, grants: [] });
      if (url === "/api/v1/mcp/servers") return Response.json({ servers: [] });
      if (url.endsWith("/api/reason-network/status")) {
        return Response.json({
          state: "setup_required",
          enabled: false,
          dispatchConfigured: false,
          networkMembership: "not_checked",
          activeGrants: 0,
          pendingApprovals: 0,
        });
      }
      if (url.endsWith("/api/reason-network/grants")) return Response.json({ grants: [] });
      if (url.includes("/api/reason-network/approvals")) return Response.json({ approvals: [] });
      if (url.endsWith("/api/reason-network/v1/operations")) return Response.json({ operations: [] });
      if (url === "/api/capabilities?limit=50") return Response.json({ entries: [] });
      if (url === "/api/capabilities/invocations?limit=25") return Response.json({ entries: [] });
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });

    render(<IntegrationsView />);
    fireEvent.click(screen.getByRole("button", { name: "Browse capability catalog" }));
    expect(await screen.findByText("Test stale")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh integration status" }));
    expect(await screen.findByText(/Provider state may be stale/)).toBeTruthy();
    expect(screen.getAllByText("Test stale").length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/providers")).every(([, init]) => init?.cache === "no-store")).toBe(true);
  });

  it("switches between Skills, MCP servers, and Connectors tabs", async () => {
    stubIntegrationsFetch();
    render(<IntegrationsView />);
    expect(await screen.findByRole("tab", { name: "Connectors" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Skills" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "MCP servers" })).toBeTruthy();

    // Switch to Skills tab
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
    expect(await screen.findByRole("heading", { name: "Skill library" })).toBeTruthy();

    // Switch to MCP servers tab
    fireEvent.click(screen.getByRole("tab", { name: "MCP servers" }));
    expect(await screen.findByLabelText("Search servers")).toBeTruthy();

    // Switch back to Connectors tab
    fireEvent.click(screen.getByRole("tab", { name: "Connectors" }));
    expect(await screen.findByRole("heading", { name: "Connected" })).toBeTruthy();
  });
});
