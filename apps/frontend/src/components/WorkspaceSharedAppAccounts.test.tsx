// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntegrationBindingInputs } from "../integration-connection-bindings";
import { WorkspaceConnectorsPanel } from "./WorkspaceConnectorsPanel";
import { IntegrationsView } from "./IntegrationsView";
import { WorkspaceAppActions } from "./WorkspaceAppActions";

vi.mock("../live-status", async (original) => ({ ...await original<typeof import("../live-status")>(),
  useSetupStatus: () => { throw new Error("Private setup hook must not run in workspace mode."); },
  useMailboxes: () => { throw new Error("Private mailbox hook must not run in workspace mode."); },
}));

const workspaceA = `ws_${"a".repeat(24)}`, workspaceB = `ws_${"b".repeat(24)}`;
const owner = "owner@example.test", member = "member@example.test";
const bindings: IntegrationBindingInputs = { setupLoading: true, mailboxCount: undefined, mailboxLoading: true, gmailConnected: null, gmailLoading: true, externalMcpServerCount: undefined, externalMcpCatalogConnections: undefined, externalMcpLoading: true };
const account = (workspaceId = workspaceA, overrides: Record<string, unknown> = {}) => ({ id: "shared-hubspot", scope: "workspace", workspaceId, providerKey: "hubspot", version: 2, generation: 1, state: "active", identityLabel: "Shared CRM fixture", authorizationFingerprint: "a".repeat(64), upstreamReady: true, health: "unknown", grantCount: 0, ...overrides });
const listing = { id: "hubspot", providerKey: "hubspot", name: "HubSpot", description: "CRM setup metadata", source: "openconnector", isConnected: false, connectable: true, setupState: "ready" };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
function popup() { return { opener: {}, location: { replace: vi.fn() }, close: vi.fn(), closed: false } as unknown as Window; }
function fixture() {
  let actor = owner, removed = false;
  let connections: ReturnType<typeof account>[] = [], grants: Array<Record<string, unknown>> = [], approvals: Array<Record<string, unknown>> = [];
  const calls: Array<{ path: string; method: string; body: Record<string, unknown> | undefined; workspace: string | null }> = [];
  const grantDirectory = () => ({ ok: true, workspaceId: workspaceA, connectionId: "shared-hubspot", connectionVersion: 2,
    employees: [{ id: "employee-finance", name: "Finance", version: 3 }], actors: [{ userId: owner, role: "owner", version: 1 }, { userId: member, role: "member", version: 4 }], grants });
  const approvalDirectory = (approvalId?: string) => ({ ok: true, workspaceId: workspaceA, approvalId,
    approvals: approvals.filter((item) => actor === owner || item.requesterId === actor).map((item) => ({ ...item,
      canDecide: actor === owner && item.status === "pending", canExecute: actor === item.requesterId && item.status === "approved" })) });
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "https://shiba.test"), method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    const workspace = new Headers(init?.headers).get("X-Shiba-Workspace"); calls.push({ path: url.pathname, method, body, workspace });
    if (removed) return Response.json({ error: "removed" }, { status: 403 });
    if (url.pathname === "/api/custom-agents") return Response.json({ agents: [{ id: "employee-finance", version: 3, config: { name: "Finance" } }] });
    if (url.pathname.endsWith("/catalog")) return Response.json({ ok: true, provider: "openconnector", workspaceId, items: [listing], hasMore: false, nextCursor: null });
    if (url.pathname.endsWith("/connect")) {
      const connection = account(workspaceA, { version: 1, state: "pending", upstreamReady: false }); connections = [connection];
      return Response.json({ ok: true, workspaceId, connection, pendingId: "pending-consent", authorizationFingerprint: "a".repeat(64), redirectUrl: "https://oauth.example.test/consent" });
    }
    if (url.pathname.endsWith("/reconcile")) { connections = [account()]; return Response.json({ ok: true, workspaceId, connection: connections[0] }); }
    if (url.pathname.endsWith("/disconnect")) { connections = [account(workspaceA, { state: "revoked", upstreamReady: false, version: 3 })]; return Response.json({ ok: true, workspaceId, connection: connections[0] }); }
    if (url.pathname.endsWith("/connections")) return Response.json({ ok: true, workspaceId: workspace, canManage: actor === owner, connections: actor === owner ? connections : connections.filter(() => grants.some((grant) => grant.actorId === actor && grant.state === "active")) });
    if (url.pathname.endsWith("/grants")) {
      if (actor !== owner) return Response.json({ error: "manager_required" }, { status: 403 });
      if (method === "PUT") { grants = [{ id: "grant-one", version: 1, employeeId: body?.employeeId, employeeVersion: body?.employeeVersion, actorId: body?.actorId, actorMembershipVersion: body?.actorMembershipVersion, permissions: body?.permissions, state: (body?.permissions as unknown[])?.length ? "active" : "revoked" }]; connections = connections.map((item) => ({ ...item, grantCount: grants[0]?.state === "active" ? 1 : 0 })); }
      return Response.json(grantDirectory());
    }
    if (url.pathname.endsWith("/actions")) {
      expect(url.searchParams.get("employeeVersion")).toBe("3");
      return Response.json({ ok: true, workspaceId, connectionId: "shared-hubspot", actions: [{ id: "fixture.create_note", service: "hubspot", name: "Create fixture note", inputSchema: { type: "object", properties: { title: { type: "string" } } } }] });
    }
    if (url.pathname.endsWith("/actions/request")) {
      approvals = [{ id: "approval-one", requesterId: actor, employeeId: body?.employeeId, employeeVersion: body?.employeeVersion, employeeName: "Finance", connectionId: "shared-hubspot", connectionVersion: 2, actionId: body?.actionId, arguments: body?.arguments, inputHash: "f".repeat(64), status: "pending", expiresAt: Date.now() + 60_000, result: null, error: null }];
      return Response.json(approvalDirectory("approval-one"));
    }
    if (url.pathname.endsWith("/decision")) { approvals = approvals.map((item) => ({ ...item, status: body?.approved ? "approved" : "denied" })); return Response.json(approvalDirectory("approval-one")); }
    if (url.pathname.endsWith("/execute")) { approvals = approvals.map((item) => ({ ...item, status: "completed", result: { fixtureOnly: true } })); return Response.json(approvalDirectory("approval-one")); }
    if (url.pathname.endsWith("/approvals")) return Response.json(approvalDirectory());
    return Response.json({ error: "unhandled_fixture_path" }, { status: 404 });
  });
  const workspaceId = workspaceA;
  vi.stubGlobal("fetch", fetcher);
  return { calls, fetcher, actor: (value: string) => { actor = value; }, remove: () => { removed = true; }, seed: () => { connections = [account()]; } };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("workspace-shared app fixture flows", () => {
  it("clears cached workspace accounts and action data when catalog access is revoked", async () => {
    const f = fixture(); f.seed();
    render(<WorkspaceConnectorsPanel bindingInputs={bindings} workspaceId={workspaceA} actorId={owner} workspaceRole="owner" />);
    await screen.findByText("Shared CRM fixture");
    f.remove();
    fireEvent.click(screen.getByRole("button", { name: "Browse workspace app catalog" }));
    await screen.findByRole("alert");
    expect(screen.queryByText("Shared CRM fixture")).toBeNull();
    expect(screen.queryByRole("region", { name: "Manual workspace app actions" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Browse integration catalog" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Browse workspace app catalog" })).toBeNull();
  });
  it("does not mount private hooks for an invited session without a selected workspace", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    render(<IntegrationsView allowPersonalScope={false} actorId={member} />);
    expect(screen.getByRole("region", { name: "Workspace app setup unavailable" })).toBeTruthy();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("blocks every approved action on an account after response loss until a verified terminal receipt", async () => {
    let completed = false;
    const approval = { id: "approval-one", requesterId: member, employeeId: "employee-finance", employeeVersion: 3, employeeName: "Finance", connectionId: "shared-hubspot", connectionVersion: 2, actionId: "fixture.create_note", arguments: {}, inputHash: "f".repeat(64), status: "approved", expiresAt: Date.now() + 60_000, canDecide: false, canExecute: true, result: null, error: null };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/custom-agents") return Response.json({ agents: [] });
      if (String(input).endsWith("/execute")) { completed = true; throw new TypeError("Fixture response lost after commit"); }
      return Response.json({ ok: true, workspaceId: workspaceA, approvals: [{ ...approval, ...(completed ? { status: "completed", canExecute: false } : {}) }, { ...approval, id: "approval-two" }] });
    }); vi.stubGlobal("fetch", fetcher);
    render(<WorkspaceAppActions workspaceId={workspaceA} actorId={member} canManage={false} connections={[account() as unknown as import("@shiba/shared").WorkspaceIntegrationConnection]} isCurrent={() => true} onAccessLost={vi.fn()} />);
    const executeButtons = await screen.findAllByRole("button", { name: "Execute approved action" });
    expect(executeButtons).toHaveLength(2);
    fireEvent.click(executeButtons[0]!);
    await screen.findByRole("alert");
    for (const button of screen.getAllByRole("button", { name: "Execute approved action" })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(fetcher.mock.calls.filter((call) => String(call[0]).endsWith("/execute"))).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh action requests" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Execute approved action" })).toHaveLength(1));
    expect((screen.getByRole("button", { name: "Execute approved action" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/Execution response unconfirmed/)).toBeNull();
  });
  it("requires sharing consent, exact employee grants and separate manager approval before the requester executes", async () => {
    const f = fixture(), windowFixture = popup(); vi.spyOn(window, "open").mockReturnValue(windowFixture);
    const props = { bindingInputs: bindings, workspaceId: workspaceA, workspaceName: "Team A", actorId: owner, workspaceRole: "owner" as const };
    const view = render(<WorkspaceConnectorsPanel {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Browse workspace app catalog" }));
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    const consent = await screen.findByRole("region", { name: "Confirm workspace sharing" });
    expect(f.calls.some((call) => call.path.endsWith("/connect"))).toBe(false);
    expect((within(consent).getByRole("button", { name: "Continue to app sign-in" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(consent).getByRole("checkbox"));
    fireEvent.click(within(consent).getByRole("button", { name: "Continue to app sign-in" }));
    await waitFor(() => expect(windowFixture.location.replace).toHaveBeenCalledWith("https://oauth.example.test/consent"));
    fireEvent.focus(window);
    await screen.findByText("Shared CRM fixture");
    expect(f.calls.find((call) => call.path.endsWith("/connect"))?.body).toEqual({ providerKey: "hubspot", audienceConsent: "workspace-members" });
    expect(f.calls.find((call) => call.path.endsWith("/reconcile"))?.body).toMatchObject({ expectedVersion: 1, pendingId: "pending-consent", authorizationFingerprint: "a".repeat(64) });
    fireEvent.click(screen.getByRole("button", { name: "Review hubspot permissions" }));
    fireEvent.change(await screen.findByLabelText("Employee"), { target: { value: "employee-finance" } });
    fireEvent.change(screen.getByLabelText("Workspace member"), { target: { value: member } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Discover available app actions" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Request approved actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Save exact grant" }));
    await screen.findByText("1 explicit grant");
    const grant = f.calls.find((call) => call.path.endsWith("/grants") && call.method === "PUT")!;
    expect(grant.body).toEqual({ employeeId: "employee-finance", employeeVersion: 3, actorId: member, actorMembershipVersion: 4, expectedConnectionVersion: 2, expectedGrantVersion: null, permissions: ["discover", "execute"] });
    f.actor(member); view.rerender(<WorkspaceConnectorsPanel {...props} actorId={member} workspaceRole="member" />);
    await screen.findByText("Shared CRM fixture");
    expect(screen.queryByRole("button", { name: "Disconnect hubspot" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Shared app account"), { target: { value: "shared-hubspot" } });
    fireEvent.change(await screen.findByLabelText("Employee for this action"), { target: { value: "employee-finance" } });
    fireEvent.click(screen.getByRole("button", { name: "Find allowed actions" }));
    fireEvent.change(await screen.findByLabelText("Action"), { target: { value: "fixture.create_note" } });
    fireEvent.change(screen.getByLabelText("Exact action arguments"), { target: { value: '{"title":"Reviewed fixture"}' } });
    fireEvent.click(screen.getByRole("button", { name: "Request human review" }));
    await screen.findByText("Action requested for human review. No external action was executed.");
    expect(screen.queryByRole("button", { name: "Approve exact action" })).toBeNull();
    expect(f.calls.some((call) => call.path.endsWith("/execute"))).toBe(false);
    f.actor(owner); view.rerender(<WorkspaceConnectorsPanel {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve exact action" }));
    await screen.findByText(/Human approval recorded/);
    expect(screen.queryByRole("button", { name: "Execute approved action" })).toBeNull();
    f.actor(member); view.rerender(<WorkspaceConnectorsPanel {...props} actorId={member} workspaceRole="member" />);
    fireEvent.click(await screen.findByRole("button", { name: "Execute approved action" }));
    await screen.findByText(/Execution state refreshed/);
    expect(f.calls.filter((call) => call.path.endsWith("/execute"))).toHaveLength(1);
    expect(f.calls.every((call) => call.workspace === workspaceA)).toBe(true);
    expect(f.calls.every((call) => call.path.startsWith("/api/workspace-integrations/") || call.path === "/api/custom-agents")).toBe(true);
  });

  it("mounts the team integrations branch without personal hooks and clears rows when access is revoked", async () => {
    const f = fixture(); f.seed();
    render(<IntegrationsView workspaceId={workspaceA} workspaceRole="owner" actorId={owner} />);
    await screen.findByText("Shared CRM fixture");
    expect(f.calls.every((call) => call.path.startsWith("/api/workspace-integrations/") || call.path === "/api/custom-agents")).toBe(true);
    f.remove(); fireEvent.click(screen.getByRole("button", { name: "Refresh workspace accounts" }));
    await screen.findByRole("alert");
    expect(screen.queryByText("Shared CRM fixture")).toBeNull(); expect(screen.queryByRole("button", { name: "Browse workspace app catalog" })).toBeNull();
  });

  it("closes a retained A popup and rejects its late consent after switching to B", async () => {
    const pendingA = deferred<Response>(), windowFixture = popup(); vi.spyOn(window, "open").mockReturnValue(windowFixture);
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input); calls.push({ path, init });
      const workspaceId = new Headers(init?.headers).get("X-Shiba-Workspace");
      if (path.endsWith("/connect")) return pendingA.promise;
      if (path.includes("/catalog")) return Response.json({ ok: true, provider: "openconnector", workspaceId, items: [listing], hasMore: false, nextCursor: null });
      return Response.json({ ok: true, workspaceId, canManage: true, connections: [] });
    }));
    const props = { bindingInputs: bindings, actorId: owner, workspaceRole: "owner" as const };
    const view = render(<WorkspaceConnectorsPanel {...props} workspaceId={workspaceA} />);
    fireEvent.click(await screen.findByRole("button", { name: "Browse workspace app catalog" })); fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    fireEvent.click(await screen.findByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Continue to app sign-in" }));
    await waitFor(() => expect(calls.some((call) => call.path.endsWith("/connect"))).toBe(true));
    view.rerender(<WorkspaceConnectorsPanel {...props} workspaceId={workspaceB} />);
    await screen.findByRole("button", { name: "Browse workspace app catalog" });
    await act(async () => { pendingA.resolve(Response.json({ ok: true, workspaceId: workspaceA, connection: account(workspaceA, { version: 1, state: "pending", upstreamReady: false }), pendingId: "pending-a", authorizationFingerprint: "a".repeat(64), redirectUrl: "https://oauth.example.test/old" })); });
    expect(windowFixture.close).toHaveBeenCalled(); expect(windowFixture.location.replace).not.toHaveBeenCalled();
    expect(calls.some((call) => call.path.endsWith("/reconcile"))).toBe(false);
    expect((calls.find((call) => call.path.endsWith("/connect"))?.init?.signal as AbortSignal).aborted).toBe(true);
  });
});
