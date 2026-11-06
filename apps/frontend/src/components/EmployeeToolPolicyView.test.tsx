// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EmployeeToolPolicyView } from "./EmployeeToolPolicyView";

const json = (body: unknown, status = 200) => Response.json(body, { status });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("EmployeeToolPolicyView", () => {
  it("grants registered app actions only for selected owned connections, preserving versioned policy", async () => {
    const writes: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/custom-agents") return json({ agents: [{ id: "employee-1", slug: "sales", version: 3, config: { name: "Sales" } }] });
      if (url === "/api/agents") return json({ principals: [] });
      if (url === "/api/whoami") return json({ agent: "owner@example.test" });
      if (url === "/api/employee-tools/approvals") return json({ approvals: [] });
      if (url.startsWith("/api/integrations/provider/connections")) return json({ ok: true, provider: "openconnector", connections: [{ id: "owned-hubspot", providerKey: "hubspot", provider: "openconnector", identityLabel: "Sales account", executionReady: true }, { id: "owned-github", providerKey: "github", provider: "openconnector", executionReady: true }] });
      if (url.endsWith("/policy") && init?.method === "PUT") { writes.push(JSON.parse(String(init.body))); return json({ ok: true }); }
      if (url.endsWith("/policy")) return json({ employeeVersion: 3, toolScopes: [], grants: [] });
      return json({ error: "unexpected" }, 500);
    }));
    render(<EmployeeToolPolicyView />);
    fireEvent.click(await screen.findByLabelText(/Discover actions in selected apps/));
    fireEvent.click(await screen.findByLabelText(/hubspot · Sales account/));
    expect(screen.queryByRole("textbox", { name: /connected app/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save grants" }));
    await screen.findByText(/Policy saved/);
    expect(writes).toEqual([{ expectedVersion: 3, actorId: "owner@example.test", role: "member", resourcesByCapability: { "mcp:shiba:integrations.search_actions": ["hubspot"] }, integrationConnectionIds: { hubspot: "owned-hubspot" } }]);
    expect(screen.getByText(/Unsupported schemas and transports fail closed/)).toBeTruthy();
  });

  it.each(["missing", "ambiguous", "unready"])("refuses a %s app connection while allowing revocation", async (state) => {
    const writes: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/custom-agents") return json({ agents: [{ id: "employee-1", slug: "sales", version: 1, config: { name: "Sales" } }] });
      if (url === "/api/agents") return json({ principals: [] });
      if (url === "/api/whoami") return json({ agent: "owner@example.test" });
      if (url === "/api/employee-tools/approvals") return json({ approvals: [] });
      if (url.startsWith("/api/integrations/provider/connections")) return json({ ok: true, provider: "openconnector", connections: state === "ambiguous" ? [{ id: "one", providerKey: "former-app", provider: "openconnector", executionReady: true }, { id: "two", providerKey: "former-app", provider: "openconnector", executionReady: true }] : state === "unready" ? [{ id: "old-consent", providerKey: "former-app", provider: "openconnector", executionReady: false, unavailableReason: "Consent generation unavailable" }] : [] });
      if (url.endsWith("/policy") && init?.method === "PUT") { writes.push(JSON.parse(String(init.body))); return json({ ok: true }); }
      if (url.endsWith("/policy")) return json({ employeeVersion: 1, toolScopes: ["mcp:shiba:integrations.execute"], grants: [{ subjectType: "actor", subjectId: "owner@example.test", capabilityId: "mcp:shiba:integrations.execute", resourceId: "former-app", lifecycle: "active" }] });
      return json({ error: "unexpected" }, 500);
    }));
    render(<EmployeeToolPolicyView />);
    expect(await screen.findByText(/Saved connection unavailable: former-app/)).toBeTruthy();
    if (state === "ambiguous") expect(screen.getByText(/Multiple accounts for one app cannot be selected/)).toBeTruthy();
    if (state === "unready") { expect((screen.getByLabelText("former-app · Employee actions unavailable") as HTMLInputElement).disabled).toBe(true); expect(screen.getByText("Consent generation unavailable")).toBeTruthy(); }
    fireEvent.click(screen.getByRole("button", { name: "Save grants" }));
    expect(await screen.findByText(/No catalog-only app can be granted/)).toBeTruthy();
    expect(writes).toHaveLength(0);
    fireEvent.click(screen.getByLabelText(/Execute approved actions in selected apps/));
    fireEvent.click(screen.getByRole("button", { name: "Revoke all grants" }));
    await screen.findByText(/All tool grants revoked/);
    expect(writes[0]?.resourcesByCapability).toEqual({});
  });
  it("saves reviewed MCP resource grants and routes external consent through the owner dispatch action", async () => {
    const capabilityId = `mcp:shiba:ext_${"a".repeat(12)}_${"b".repeat(16)}`;
    let version = 1;
    const writes: Array<{ url: string; body: Record<string, unknown> }> = [];
    let approvals = [{ approvalId: "external-approval", employeeId: "server-1", employeeVersion: 1, actorId: "owner@example.test", action: "write_record",
      payload: { record: "record-1", text: "Frozen write" }, status: "pending", createdAt: 1, expiresAt: 99_999_999_999,
      employeeContext: { employeeId: "employee-1", employeeVersion: 2, executionContextId: "web:owner:session", resourceIds: ["record-1"] } }];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET";
      if (url === "/api/custom-agents") return json({ agents: [{ id: "employee-1", slug: "crm", version, config: { name: "CRM reader" } }] });
      if (url === "/api/agents") return json({ principals: [] });
      if (url === "/api/whoami") return json({ agent: "owner@example.test", auth: "better-auth" });
      if (url === "/api/employee-tools/approvals") return json({ approvals });
      if (url.endsWith("/policy") && method === "GET") return json({ employeeVersion: version, toolScopes: [], grants: [], externalCapabilities: [{
        capabilityId, tool: capabilityId.slice("mcp:shiba:".length), label: "Fixture CRM · read_record", schemaVersion: "c".repeat(64), resourceArguments: ["record"], effect: "read",
      }] });
      if (url.endsWith("/policy") && method === "PUT") { writes.push({ url, body: JSON.parse(String(init?.body)) }); version++; return json({ ok: true }); }
      if (url === "/api/v1/mcp/servers/server-1/approvals/external-approval" && method === "POST") {
        writes.push({ url, body: JSON.parse(String(init?.body)) }); approvals = []; return json({ dispatch: { status: "succeeded" } });
      }
      return json({ error: `Unexpected ${method} ${url}` }, 500);
    }));
    render(<EmployeeToolPolicyView />);
    fireEvent.click(await screen.findByLabelText("Fixture CRM · read_record · read"));
    fireEvent.change(screen.getByLabelText("Exact resource values for Fixture CRM · read_record"), { target: { value: "record-1\nrecord-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save grants" }));
    await screen.findByText(/Policy saved/);
    expect(writes[0]?.body).toMatchObject({ actorId: "owner@example.test", role: "member", resourcesByCapability: { [capabilityId]: ["record-1", "record-2"] }, externalResourceArguments: { [capabilityId]: "record" }, externalSchemaVersions: { [capabilityId]: "c".repeat(64) } });
    fireEvent.click(screen.getByRole("button", { name: "Approve exact payload" }));
    await screen.findByText(/Exact MCP payload approved and dispatched/);
    expect(writes[1]).toEqual({ url: "/api/v1/mcp/servers/server-1/approvals/external-approval", body: { approved: true } });
    expect(screen.queryByText(/Frozen write/)).toBeNull();
  });

  it("selects Gmail resources from owner-discovered metadata and submits only checked message IDs", async () => {
    let version = 1;
    const writes: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET";
      if (url === "/api/custom-agents") return json({ agents: [{ id: "employee-1", slug: "researcher", version, config: { name: "Researcher" } }] });
      if (url === "/api/agents") return json({ principals: [{ principal: "owner@example.test", scopes: [], created: 1, live: true }] });
      if (url === "/api/whoami") return json({ agent: "owner@example.test", auth: "better-auth" });
      if (url === "/api/employee-tools/approvals") return json({ approvals: [] });
      if (url.startsWith("/api/connections/gmail/resources?")) return json({ results: [{ messageId: "msg_selected", threadId: "thread_context", from: "sender@example.test", subject: "Quarterly plan", date: "Wed, 1 Oct 2026 12:00:00 +0000" }] });
      if (url.endsWith("/policy") && method === "GET") return json({ employeeVersion: version, toolScopes: [], grants: [] });
      if (url.endsWith("/policy") && method === "PUT") { writes.push(JSON.parse(String(init?.body)) as Record<string, unknown>); version++; return json({ ok: true, employeeVersion: version }); }
      return json({ error: `Unexpected ${method} ${url}` }, 500);
    }));

    render(<EmployeeToolPolicyView />);
    fireEvent.click(await screen.findByLabelText(/Read selected Gmail messages/));
    fireEvent.change(screen.getByLabelText("Search connected Gmail"), { target: { value: "from:sender@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Search Gmail" }));
    fireEvent.click(await screen.findByLabelText(/Quarterly plan/));
    expect(screen.getByText(/Selected:/).textContent).toContain("msg_selected");
    fireEvent.click(screen.getByRole("button", { name: "Save grants" }));
    await screen.findByText(/Policy saved/);
    expect(writes[0]?.resourcesByCapability).toEqual({ "mcp:shiba:gmail_read": ["msg_selected"] });
    expect(screen.getByText(/Gmail grants select exact messages/)).toBeTruthy();
  });

  it("loads real API state, configures exact resources, and decides a pending exact-payload approval", async () => {
    let policyVersion = 1;
    let grants: Array<{ subjectType: string; subjectId: string; capabilityId: string; resourceId: string; lifecycle: string }> = [];
    let approvals = [{ approvalId: "approval-1", employeeId: "employee-1", employeeVersion: 1, actorId: "researcher", action: "queue_run", resourceId: "https://github.com/acme/app", payload: { repoUrl: "https://github.com/acme/app", task: "Review dependency updates" }, status: "pending", createdAt: 10, expiresAt: 99_999_999_999 }];
    const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      requests.push({ url, method, body });
      if (url === "/api/custom-agents") return json({ agents: [{ id: "employee-1", slug: "researcher", version: policyVersion, config: { name: "Researcher" } }] });
      if (url === "/api/agents") return json({ principals: [{ principal: "researcher", scopes: ["sandbox:exec"], created: 1, live: true }] });
      if (url === "/api/whoami") return json({ agent: "owner@example.test", auth: "better-auth" });
      if (url === "/api/employee-tools/approvals" && method === "GET") return json({ approvals });
      if (url === "/api/employee-tools/approvals/approval-1" && method === "POST") { approvals = []; return json({ ok: true, status: body?.approved ? "approved" : "denied" }); }
      if (url.endsWith("/policy") && method === "GET") return json({ employeeVersion: policyVersion, toolScopes: grants.map((grant) => grant.capabilityId), grants });
      if (url.endsWith("/policy") && method === "PUT") {
        expect(body).toMatchObject({ actorId: "owner@example.test", role: "member", expectedVersion: policyVersion });
        const resourceMap = body?.resourcesByCapability as Record<string, string[]>;
        grants = Object.entries(resourceMap).flatMap(([capabilityId, values]) => values.flatMap((resourceId) => [
          { subjectType: "workspace", subjectId: "workspace", capabilityId, resourceId, lifecycle: "active" },
          { subjectType: "actor", subjectId: "owner@example.test", capabilityId, resourceId, lifecycle: "active" },
          { subjectType: "role", subjectId: "member", capabilityId, resourceId, lifecycle: "active" },
        ]));
        policyVersion += 1;
        return json({ ok: true, employeeVersion: policyVersion });
      }
      return json({ error: `Unexpected ${method} ${url}` }, 500);
    }));

    render(<EmployeeToolPolicyView />);
    expect(await screen.findByText(/Review dependency updates/)).toBeTruthy();
    expect((screen.getByLabelText("Actor identity") as HTMLSelectElement).value).toBe("owner@example.test");
    fireEvent.click(screen.getByLabelText(/Queue a coding run/));
    fireEvent.change(screen.getByLabelText(/Allowed repository url values/), { target: { value: "https://github.com/acme/app" } });
    fireEvent.click(screen.getByRole("button", { name: "Save grants" }));
    await screen.findByText(/Policy saved/);
    expect(requests.find((request) => request.method === "PUT")?.body?.resourcesByCapability).toEqual({ "mcp:shiba:queue_run": ["https://github.com/acme/app"] });

    fireEvent.click(screen.getByRole("button", { name: "Approve exact payload" }));
    await waitFor(() => expect(screen.queryByText(/Review dependency updates/)).toBeNull());
    expect(requests.find((request) => request.url.endsWith("/approval-1"))?.body).toEqual({ employeeId: "employee-1", approved: true });
    expect(screen.getByText(/can retry the same call/)).toBeTruthy();
    expect(screen.getByText(/do not constrain shell\/CLI tools/)).toBeTruthy();
  });
});
