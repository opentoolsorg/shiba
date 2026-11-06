import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { resolveOrgForApiRequest } from "../src/org-request-auth.js";
import { createTeamWorkspace, createTeamWorkspaceInvitation, acceptTeamWorkspaceInvitation } from "../src/team-workspaces-store.js";
import { createCustomAgent } from "../src/custom-agents-store.js";
import { handleWebSessions } from "../src/sessions-routes.js";
import { handleRuns } from "../src/runs-routes.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import type { WebSessionRecord } from "../src/web-sessions.js";

const state = vi.hoisted(() => ({ user: "owner@example.test", restricted: false, principal: null as null | { orgId: string; principal: string; scopes: string[] } }));
vi.mock("../src/request-auth.js", async (original) => ({ ...await original<typeof import("../src/request-auth.js")>(),
  isAuthorizedRequest: async () => true, resolveUserId: async () => state.user,
}));
vi.mock("../src/team-member-auth.js", () => ({ isRestrictedTeamMember: async () => state.restricted }));
vi.mock("../src/v1-auth.js", async (original) => ({ ...await original<typeof import("../src/v1-auth.js")>(), authorizeV1Request: async () => state.principal }));
vi.mock("agents/routing", () => ({ getAgentByName: async (namespace: { get(name: string): unknown }, name: string) => namespace.get(name) }));

