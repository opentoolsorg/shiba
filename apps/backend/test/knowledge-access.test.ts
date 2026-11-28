import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { canWriteKnowledgeResource } from "../src/knowledge/knowledge-access.js";
import { createTeamWorkspace } from "../src/team-workspaces-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const OWNER = "owner@example.test";
const CREATOR = "creator@example.test";
const MEMBER = "member@example.test";

describe("knowledge write access", () => {
  it("separates shared-resource edit authority from read access", async () => {
    const { database, sqlite } = customAgentD1();
    const env = { AGENT_AUDIT: database } as Env;
    const workspace = await createTeamWorkspace(env, OWNER, { name: "Knowledge" }, 1);
    sqlite.prepare(`INSERT INTO team_workspace_memberships(tenant_id,workspace_id,user_id,role,status,version,joined_at)
      VALUES('self-hosted',?,?, 'member','active',1,2)`).run(workspace.workspaceId, CREATOR);
    sqlite.prepare(`INSERT INTO team_workspace_memberships(tenant_id,workspace_id,user_id,role,status,version,joined_at)
      VALUES('self-hosted',?,?, 'member','active',1,3)`).run(workspace.workspaceId, MEMBER);

    const shared = {
      workspaceId: workspace.workspaceId,
      scope: "workspace" as const,
      createdBy: CREATOR,
      resourceId: "note_shared",
      resourceKind: "note" as const,
    };
    await expect(canWriteKnowledgeResource(env, CREATOR, shared)).resolves.toBe(true);
    await expect(canWriteKnowledgeResource(env, MEMBER, shared)).resolves.toBe(false);
    await expect(canWriteKnowledgeResource(env, OWNER, shared)).resolves.toBe(true);

    const personal = { ...shared, scope: "personal" as const };
    await expect(canWriteKnowledgeResource(env, CREATOR, personal)).resolves.toBe(true);
    await expect(canWriteKnowledgeResource(env, OWNER, personal)).resolves.toBe(false);
  });
});
