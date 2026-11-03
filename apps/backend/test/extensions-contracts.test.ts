import { describe, expect, it } from "vitest";
import {
  archive,
  extensionRowScope,
  extensionRowView,
  mcpOAuthSessionSchema,
  mcpServerSchema,
  mcpToolExecutionSchema,
  restore,
  setScope,
  skillSchema,
  toMcpServerListItem,
  toSkillDirectoryItem,
  toWorkspaceConnectorListItem,
  workspaceConnectorSchema,
} from "@shiba/shared";

const member = { userId: "user-a", role: "member" as const };

describe("extension scopes", () => {
  it("treats missing scope as personal and archived rows as archived view", () => {
    const row = { id: "skill-1", userId: "user-a", archivedAt: 10 };
    expect(extensionRowScope(row)).toBe("personal");
    expect(extensionRowView(row)).toBe("archived");
  });

  it("moves an active creator-owned row when policy allows it", () => {
    const row = { id: "skill-1", userId: "user-a", workspaceId: "ws-1", scope: "personal" as const };
    expect(setScope(row, "workspace", member)).toEqual({ ok: true, patch: { scope: "workspace" } });
    expect(setScope(row, "personal", member)).toEqual({ ok: false, reason: "same_scope" });
    expect(setScope(row, "workspace", { ...member, policy: { workspaceExtensionsEditors: "admins", memberCanMoveScope: true } }))
      .toEqual({ ok: false, reason: "workspace_creation_restricted" });
  });

  it("archives with the prior scope and restores to that scope", () => {
    const row = { id: "server-1", userId: "user-a", workspaceId: "ws-1", scope: "workspace" as const };
    const archived = archive(row, member, 123, { onArchive: { enabled: false } });
    expect(archived).toEqual({ ok: true, patch: { archivedAt: 123, archivedBy: "user-a", archivedFromScope: "workspace", enabled: false } });
    if (!archived.ok) throw new Error("expected archive plan");
    expect(restore({ ...row, ...archived.patch }, member)).toEqual({
      ok: true,
      patch: { scope: "workspace", archivedAt: undefined, archivedBy: undefined, archivedFromScope: undefined },
    });
  });

  it("rejects moving another user's row and archiving twice", () => {
    const row = { id: "server-1", userId: "user-b", workspaceId: "ws-1", scope: "workspace" as const };
    expect(setScope(row, "personal", member)).toEqual({ ok: false, reason: "not_creator" });
    expect(archive({ ...row, archivedAt: 10 }, member, 20)).toEqual({ ok: false, reason: "already_archived" });
  });
});

describe("extension schemas and safe list projections", () => {
  it("parses Overlay-shaped skills and keeps instructions out of directory items", () => {
    const skill = skillSchema.parse({
      id: "skill-1", userId: "user-a", name: "Review", description: "Review code", instructions: "Long prompt",
      createdAt: 1, updatedAt: 2,
    });
    expect(skill.scope).toBeUndefined();
    expect(toSkillDirectoryItem(skill)).toEqual({ id: "skill-1", name: "Review", description: "Review code", enabled: true });
  });

  it("parses MCP OAuth records but omits credentials from list items", () => {
    const server = mcpServerSchema.parse({
      id: "mcp-1", userId: "user-a", name: "Tools", transport: "streamable-http", url: "https://mcp.example.test",
      enabled: true, authType: "oauth", authConfig: { bearerToken: "plain-secret" }, encryptedAuthConfig: "sealed-auth",
      encryptedOAuthTokens: "sealed-token", encryptedOAuthClient: "sealed-client",
      oauthStatus: "connected", toolPolicies: { write: "approval_required" },
      toolCatalog: [{ name: "read", inputSchema: { type: "object" } }], createdAt: 1, updatedAt: 2,
    });
    const listed = toMcpServerListItem(server);
    expect(listed.hasAuth).toBe(true);
    expect(listed.defaultToolPolicy).toBe("allow");
    expect(listed.toolCatalogCount).toBe(1);
    expect(listed).not.toHaveProperty("authConfig");
    expect(listed).not.toHaveProperty("encryptedAuthConfig");
    expect(listed).not.toHaveProperty("encryptedOAuthTokens");
    expect(listed).not.toHaveProperty("encryptedOAuthClient");
    expect(listed).not.toHaveProperty("toolCatalog");
    expect(mcpOAuthSessionSchema.parse({
      id: "session-row", sessionId: "state", userId: "user-a", mcpServerId: "mcp-1", encryptedCodeVerifier: "sealed",
      surface: "web", expiresAt: 100, createdAt: 1,
    }).surface).toBe("web");
  });

  it("parses hashed MCP execution audit rows without raw arguments", () => {
    expect(mcpToolExecutionSchema.parse({
      id: "execution-1", userId: "user-a", mcpServerId: "mcp-1", toolName: "read",
      argumentsHash: "a".repeat(64), policyDecision: "approval_required", status: "succeeded", createdAt: 10,
    })).toMatchObject({ policyDecision: "approval_required", status: "succeeded" });
  });

  it("only exposes a connector account reference to its owner", () => {
    const connector = workspaceConnectorSchema.parse({
      id: "connector-1", workspaceId: "ws-1", userId: "user-a", providerKey: "github",
      connectedAccountId: "account-secret", createdAt: 1, updatedAt: 2,
    });
    expect(toWorkspaceConnectorListItem(connector, "user-b")).not.toHaveProperty("connectedAccountId");
    expect(toWorkspaceConnectorListItem(connector, "user-a").connectedAccountId).toBe("account-secret");
  });
});
