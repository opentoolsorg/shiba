import { describe, expect, it, vi } from "vitest";
import type { TokenRecord } from "../src/agent-tokens.js";
import { hashToolArgs, type RegisteredTool } from "../src/mcp-gateway.js";
import { buildEmployeeToolCatalog } from "../src/employee-tool-catalog.js";
import {
  capabilityId,
  dispatchEmployeeTool,
  selectEmployeeCapabilities,
  type EmployeeActionApproval,
  type EmployeeToolAuthority,
} from "../src/employee-tool-policy.js";
import type { CapabilityPolicy, ConnectionGrant } from "../src/connection-policy.js";

const principal: TokenRecord = {
  principal: "actor-1", orgId: "workspace-1", kind: "agent", scopes: ["gmail:read", "email:send"], created: 1, revoked: false,
};
const searchTool: RegisteredTool = {
  name: "gmail_search", scope: "gmail:read", handler: vi.fn(), meta: { inputSchema: {} },
};
const sendTool: RegisteredTool = {
  name: "gmail_send", scope: "email:send", handler: vi.fn(), meta: { inputSchema: {} },
};
const baseAuthority = (): EmployeeToolAuthority => ({
  principal,
  workspaceId: "workspace-1",
  employeeId: "employee-1",
  employeeVersion: 4,
  employeeRole: "operator",
  workspaceCapabilityIds: [capabilityId("gmail_search"), capabilityId("gmail_send")],
  actorCapabilityIds: [capabilityId("gmail_search"), capabilityId("gmail_send")],
  roleCapabilityIds: [capabilityId("gmail_search"), capabilityId("gmail_send")],
  employeeCapabilityIds: [capabilityId("gmail_search"), capabilityId("gmail_send")],
  registeredTools: [searchTool, sendTool],
});
const grant = (overrides: Partial<ConnectionGrant> = {}): ConnectionGrant => ({
  connectionId: "connection-1",
  owner: { type: "user", userId: principal.principal, workspaceId: "workspace-1" },
  lifecycle: "active", verification: "live_verified", verifiedAt: 900, verificationExpiresAt: 2_000,
  capability: { kind: "mcp", id: capabilityId("gmail_search") }, providerScopes: ["gmail.read", "gmail.send"],
  allowedResources: ["mailbox-1"], accountId: "account-1", policyVersion: "v1", generation: 2,
  ...overrides,
});
const policy = (capability: string, action: string, risk: "read" | "external_write"): CapabilityPolicy => ({
  version: "v1", allowlist: [{ kind: "mcp", id: capability }],
  actions: [{ capability: { kind: "mcp", id: capability }, action, risk,
    requiredProviderScopes: [risk === "read" ? "gmail.read" : "gmail.send"], resourceRequired: true }],
});

function exactApproval(argumentDigest: string): EmployeeActionApproval {
  return {
    approvalId: "approval-1", approved: true, approvedAt: 950, principalUserId: principal.principal,
    employeeId: "employee-1", employeeVersion: 4,
    workspaceId: "workspace-1", connectionId: "connection-1", connectionGeneration: 2,
    capability: { kind: "mcp", id: capabilityId("gmail_send") }, action: "gmail_send",
    resourceId: "mailbox-1", accountId: "account-1", argumentDigest, policyVersion: "v1", expiresAt: 1_500,
  };
}

