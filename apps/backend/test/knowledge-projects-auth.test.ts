import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { handleKnowledgeProjects } from "../src/knowledge/knowledge-projects-routes.js";
import { createProject } from "../src/knowledge/knowledge-projects.js";
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
});
