import { afterEach, describe, expect, it, vi } from "vitest";
import { beginWorkspaceAppConsent, disconnectWorkspaceApp, reconcileWorkspaceAppConsent, saveWorkspaceAppGrant, workspaceAppActions, workspaceAppConnections, workspaceAppGrants, decideWorkspaceAppAction, executeWorkspaceAppAction } from "./workspace-integrations-client";
import type { WorkspaceIntegrationConnection } from "@shiba/shared";

afterEach(() => vi.unstubAllGlobals());
const workspaceId = `ws_${"a".repeat(24)}`;
const connection: WorkspaceIntegrationConnection = { id: "account-one", scope: "workspace", workspaceId, providerKey: "notion", version: 1, generation: 1, state: "pending", identityLabel: null, authorizationFingerprint: "f".repeat(64), upstreamReady: false, health: "unknown", grantCount: 0 };
const respond = (body: unknown, status = 200) => { const fetcher = vi.fn(async () => Response.json(body, { status })); vi.stubGlobal("fetch", fetcher); return fetcher; };

async function failure(operation: Promise<unknown>): Promise<string> {
  const result = await operation.then(() => null, (error: unknown) => error);
  expect(result).toBeInstanceOf(Error);
  return (result as Error).message;
}

describe("workspace integration HTTP contracts", () => {
  it("sends explicit sharing consent with an authoritative header and no body workspace override", async () => {
    const fetcher = respond({ ok: true, workspaceId, connection, pendingId: "pending-one", authorizationFingerprint: connection.authorizationFingerprint, redirectUrl: "https://oauth.example.test/consent" });
    await beginWorkspaceAppConsent(workspaceId, "notion");
    const call = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("/api/workspace-integrations/connect");
    expect(new Headers(call[1].headers).get("X-Shiba-Workspace")).toBe(workspaceId);
    expect(JSON.parse(String(call[1].body))).toEqual({ providerKey: "notion", audienceConsent: "workspace-members" });
  });
  it.each(["outer", "row"])("rejects an unrelated %s workspace account response", async (field) => {
    const foreign = `ws_${"b".repeat(24)}`;
    respond({ ok: true, workspaceId: field === "outer" ? foreign : workspaceId, canManage: true, connections: [{ ...connection, workspaceId: field === "row" ? foreign : workspaceId }] });
    expect(await failure(workspaceAppConnections(workspaceId))).toMatch(/workspace|scope/);
  });
  it.each(["id", "fingerprint"])("does not confirm an old or unrelated OAuth %s", async (field) => {
    respond({ ok: true, workspaceId, connection: { ...connection, state: "active", upstreamReady: true, ...(field === "id" ? { id: "other-account" } : { authorizationFingerprint: "e".repeat(64) }) } });
    expect(await failure(reconcileWorkspaceAppConsent(workspaceId, connection, "pending-one", "f".repeat(64)))).toContain("does not match");
  });
  it("pins disconnect to the reviewed account version and refuses a different receipt", async () => {
    const fetcher = respond({ ok: true, workspaceId, connection: { ...connection, id: "other-account", state: "revoked" } });
    expect(await failure(disconnectWorkspaceApp(workspaceId, connection))).toContain("could not be verified");
    const call = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(call[1].body))).toEqual({ expectedVersion: 1 });
  });
  it("checks grant and action directory account selectors", async () => {
    respond({ ok: true, workspaceId, connectionId: "other-account", connectionVersion: 1, employees: [], actors: [], grants: [] });
    expect(await failure(workspaceAppGrants(workspaceId, connection.id))).toContain("another account");
    expect(await failure(saveWorkspaceAppGrant(workspaceId, connection.id, { employeeId: "employee", employeeVersion: 1, actorId: "member@example.test", actorMembershipVersion: 1, expectedConnectionVersion: 1, expectedGrantVersion: null, permissions: [] }))).toContain("another account");
    respond({ ok: true, workspaceId, connectionId: "other-account", actions: [] });
    expect(await failure(workspaceAppActions(workspaceId, connection.id, "employee", 1, ""))).toContain("another account");
  });
  it("refuses a grant receipt for a different employee, member, revision or permission set", async () => {
    const input = { employeeId: "employee", employeeVersion: 1, actorId: "member@example.test", actorMembershipVersion: 2, expectedConnectionVersion: 1, expectedGrantVersion: null, permissions: ["discover"] as Array<"discover" | "execute"> };
    for (const change of [{ employeeId: "other" }, { actorId: "other@example.test" }, { employeeVersion: 9 }, { actorMembershipVersion: 9 }, { permissions: ["execute"] }, { version: 9 }]) {
      respond({ ok: true, workspaceId, connectionId: connection.id, connectionVersion: 1, employees: [], actors: [], grants: [{ id: "g1", version: 1, employeeId: input.employeeId, employeeVersion: 1, actorId: input.actorId, actorMembershipVersion: 2, permissions: ["discover"], state: "active", ...change }] });
      expect(await failure(saveWorkspaceAppGrant(workspaceId, connection.id, input))).toContain("exact employee and member grant receipt");
    }
  });
  it("does not mistake unrelated decision or execution receipts for success", async () => {
    respond({ ok: true, workspaceId, approvalId: "other-approval", approvals: [] });
    expect(await failure(decideWorkspaceAppAction(workspaceId, "exact-approval", true))).toContain("receipt could not be verified");
    expect(await failure(executeWorkspaceAppAction(workspaceId, "exact-approval"))).toContain("receipt could not be verified");
  });
  it("makes no automatic retry on stale permission or version responses", async () => {
    const fetcher = respond({ error: "raw upstream detail must not be reflected" }, 409);
    expect(await failure(disconnectWorkspaceApp(workspaceId, connection))).toContain("changed");
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