beforeEach(() => { state.user = "owner@example.test"; state.restricted = false; state.principal = null; });
async function fixture() {
  const db = customAgentD1();
  const sessions = new Map<string, WebSessionRecord>();
  const calls: string[] = [];
  const env = { AGENT_AUDIT: db.database, BETTER_AUTH_SECRET: "fixture-only", CodingOrchestrator: {
    get: () => ({ fetch: async (input: string | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      const method = init?.method ?? (typeof input === "string" ? "GET" : input.method);
      calls.push(`${method} ${url.pathname}`);
      if (url.pathname === "/internal/web-sessions" && method === "GET") return Response.json({ sessions: [...sessions.values()] });
      if (url.pathname === "/internal/web-sessions" && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { session: WebSessionRecord };
        sessions.set(body.session.id, body.session);
        return Response.json({ ok: true });
      }
      const id = url.pathname.split("/")[3] ?? "";
      const session = sessions.get(id);
      return session ? Response.json({ session }) : Response.json({ error: "Not found." }, { status: 404 });
    } }),
  } } as unknown as Env;
  const workspace = await createTeamWorkspace(env, state.user, { name: "Team A" });
  const other = await createTeamWorkspace(env, state.user, { name: "Team B" });
  const invite = await createTeamWorkspaceInvitation(env, workspace.workspaceId, state.user, { email: "member@example.test", role: "member" });
  await acceptTeamWorkspaceInvitation(env, "member@example.test", invite.token);
  return { ...db, env, sessions, calls, workspaceId: workspace.workspaceId, otherId: other.workspaceId };
}
function request(path: string, workspaceId?: string, method = "GET", body?: unknown) {
  return new Request(`https://shiba.test${path}`, { method,
    headers: { origin: "https://shiba.test", "Content-Type": "application/json", ...(workspaceId ? { "X-Shiba-Workspace": workspaceId } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("verified team organization boundaries", () => {
  it("derives org only from current membership and permits member reads, not shared configuration writes", async () => {
    const f = await fixture();
    state.user = "member@example.test";
    expect(await resolveOrgForApiRequest(request("/api/custom-agents", f.workspaceId), f.env)).toMatchObject({ orgId: `team:${f.workspaceId}`, workspace: { role: "member" } });
    const denied = await resolveOrgForApiRequest(request("/api/custom-agents", f.workspaceId, "POST", {}), f.env);
    expect(denied).toBeInstanceOf(Response); expect((denied as Response).status).toBe(403);
    expect((await resolveOrgForApiRequest(request("/api/custom-agents", f.otherId), f.env) as Response).status).toBe(404);
    f.sqlite.prepare("UPDATE team_workspace_memberships SET role='admin',version=version+1 WHERE workspace_id=? AND user_id=?").run(f.workspaceId, state.user);
    expect(await resolveOrgForApiRequest(request("/api/custom-agents", f.workspaceId, "POST", {}), f.env)).toMatchObject({ orgId: `team:${f.workspaceId}`, workspace: { role: "admin" } });
    f.sqlite.prepare("UPDATE team_workspace_memberships SET status='removed' WHERE workspace_id=? AND user_id=?").run(f.workspaceId, state.user);
    expect((await resolveOrgForApiRequest(request("/api/custom-agents", f.workspaceId), f.env) as Response).status).toBe(404);
  });

  it("keeps operator legacy scope, fails closed for invited accounts without a selector, and rejects bearer/header confusion", async () => {
    const f = await fixture();
    expect(await resolveOrgForApiRequest(request("/api/custom-agents", undefined, "POST", { orgId: `team:${f.otherId}` }), f.env)).toMatchObject({ orgId: "self-hosted" });
    state.restricted = true;
    expect((await resolveOrgForApiRequest(request("/api/custom-agents"), f.env) as Response).status).toBe(403);
    expect((await handleRuns(request("/api/runs/some-run/deliverables/0"), f.env))?.status).toBe(403);
    expect((await handleWebSessions(request("/api/sessions"), f.env))?.status).toBe(403);
    expect(f.calls).toEqual([]);
    state.principal = { principal: "key-owner", orgId: "org-key", scopes: ["api:read"] };
    const bearer = request("/api/custom-agents", f.workspaceId);
    bearer.headers.set("Authorization", "Bearer fixture-key");
    expect((await resolveOrgForApiRequest(bearer, f.env) as Response).status).toBe(403);
  });

  it("validates the selected employee in the verified org and freezes server-owned session scope", async () => {
    const f = await fixture();
    const config = { name: "Engineering", harness: "opencode", instructions: "Review approved work." };
    const teamProfile = await createCustomAgent(f.env, `team:${f.workspaceId}`, "engineering", config);
    const legacy = await createCustomAgent(f.env, "self-hosted", "private-legacy", config);
    state.user = "member@example.test"; state.restricted = true;
    const denied = await handleWebSessions(request("/api/sessions", f.workspaceId, "POST", { metadata: { customAgentId: legacy.id, orgId: "self-hosted" } }), f.env);
    expect(denied?.status).toBe(404); expect(f.sessions.size).toBe(0);
    const created = await handleWebSessions(request("/api/sessions", f.workspaceId, "POST", { name: "Team thread", metadata: {
      customAgentId: teamProfile.id, orgId: `team:${f.otherId}`, teamWorkspaceId: f.otherId, teamMembershipVersion: 999,
    } }), f.env);
    expect(created?.status).toBe(201);
    const body = await created!.json() as { session: WebSessionRecord };
    expect(body.session.metadata).toEqual({ customAgentId: teamProfile.id, orgId: `team:${f.workspaceId}`, teamWorkspaceId: f.workspaceId, teamMembershipVersion: 1 });
    expect((await handleWebSessions(request(`/api/sessions/${body.session.id}`, f.otherId), f.env))?.status).toBe(404);
    f.sqlite.prepare("UPDATE team_workspace_memberships SET status='removed' WHERE workspace_id=? AND user_id=?").run(f.workspaceId, state.user);
    expect((await handleWebSessions(request(`/api/sessions/${body.session.id}`, f.workspaceId), f.env))?.status).toBe(404);
    state.user = "owner@example.test"; state.restricted = false;
    // Even an operator cannot erase a team session's scope by omitting the selector.
    for (const [method, suffix] of [["GET", ""], ["PATCH", ""], ["DELETE", ""], ["POST", "/resume"], ["GET", "/realtime"]]) {
      expect((await handleWebSessions(request(`/api/sessions/${body.session.id}${suffix}`, undefined, method,
        method === "PATCH" ? { metadata: { purpose: "Adopt into legacy" } } : undefined), f.env))?.status).toBe(404);
    }
  });

  it("never routes explicit credentials into the ambient human's private session registry", async () => {
    const f = await fixture();
    const id = "11111111-1111-4111-8111-111111111111";
    for (const credential of ["Bearer invalid", "Bearer scoped-read-key", ""]) {
      state.principal = credential === "Bearer scoped-read-key"
        ? { principal: "ci-reader", orgId: "other-org", scopes: ["api:read"] } : null;
      for (const [method, path] of [
        ["GET", "/api/sessions"], ["GET", `/api/sessions/${id}`], ["DELETE", `/api/sessions/${id}`],
        ["POST", `/api/sessions/${id}/resume`], ["GET", `/api/rooms/${id}/websocket`],
      ]) {
        const selected = request(path!, undefined, method);
        selected.headers.set("Cookie", "session=fixture");
        selected.headers.set("Authorization", credential);
        expect((await handleWebSessions(selected, f.env))?.status).toBe(403);
      }
    }
    expect(f.calls).toEqual([]);
  });

  it("filters session lists and refuses the mixed legacy base session and direct team run registry", async () => {
    const f = await fixture();
    const profile = await createCustomAgent(f.env, `team:${f.workspaceId}`, "engineering", { name: "Engineering", harness: "opencode", instructions: "Review." });
    const created = await handleWebSessions(request("/api/sessions", f.workspaceId, "POST", { metadata: { customAgentId: profile.id } }), f.env);
    const body = await created!.json() as { session: WebSessionRecord };
    f.sessions.set("11111111-1111-4111-8111-111111111111", { ...body.session, id: "11111111-1111-4111-8111-111111111111", metadata: { orgId: "self-hosted" } });
    const list = await handleWebSessions(request("/api/sessions", f.workspaceId), f.env);
    expect(await list?.json()).toMatchObject({ defaultSessionId: null, sessions: [{ id: body.session.id }] });
    expect((await handleWebSessions(request("/api/sessions/default", f.workspaceId), f.env))?.status).toBe(404);
    const callsBefore = f.calls.length;
    expect((await handleRuns(request("/api/runs", f.workspaceId), f.env))?.status).toBe(403);
    expect((await handleRuns(request("/api/runs", f.workspaceId, "POST", {
      task: "Forged direct run", orgId: `team:${f.workspaceId}`, customAgentId: profile.id, collaborationHandoffId: "guessed-handoff",
    }), f.env))?.status).toBe(403);
    expect(f.calls.length).toBe(callsBefore);
  });
});
