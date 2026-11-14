import { beforeEach, describe, expect, it, vi } from "vitest";
import { addCollaborationMember, COLLAB_TENANT_ID, COLLAB_WORKSPACE_ID, collaborationEmployeeOrgId, createCollaborationRoom, ensureCollaborationSchema } from "../src/collaboration-store.js";
import { createCustomAgent } from "../src/custom-agents-store.js";
import { handlePrimaryBot } from "../src/collaboration-primary-bot-routes.js";
import { routeUnaddressedMessage, setWorkspacePrimaryBot } from "../src/collaboration-router.js";
import { createTeamWorkspace } from "../src/team-workspaces-store.js";
import type { Env } from "../src/env.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const authState = vi.hoisted(() => ({ userId: "owner@example.test", authorized: true }));
vi.mock("../src/request-auth.js", () => ({
  isAuthorizedRequest: vi.fn(async () => authState.authorized),
  resolveUserId: vi.fn(async () => authState.userId),
  requireJsonContentType: (request: Request) => {
    const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    return type === "application/json" ? null : Response.json({ error: "Content-Type must be application/json." }, { status: 415 });
  },
  requireSameOriginBrowserMutation: (request: Request) => {
    if (request.method === "GET") return null;
    const url = new URL(request.url);
    return request.headers.get("origin") === url.origin ? null : Response.json({ error: "Same-origin request required." }, { status: 403 });
  },
}));

beforeEach(() => {
  authState.userId = "owner@example.test";
  authState.authorized = true;
});

const OWNER = "owner@example.test";

async function roomWithBots() {
  const { database, sqlite } = customAgentD1();
  const env = { AGENT_AUDIT: database } as unknown as Env;
  await ensureCollaborationSchema(env);
  const scope = { tenantId: COLLAB_TENANT_ID, workspaceId: COLLAB_WORKSPACE_ID, userId: OWNER };
  const room = await createCollaborationRoom(env, scope, { roomId: "room_route", title: "QA", visibility: "private", createdAt: 1 });
  const orgId = collaborationEmployeeOrgId(scope);
  const bots = [
    { slug: "shiba", name: "Shiba", instructions: "Routes work to the right bot", toolScopes: ["routing"] },
    { slug: "fixer", name: "Fixer", instructions: "Edits repository files", toolScopes: ["repo edits"] },
    { slug: "reviewer", name: "Reviewer", instructions: "Reviews pull requests", toolScopes: ["pull requests"] },
  ];
  for (const bot of bots) {
    await createCustomAgent(env, orgId, bot.slug, { name: bot.name, instructions: bot.instructions, harness: "opencode", toolScopes: bot.toolScopes });
    expect(await addCollaborationMember(env, scope, room.roomId, {
      userId: OWNER,
      displayName: bot.name,
      actorId: `agent:${bot.slug}`,
      kind: "agent",
      profileVersion: 1,
      createdAt: 2,
    })).toBe(true);
  }
  await setWorkspacePrimaryBot(env, scope, "agent:shiba", 3);
  return { env, sqlite, scope, roomId: room.roomId };
}