describe("employee tool policy and dispatch", () => {
  it("requires every selected resource in a bounded read action to be granted", async () => {
    const capability = capabilityId("gmail_read");
    const tool: RegisteredTool = { name: "gmail_read", scope: "gmail:read", handler: vi.fn(), meta: { inputSchema: {} } };
    const authority = baseAuthority();
    authority.workspaceCapabilityIds = [capability]; authority.actorCapabilityIds = [capability];
    authority.roleCapabilityIds = [capability]; authority.employeeCapabilityIds = [capability]; authority.registeredTools = [tool];
    const selection = selectEmployeeCapabilities(authority);
    const invoke = vi.fn(async () => ({ content: [{ type: "text" as const, text: "local" }] }));
    const connection = grant({ capability: { kind: "mcp", id: capability }, allowedResources: ["msg-1", "msg-2"], providerScopes: [] });
    const connectionPolicy: CapabilityPolicy = { version: "v1", allowlist: [{ kind: "mcp", id: capability }], actions: [
      { capability: { kind: "mcp", id: capability }, action: "gmail_read", risk: "read", resourceRequired: true, resourceArgument: "messageIds" },
    ] };
    const common = { registry: { invoke } as never, authority, selection, toolName: "gmail_read", connection, connectionPolicy, now: 1_000 };
    expect((await dispatchEmployeeTool({ ...common, args: { messageIds: ["msg-1", "msg-2"] } })).allowed).toBe(true);
    expect(await dispatchEmployeeTool({ ...common, args: { messageIds: ["msg-1", "msg-unselected"] } })).toEqual({ allowed: false, reason: "resource_not_allowed" });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("intersects registered tools, workspace, actor, role, employee selection and authenticated token scopes", () => {
    const authority = baseAuthority();
    authority.actorCapabilityIds = [capabilityId("gmail_search")];
    authority.employeeCapabilityIds = [capabilityId("gmail_search"), "mcp:shiba:unregistered_tool"];
    expect(selectEmployeeCapabilities(authority)).toMatchObject({
      employeeId: "employee-1", employeeVersion: 4, allowedCapabilityIds: [capabilityId("gmail_search")],
      totalEligible: 1, truncated: false,
    });
    expect(() => selectEmployeeCapabilities({ ...authority, employeeCapabilityIds: ["browser:read"] })).toThrow(/Unsupported employee capability/);
  });

  it("projects bounded schemas only for effective employee tools and pins employee/schema versions", async () => {
    const catalog = await buildEmployeeToolCatalog(baseAuthority(), { limit: 1 });
    expect(catalog).toMatchObject({ employee: { id: "employee-1", version: 4 }, totalAuthorized: 2, returned: 1, truncated: true });
    expect(catalog.entries[0]).toMatchObject({ id: "mcp:shiba:gmail_search", allowed: true, schemaVersion: expect.any(String) });
    const reduced = baseAuthority();
    reduced.roleCapabilityIds = [capabilityId("gmail_search")];
    expect((await buildEmployeeToolCatalog(reduced)).entries.map((entry) => entry.name)).toEqual(["gmail_search"]);
  });

  it("dispatches an approved registered tool through the deterministic registry adapter", async () => {
    const authority = baseAuthority();
    const selection = selectEmployeeCapabilities(authority);
    const args = { query: "invoice", resourceId: "mailbox-1", accountId: "account-1" };
    const invoke = vi.fn(async () => ({ content: [{ type: "text" as const, text: "local adapter result" }] }));
    const result = await dispatchEmployeeTool({
      registry: { invoke } as never,
      authority,
      selection,
      toolName: "gmail_search",
      args,
      connection: grant(),
      connectionPolicy: policy(capabilityId("gmail_search"), "gmail_search", "read"),
      now: 1_000,
    });
    expect(result.allowed).toBe(true);
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("gmail_search", args, principal, {});
  });

  it("requires an exact frozen-payload approval for writes and never dispatches modified args", async () => {
    const authority = baseAuthority();
    const selection = selectEmployeeCapabilities(authority);
    const args = { to: "team@example.test", body: "approved body", resourceId: "mailbox-1", accountId: "account-1" };
    const digest = await hashToolArgs(args);
    const invoke = vi.fn(async () => ({ content: [{ type: "text" as const, text: "local" }] }));
    const common = {
      registry: { invoke } as never, authority, selection, toolName: "gmail_send", connection: grant({ capability: { kind: "mcp", id: capabilityId("gmail_send") } }),
      connectionPolicy: policy(capabilityId("gmail_send"), "gmail_send", "external_write"), now: 1_000,
    };
    const pending = await dispatchEmployeeTool({ ...common, args });
    expect(pending).toEqual({ allowed: false, reason: "approval_required" });
    const changed = await dispatchEmployeeTool({ ...common, args: { ...args, body: "different body" }, approval: exactApproval(digest) });
    expect(changed).toEqual({ allowed: false, reason: "approval_mismatch" });
    expect(invoke).not.toHaveBeenCalled();
    const approved = await dispatchEmployeeTool({ ...common, args, approval: exactApproval(digest) });
    expect(approved.allowed).toBe(true);
    expect(invoke).toHaveBeenCalledOnce();
    invoke.mockClear();
    const oldEmployeeApproval = await dispatchEmployeeTool({
      ...common, args, approval: { ...exactApproval(digest), employeeVersion: 3 },
    });
    expect(oldEmployeeApproval).toEqual({ allowed: false, reason: "approval_stale" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rechecks revocation and current employee grants at dispatch instead of trusting discovery", async () => {
    const authority = baseAuthority();
    const selection = selectEmployeeCapabilities(authority);
    const invoke = vi.fn();
    const args = { query: "invoice", resourceId: "mailbox-1", accountId: "account-1" };
    const revoked = await dispatchEmployeeTool({
      registry: { invoke } as never, authority, selection, toolName: "gmail_search", args,
      connection: grant({ lifecycle: "revoked" }),
      connectionPolicy: policy(capabilityId("gmail_search"), "gmail_search", "read"), now: 1_000,
    });
    expect(revoked).toEqual({ allowed: false, reason: "connection_revoked" });
    authority.actorCapabilityIds = [];
    const stale = await dispatchEmployeeTool({
      registry: { invoke } as never, authority, selection, toolName: "gmail_search", args,
      connection: grant(), connectionPolicy: policy(capabilityId("gmail_search"), "gmail_search", "read"), now: 1_000,
    });
    expect(stale).toEqual({ allowed: false, reason: "capability_not_allowed" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses an unsupported action, wrong employee version, or a revoked principal", async () => {
    const authority = baseAuthority();
    const selection = selectEmployeeCapabilities(authority);
    const invoke = vi.fn();
    const input = {
      registry: { invoke } as never, authority, selection, toolName: "gmail_search", args: { query: "x", resourceId: "mailbox-1", accountId: "account-1" },
      connection: grant(), connectionPolicy: policy(capabilityId("gmail_search"), "wrong_action", "read"), now: 1_000,
    };
    expect(await dispatchEmployeeTool(input)).toEqual({ allowed: false, reason: "unsupported_action" });
    expect(await dispatchEmployeeTool({ ...input, selection: { ...selection, employeeVersion: 3 } })).toEqual({ allowed: false, reason: "employee_selection_stale" });
    expect(await dispatchEmployeeTool({ ...input, authority: { ...authority, principal: { ...principal, revoked: true } } })).toEqual({ allowed: false, reason: "invalid_policy_context" });
    expect(invoke).not.toHaveBeenCalled();
  });
});
