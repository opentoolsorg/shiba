import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { governanceD1Fixture } from "./fixtures/governance-d1.js";
import { acceptTeamWorkspaceInvitation, createTeamWorkspace, createTeamWorkspaceInvitation } from "../src/team-workspaces-store.js";
import { addWorkspaceGroupMember, createWorkspaceGroup, removeWorkspaceGroupMember } from "../src/governance/governance-store.js";
import { createCustomAgent } from "../src/custom-agents-store.js";
import { employeeAccessDenial, listEmployeeAccess, resolveEmployeeAccess, setEmployeeAccess, visibleEmployees } from "../src/governance/employee-access.js";
import { enforceEmployeeRouteAccess } from "../src/governance/employee-route-auth.js";
import { handleEmployeeAccess } from "../src/governance/employee-access-routes.js";
import { resolveOrgForApiRequest } from "../src/org-request-auth.js";
import { resolveUserId } from "../src/request-auth.js";

vi.mock("../src/org-request-auth.js", () => ({ resolveOrgForApiRequest: vi.fn() }));
vi.mock("../src/request-auth.js", async (original) => ({ ...await original<typeof import("../src/request-auth.js")>(), resolveUserId: vi.fn() }));
const owner = "alice@example.test", member = "bob@example.test";
async function fixture() {
  const { env, sqlite } = await governanceD1Fixture();
  sqlite.exec(readFileSync(new URL("../migrations/0061_employee_access.sql", import.meta.url), "utf8"));
  const workspace = await createTeamWorkspace(env, owner, { name: "Team" });
  const invitation = await createTeamWorkspaceInvitation(env, workspace.workspaceId, owner, { email: member, role: "member" });
  const joined = await acceptTeamWorkspaceInvitation(env, member, invitation.token);
  const employee = await createCustomAgent({ AGENT_AUDIT: env.AGENT_AUDIT! }, `team:${workspace.workspaceId}`, "finance", { name: "Finance", instructions: "Finance tasks", harness: "opencode" });
  const set = (principalKind: string, principalId: string, level: string) => setEmployeeAccess(env, workspace.workspaceId, employee.id, owner, { principalKind, principalId, level });
  const resolve = (actor = member) => resolveEmployeeAccess(env, workspace.workspaceId, employee.id, actor);
  const auth = (actor = member) => {
    vi.mocked(resolveUserId).mockResolvedValue(actor);
    vi.mocked(resolveOrgForApiRequest).mockResolvedValue({ orgId: employee.orgId, principal: null, workspace: actor === member ? joined.membership : workspace.membership });
  };
  return { env, sqlite, workspaceId: workspace.workspaceId, employee, set, resolve, auth };
}

describe("employee access", () => {
  it("defaults compatibly, denies nonmembers and preserves owner/admin authority", async () => {
    const { resolve, set } = await fixture();
    expect(await resolve()).toBe("manage");
    expect(await resolve("other@example.test")).toBe("none");
    await set("everyone", "*", "none");
    expect(await resolve()).toBe("none");
    expect(await resolve(owner)).toBe("manage");
  });
  it("uses direct overrides, highest active group, then Everyone; removal takes effect immediately", async () => {
    const { env, workspaceId, set, resolve } = await fixture();
    const group = await createWorkspaceGroup(env, workspaceId, owner, { name: "Finance team" });
    const second = await createWorkspaceGroup(env, workspaceId, owner, { name: "Reviewers" });
    await set("everyone", "*", "none");
    await addWorkspaceGroupMember(env, workspaceId, owner, group.groupId, member);
    await addWorkspaceGroupMember(env, workspaceId, owner, second.groupId, member);
    await set("group", group.groupId, "chat");
    await set("group", second.groupId, "view");
    expect(await resolve()).toBe("chat");
    await removeWorkspaceGroupMember(env, workspaceId, owner, group.groupId, member);
    expect(await resolve()).toBe("view");
    await set("user", member, "none");
    expect(await resolve()).toBe("none");
  });
  it("audits every change with employee and principal names captured at that time", async () => {
    const { env, sqlite, workspaceId, employee, set } = await fixture();
    const group = await createWorkspaceGroup(env, workspaceId, owner, { name: "Finance team" });
    await set("group", group.groupId, "chat");
    sqlite.prepare("UPDATE workspace_groups SET name='Renamed'").run();
    const row = sqlite.prepare("SELECT detail FROM audit_log WHERE tool='employee.access.changed'").get() as { detail: string };
    expect(JSON.parse(row.detail)).toMatchObject({ employeeName: "Finance", principalName: "Finance team", actorName: owner, before: null, after: "chat" });
    await expect(set("user", "missing@example.test", "chat")).rejects.toThrow("Member not found");
    await expect(set("everyone", "*", "invalid")).rejects.toThrow("Invalid employee access");
    expect(await listEmployeeAccess(env, workspaceId, employee.id)).toHaveLength(1);
  });
  it("filters hidden employees and gates reads, writes and approvals in the route table", async () => {
    const { env, workspaceId, employee, set, auth } = await fixture(); auth();
    const request = (path: string, method = "GET", body?: unknown) => new Request(`https://app.test${path}`, { method, headers: { "X-Shiba-Workspace": workspaceId, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    await set("everyone", "*", "none");
    expect(await visibleEmployees(env, workspaceId, member, [employee])).toEqual([]);
    expect((await enforceEmployeeRouteAccess(request(`/api/custom-agents/${employee.id}`), env))?.status).toBe(404);
    await set("everyone", "*", "view");
    expect(await enforceEmployeeRouteAccess(request(`/api/custom-agents/${employee.id}`), env)).toBeNull();
    expect((await enforceEmployeeRouteAccess(request(`/api/custom-agents/${employee.id}`, "PUT", {}), env))?.status).toBe(403);
    expect((await enforceEmployeeRouteAccess(request("/api/employee-tools/approvals/a", "POST", { employeeId: employee.id }), env))?.status).toBe(403);
    await set("everyone", "*", "chat");
    expect(await enforceEmployeeRouteAccess(request("/api/employee-tools/approvals/a", "POST", { employeeId: employee.id }), env)).toBeNull();
    expect((await enforceEmployeeRouteAccess(request(`/api/employee-tools/${employee.id}/policy`, "PUT", {}), env))?.status).toBe(403);
    expect(employeeAccessDenial("manage", "manage")).toBeNull();
  });
  it("serves empty settings and rejects invalid input and unauthorized changes", async () => {
    const { env, employee, workspaceId, set, auth } = await fixture(); auth(owner);
    const url = `https://app.test/api/governance/employees/${employee.id}/access`;
    const response = await handleEmployeeAccess(new Request(url), env);
    expect(await response!.json()).toEqual({ level: "manage", grants: [] });
    expect((await handleEmployeeAccess(new Request(url, { method: "PUT", headers: { "Content-Type": "application/json", Origin: "https://app.test" }, body: "null" }), env))?.status).toBe(400);
    await set("everyone", "*", "view"); auth();
    expect((await handleEmployeeAccess(new Request(url, { method: "PUT", headers: { "X-Shiba-Workspace": workspaceId }, body: "{}" }), env))?.status).toBe(403);
    vi.mocked(resolveOrgForApiRequest).mockResolvedValue({ orgId: "self-hosted", principal: null });
    expect(await enforceEmployeeRouteAccess(new Request(`https://app.test/api/custom-agents/${employee.id}`), env)).toBeNull();
  });
});
