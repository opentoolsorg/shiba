import { describe, expect, it } from "vitest";
import { collaborationExecutorIdentity, mintCollaborationExecutor } from "../src/collaboration-executor.js";

const workspaceId = `ws_${"a".repeat(24)}`;
const scope = { tenantId: "self-hosted", workspaceId, userId: "owner@example.test" };
const rawOwner = "Owner@Example.Test";

describe("server-only collaboration executor addresses", () => {
  it("mints fresh owned web UUIDs without copying private history or creating a registry record", () => {
    const first = mintCollaborationExecutor(scope, rawOwner), second = mintCollaborationExecutor(scope, rawOwner);
    expect(first).toMatch(/^web:Owner@Example\.Test:[a-f0-9-]{36}$/);
    expect(first).not.toBe(second);
    const parsed = collaborationExecutorIdentity({ ...scope, senderUserId: scope.userId, executorAgentName: first });
    expect(parsed).toEqual({ agentName: first, ownerId: rawOwner, sessionId: first.split(":").at(-1) });
    expect(parsed?.sessionId).not.toBe("default");
    expect(Object.keys(parsed!)).toEqual(["agentName", "ownerId", "sessionId"]);
  });
  it.each([...Array.from({ length: 33 }, (_, index) => index), 127])("rejects control/space character %i in an otherwise matching owner", (code) => {
    const invalidOwner = `own${String.fromCharCode(code)}er@example.test`;
    expect(() => mintCollaborationExecutor({ ...scope, userId: invalidOwner }, invalidOwner)).toThrow("Invalid collaboration executor");
  });
  it("preserves only the existing own-base executor in the legacy default workspace", () => {
    const legacy = { ...scope, workspaceId: "default" };
    expect(mintCollaborationExecutor(legacy, rawOwner)).toBe(rawOwner);
    expect(collaborationExecutorIdentity({ ...legacy, senderUserId: scope.userId, executorAgentName: rawOwner }))
      .toEqual({ agentName: rawOwner, ownerId: rawOwner, sessionId: "default" });
    expect(collaborationExecutorIdentity({ ...legacy, senderUserId: scope.userId, executorAgentName: mintCollaborationExecutor(scope, rawOwner) })).toBeNull();
  });
  it.each([rawOwner, null, undefined, "default", "slack:T:C:123", "web:other@example.test:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    `web:${rawOwner}:default`, `web:${rawOwner}:not-a-uuid`, `web:${rawOwner}:../private`, `web:slack:${rawOwner}:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`])
    ("rejects unsafe or legacy team executor %s without fallback", (executorAgentName) => {
      expect(collaborationExecutorIdentity({ ...scope, senderUserId: scope.userId, executorAgentName })).toBeNull();
    });
  it.each([
    { ...scope, tenantId: "other-tenant" }, { ...scope, workspaceId: "ws_guessed" }, { ...scope, userId: "other@example.test" },
    { ...scope, userId: "automation:owner@example.test" },
  ])("refuses unknown or mismatched scope %j before minting", (invalid) => {
    expect(() => mintCollaborationExecutor(invalid, rawOwner)).toThrow("Invalid collaboration executor");
  });
});
