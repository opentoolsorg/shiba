import type { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COLLAB_TENANT_ID } from "../src/collaboration-store.js";
import { createCustomAgent } from "../src/custom-agents-store.js";
import type { Env } from "../src/env.js";
import { handlePalette } from "../src/palette-routes.js";
import { acceptTeamWorkspaceInvitation, createTeamWorkspace, createTeamWorkspaceInvitation } from "../src/team-workspaces-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const state = vi.hoisted(() => ({ userId: "ada@example.test", sessions: [] as Array<{ id: string; name: string; updatedAt: number; metadata?: { customAgentId?: string } }> }));
vi.mock("../src/request-auth.js", async (original) => ({
  ...await original<typeof import("../src/request-auth.js")>(),
  isAuthorizedRequest: async () => true,
  resolveUserId: async () => state.userId,
}));
vi.mock("agents/routing", () => ({ getAgentByName: async () => ({ fetch: async () => Response.json({ sessions: state.sessions }) }) }));

const FILES = ["0036_team_work_tasks.sql", "0052_search_fts.sql", "0053_ask_user_and_claims.sql", "0060_palette_search.sql"];
const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); state.sessions = []; });

const ADA = "ada@example.test";
const BEN = "ben@example.test";

function load(sqlite: DatabaseSync) {
  for (const file of FILES) sqlite.exec(readFileSync(join(import.meta.dirname, "../migrations", file), "utf8"));
}

async function fixture() {
  const { database, sqlite } = customAgentD1();
  databases.push(sqlite);
  load(sqlite);
  const env = { AGENT_AUDIT: database, CodingOrchestrator: {} } as unknown as Env;
  const workspace = await createTeamWorkspace(env, ADA, { name: "Palette" }, 1);
  const invite = await createTeamWorkspaceInvitation(env, workspace.workspaceId, ADA, { email: BEN, role: "member" }, 2);
  await acceptTeamWorkspaceInvitation(env, BEN, invite.token, 3);
  const fixer = await createCustomAgent(env, `team:${workspace.workspaceId}`, "fixer", { name: "Fixer", instructions: "Edit the repo.", harness: "opencode" });
  const actor = `agent:${fixer.id}`;
  const addRoom = (id: string, title: string, members: string[]) => {
    sqlite.prepare(
      `INSERT INTO collaboration_rooms (room_id, tenant_id, workspace_id, title, visibility, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, 'private', ?, 1)`,
    ).run(id, COLLAB_TENANT_ID, workspace.workspaceId, title, ADA);
    for (const userId of members) sqlite.prepare(
      `INSERT INTO collaboration_memberships (
         tenant_id, workspace_id, room_id, user_id, display_name, actor_id, actor_kind, role, status, capabilities_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'human', 'member', 'active', '[]', 2)`,
    ).run(COLLAB_TENANT_ID, workspace.workspaceId, id, userId, userId, `human:${userId}`);
    sqlite.prepare(
      `INSERT INTO collaboration_memberships (
         tenant_id, workspace_id, room_id, user_id, display_name, actor_id, actor_kind, role, status, capabilities_json, created_at
       ) VALUES (?, ?, ?, ?, 'Fixer', ?, 'agent', 'agent', 'active', '[]', 2)`,
    ).run(COLLAB_TENANT_ID, workspace.workspaceId, id, ADA, actor);
  };
  addRoom("room_private", "Private R", [ADA]);
  addRoom("room_public", "Public", [ADA, BEN]);
  const say = (roomId: string, id: string, body: string, at: number) => sqlite.prepare(
    `INSERT INTO collaboration_messages (
       message_id, tenant_id, workspace_id, room_id, sender_user_id, sender_actor_id, sender_kind, body, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'agent', ?, ?)`,
  ).run(id, COLLAB_TENANT_ID, workspace.workspaceId, roomId, ADA, actor, body, at);
  say("room_public", "pub", "public standup", 10);
  say("room_private", "priv", "rotate the badge", 20);
  const call = (userId: string, path: string, method = "GET", body?: unknown) => {
    state.userId = userId;
    return handlePalette(new Request(`https://dashboard.test${path}`, {
      method,
      headers: { Origin: "https://dashboard.test", "Content-Type": "application/json", "X-Shiba-Workspace": workspace.workspaceId },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
  };
  return { env, sqlite, workspace, fixer, actor, call };
}

describe("palette bots", () => {
  it("previews only rooms the viewer belongs to and falls back to a session", async () => {
    const f = await fixture();
    const ada = await (await f.call(ADA, "/api/palette/bots"))?.json() as { bots: Array<{ preview: string | null; unread: null; state: string }> };
    expect(ada.bots[0]?.preview).toBe("rotate the badge");
    expect(ada.bots[0]?.unread).toBeNull();
    const ben = await (await f.call(BEN, "/api/palette/bots"))?.json() as { bots: Array<{ preview: string | null }> };
    expect(ben.bots[0]?.preview).toBe("public standup");
    expect(ben.bots[0]?.preview).not.toContain("badge");
    f.sqlite.prepare("DELETE FROM collaboration_messages").run();
    f.sqlite.prepare("DELETE FROM bot_room_activity").run();
    state.sessions = [{ id: "sess-1", name: "Planning", updatedAt: 40, metadata: { customAgentId: f.fixer.id } }, { id: "sess-0", name: "Older", updatedAt: 10, metadata: { customAgentId: f.fixer.id } }];
    const fallback = await (await f.call(BEN, "/api/palette/bots"))?.json() as { bots: Array<{ preview: string | null; roomId: string | null }> };
    expect(fallback.bots[0]?.preview).toBe("Last chat · Planning");
    expect(fallback.bots[0]?.roomId).toBeNull();
  });

  it("keeps pin slots unique per viewer", async () => {
    const f = await fixture();
    const other = await createCustomAgent(f.env, `team:${f.workspace.workspaceId}`, "reviewer", { name: "Reviewer", instructions: "Read diffs.", harness: "opencode" });
    expect((await f.call(ADA, "/api/palette/pins/1", "PUT", { actorId: f.actor }))?.status).toBe(200);
    expect((await f.call(ADA, "/api/palette/pins/1", "PUT", { actorId: `agent:${other.id}` }))?.status).toBe(200);
    expect((await f.call(ADA, "/api/palette/pins/2", "PUT", { actorId: `agent:${other.id}` }))?.status).toBe(200);
    expect((await f.call(ADA, "/api/palette/pins/0", "PUT", { actorId: f.actor }))).toBeNull();
    const pins = f.sqlite.prepare("SELECT slot, actor_id FROM palette_pins WHERE user_id = ? ORDER BY slot").all(ADA) as Array<{ slot: number; actor_id: string }>;
    expect(pins).toEqual([{ slot: 2, actor_id: `agent:${other.id}` }]);
    expect((await f.call(BEN, "/api/palette/pins/2", "PUT", { actorId: f.actor }))?.status).toBe(200);
    expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM palette_pins WHERE user_id = ? AND slot = 2").get(BEN)).toMatchObject({ n: 1 });
    expect((await f.call(ADA, "/api/palette/pins/2", "DELETE"))?.status).toBe(200);
    expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM palette_pins WHERE user_id = ?").get(ADA)).toMatchObject({ n: 0 });
  });
});