describe("collaboration router", () => {
  it("stays silent when the message names an agent", async () => {
    const { env, sqlite, scope, roomId } = await roomWithBots();
    const routed = await routeUnaddressedMessage(env, scope, {
      roomId,
      messageId: "msg_mentioned",
      body: "@agent:fixer please fix the readme typo in the repo",
      now: 10,
    });
    expect(routed).toEqual({ action: "silent", handoffs: [], startedRun: false });
    const decisions = sqlite.prepare("SELECT COUNT(*) AS n FROM collaboration_router_decisions").get() as { n: number };
    expect(decisions.n).toBe(0);
  });

  it("creates one handoff when the margin is confident and does not start a run", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("classify must stay off");
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const { env, sqlite, scope, roomId } = await roomWithBots();
      const routed = await routeUnaddressedMessage(env, scope, {
        roomId,
        messageId: "msg_readme",
        body: "please fix the readme typo in the repo",
        now: 20,
      });
      expect(routed.startedRun).toBe(false);
      expect(routed.action).toBe("handoff");
      expect(routed.handoffs).toHaveLength(1);
      expect(routed.handoffs[0]?.runId ?? null).toBeNull();
      const cards = sqlite.prepare("SELECT body, payload_json FROM collaboration_messages WHERE message_kind='handoff'").all() as { body: string; payload_json: string }[];
      expect(cards).toHaveLength(1);
      expect(cards[0]?.body).toContain("Shiba → Fixer");
      expect(cards[0]?.body).toContain("because");
      expect(cards[0]?.body).toContain("repo edits");
      const child = sqlite.prepare("SELECT child_thread_root_id FROM collaboration_handoff_returns WHERE handoff_id=?").get(routed.handoffs[0]?.handoffId ?? "") as { child_thread_root_id: string };
      expect(JSON.parse(cards[0]?.payload_json ?? "{}")).toMatchObject({
        handoffId: routed.handoffs[0]?.handoffId,
        childThreadRootId: child.child_thread_root_id,
      });
      const runs = sqlite.prepare("SELECT COUNT(*) AS n FROM collaboration_handoffs WHERE run_id IS NOT NULL").get() as { n: number };
      expect(runs.n).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("posts one question card with at most four options when it is unsure", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("classify must stay off");
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const { env, sqlite, scope, roomId } = await roomWithBots();
      const routed = await routeUnaddressedMessage(env, scope, {
        roomId,
        messageId: "msg_vague",
        body: "hello there",
        now: 30,
      });
      expect(routed.action).toBe("question");
      expect(routed.handoffs).toHaveLength(0);
      expect(routed.startedRun).toBe(false);
      const cards = sqlite.prepare("SELECT body FROM collaboration_messages WHERE message_kind='question_card'").all() as { body: string }[];
      expect(cards).toHaveLength(1);
      const card = cards[0];
      if (!card) throw new Error("missing question card");
      const options = card.body.split("\n").slice(1);
      expect(options.length).toBeLessThanOrEqual(4);
      expect(options).toContain("I'll handle it");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lets workspace admins set the primary bot and refuses members", async () => {
    const { database, sqlite } = customAgentD1();
    const env = { AGENT_AUDIT: database } as unknown as Env;
    const workspace = await createTeamWorkspace(env, OWNER, { name: "Bots" });
    await createCustomAgent(env, collaborationEmployeeOrgId(workspace), "fixer", {
      name: "Fixer", instructions: "Fix repository issues", harness: "opencode",
    });
    sqlite.prepare(
      `INSERT INTO team_workspace_memberships (tenant_id, workspace_id, user_id, role, status, version, joined_at)
       VALUES (?, ?, 'member@example.test', 'member', 'active', 1, 1)`,
    ).run(COLLAB_TENANT_ID, workspace.workspaceId);
    const put = await handlePrimaryBot(new Request(`https://worker.test/api/workspaces/${workspace.workspaceId}/primary-bot`, {
      method: "PUT",
      headers: { origin: "https://worker.test", "content-type": "application/json" },
      body: JSON.stringify({ actorId: "agent:fixer" }),
    }), env);
    expect(put?.status).toBe(200);
    expect(await put?.json()).toMatchObject({ actorId: "agent:fixer", source: "saved" });
    authState.userId = "member@example.test";
    const denied = await handlePrimaryBot(new Request(`https://worker.test/api/workspaces/${workspace.workspaceId}/primary-bot`), env);
    expect(denied?.status).toBe(403);
  });

  it("rejects missing, foreign, archived and deleted primary bot profiles without changing the saved bot", async () => {
    const { database, sqlite } = customAgentD1();
    const env = { AGENT_AUDIT: database } as unknown as Env;
    const workspace = await createTeamWorkspace(env, OWNER, { name: "Bots" });
    const orgId = collaborationEmployeeOrgId(workspace);
    const config = { name: "Bot", instructions: "Help with work", harness: "opencode" as const };
    const active = await createCustomAgent(env, orgId, "active", config);
    const archived = await createCustomAgent(env, orgId, "archived", config);
    const deleted = await createCustomAgent(env, orgId, "deleted", config);
    const foreign = await createCustomAgent(env, "team:another-workspace", "foreign", config);
    sqlite.prepare("UPDATE org_custom_agents SET archived_at=1 WHERE id=?").run(archived.id);
    sqlite.prepare("UPDATE org_custom_agents SET deleted_at=1 WHERE id=?").run(deleted.id);
    const put = (actorId: string) => handlePrimaryBot(new Request(`https://worker.test/api/workspaces/${workspace.workspaceId}/primary-bot`, {
      method: "PUT",
      headers: { origin: "https://worker.test", "content-type": "application/json" },
      body: JSON.stringify({ actorId }),
    }), env);
    expect((await put(`agent:${active.id}`))?.status).toBe(200);
    for (const profile of ["missing", foreign.id, foreign.slug, archived.id, archived.slug, deleted.id, deleted.slug]) {
      expect((await put(`agent:${profile}`))?.status).toBe(404);
    }
    const saved = await handlePrimaryBot(new Request(`https://worker.test/api/workspaces/${workspace.workspaceId}/primary-bot`), env);
    expect(await saved?.json()).toMatchObject({ actorId: `agent:${active.id}`, source: "saved" });
  });
});
