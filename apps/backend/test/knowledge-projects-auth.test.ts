import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { handleKnowledgeProjects } from "../src/knowledge/knowledge-projects-routes.js";
import { createProject } from "../src/knowledge/knowledge-projects.js";
import { handleNotes } from "../src/notes/notes-routes.js";
import { createNote } from "../src/notes/notes-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const TEAM = "ws_abcdefabcdefabcdefabcdef";
const state = vi.hoisted(() => ({ userId: "alice@example.test", role: "member" as "owner" | "admin" | "member" }));

vi.mock("../src/request-auth.js", () => ({
  resolveRequestIdentity: async () => ({ authorized: true, userId: state.userId }),
  requireSameOriginBrowserMutation: () => null,
}));
vi.mock("../src/org-request-auth.js", () => ({
  resolveOrgForApiRequest: async () => ({
    workspace: { workspaceId: TEAM, userId: state.userId, role: state.role, version: 1, joinedAt: 1 },
  }),
}));

function request(method: string, projectId: string, body?: unknown) {
  return new Request(`https://shiba.test/api/projects/${projectId}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function envWithFiles(database: D1Database) {
  const objects = new Map<string, Uint8Array>();
  return {
    AGENT_AUDIT: database,
    INGEST_QUEUE: { send: async () => undefined },
    FILES: {
      put: async (key: string, bytes: Uint8Array) => { objects.set(key, bytes); return {}; },
      get: async (key: string) => {
        const bytes = objects.get(key);
        return bytes ? { text: async () => new TextDecoder().decode(bytes) } : null;
      },
    },
  } as unknown as Env;
}

function membershipRequest(projectId: string, body: unknown) {
  return new Request(`https://shiba.test/api/projects/${projectId}/membership`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("knowledge project mutation authority", () => {
  beforeEach(() => {
    state.userId = "alice@example.test";
    state.role = "member";
  });

  it("lets members mutate their own projects but not another member's project", async () => {
    const { database } = customAgentD1();
    const env = { AGENT_AUDIT: database } as Env;
    const project = await createProject(env, TEAM, "Shared organization", "bob@example.test");

    expect((await handleKnowledgeProjects(request("PATCH", project.id, { name: "Denied" }), env))?.status).toBe(403);
    expect((await handleKnowledgeProjects(request("DELETE", project.id), env))?.status).toBe(403);

    state.userId = "bob@example.test";
    expect((await handleKnowledgeProjects(request("PATCH", project.id, { name: "Allowed" }), env))?.status).toBe(200);
    expect((await handleKnowledgeProjects(request("DELETE", project.id), env))?.status).toBe(200);
  });

  it("keeps legacy ownerless projects limited to workspace owners and admins", async () => {
    const { database } = customAgentD1();
    const env = { AGENT_AUDIT: database } as Env;
    const project = await createProject(env, TEAM, "Legacy project");

    expect((await handleKnowledgeProjects(request("DELETE", project.id), env))?.status).toBe(403);
    state.role = "admin";
    expect((await handleKnowledgeProjects(request("DELETE", project.id), env))?.status).toBe(200);
  });

  it("requires authority over both projects when membership moves or detaches a resource", async () => {
    const { database, sqlite } = customAgentD1();
    const env = envWithFiles(database);
    sqlite.prepare(`INSERT INTO team_workspaces(tenant_id,workspace_id,name,version,created_at) VALUES('self-hosted',?,?,?,?)`)
      .run(TEAM, "Fixture workspace", 1, 1);
    for (const [userId, role] of [["alice@example.test", "member"], ["bob@example.test", "admin"]] as const) {
      sqlite.prepare(`INSERT INTO team_workspace_memberships(tenant_id,workspace_id,user_id,role,status,version,joined_at)
        VALUES('self-hosted',?,?,?, 'active',1,1)`).run(TEAM, userId, role);
    }
    const source = await createProject(env, TEAM, "Bob project", "bob@example.test");
    const target = await createProject(env, TEAM, "Alice project", "alice@example.test");
    const note = await createNote(env, {
      workspaceId: TEAM,
      scope: "workspace",
      title: "Shared note",
      markdown: "body",
      createdBy: "alice@example.test",
      projectId: source.id,
    });

    const denied = await handleKnowledgeProjects(membershipRequest(target.id, {
      resourceKind: "note",
      resourceId: note.id,
      assign: false,
    }), env);
    expect(denied?.status).toBe(403);

    state.userId = "bob@example.test";
    state.role = "admin";
    const allowed = await handleKnowledgeProjects(membershipRequest(target.id, {
      resourceKind: "note",
      resourceId: note.id,
      assign: false,
    }), env);
    expect(allowed?.status).toBe(200);
  });

  it("does not let a member create a note directly inside another member's project", async () => {
    const { database } = customAgentD1();
    const env = envWithFiles(database);
    const project = await createProject(env, TEAM, "Bob project", "bob@example.test");
    const response = await handleNotes(new Request("https://shiba.test/api/notes?scope=workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Intrusion", markdown: "", projectId: project.id }),
    }), env);
    expect(response?.status).toBe(403);
  });
});
