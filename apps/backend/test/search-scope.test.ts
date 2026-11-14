import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COLLAB_TENANT_ID } from "../src/collaboration-store.js";
import type { Env } from "../src/env.js";
import { handleSearch } from "../src/search-routes.js";
import { searchWorkspace } from "../src/workspace-search-store.js";
import { acceptTeamWorkspaceInvitation, createTeamWorkspace, createTeamWorkspaceInvitation } from "../src/team-workspaces-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const state = vi.hoisted(() => ({ userId: "ada@example.test" }));
vi.mock("../src/request-auth.js", async (original) => ({
  ...await original<typeof import("../src/request-auth.js")>(),
  isAuthorizedRequest: async () => true,
  resolveUserId: async () => state.userId,
}));

const FILES = ["0036_team_work_tasks.sql", "0052_search_fts.sql", "0053_ask_user_and_claims.sql", "0060_palette_search.sql"];
const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

const ADA = "ada@example.test";
const BEN = "ben@example.test";

function load(sqlite: DatabaseSync) {
  for (const file of FILES) sqlite.exec(readFileSync(join(import.meta.dirname, "../migrations", file), "utf8"));
}

function seed(sqlite: DatabaseSync, workspaceId: string) {
  const room = (id: string, title: string, by: string) => sqlite.prepare(
    `INSERT INTO collaboration_rooms (room_id, tenant_id, workspace_id, title, visibility, created_by_user_id, created_at)
     VALUES (?, ?, ?, ?, 'private', ?, 1)`,
  ).run(id, COLLAB_TENANT_ID, workspaceId, title, by);
  const member = (roomId: string, userId: string, kind: "human" | "agent", actorId: string) => sqlite.prepare(
    `INSERT INTO collaboration_memberships (
       tenant_id, workspace_id, room_id, user_id, display_name, actor_id, actor_kind, role, status, capabilities_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'member', 'active', '[]', 2)`,
  ).run(COLLAB_TENANT_ID, workspaceId, roomId, userId, userId, actorId, kind);
  const message = (roomId: string, id: string, userId: string, actorId: string, kind: "human" | "agent", body: string, at: number) => sqlite.prepare(
    `INSERT INTO collaboration_messages (
       message_id, tenant_id, workspace_id, room_id, sender_user_id, sender_actor_id, sender_kind, body, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, COLLAB_TENANT_ID, workspaceId, roomId, userId, actorId, kind, body, at);
  room("room_private", "Private R", ADA);
  room("room_public", "Public", ADA);
  room("room_dm", "Ada DM", ADA);
  member("room_private", ADA, "human", `human:${ADA}`);
  member("room_private", ADA, "agent", "agent:fixer");
  member("room_public", ADA, "human", `human:${ADA}`);
  member("room_public", BEN, "human", `human:${BEN}`);
  member("room_dm", ADA, "human", `human:${ADA}`);
  member("room_dm", ADA, "agent", "agent:fixer");
  for (let index = 0; index < 5; index += 1) message("room_private", `secret-${index}`, ADA, "agent:fixer", "agent", `badge secret note ${index} badge badge`, 10 + index);
  message("room_public", "public-1", BEN, `human:${BEN}`, "human", "badge public note", 1);
  message("room_dm", "dm-1", ADA, `human:${ADA}`, "human", "badge direct note", 3);
  sqlite.prepare(
    `INSERT INTO team_work_tasks (
       tenant_id, workspace_id, task_id, title, status, priority, waiting_on_json, context_json, done_when_json, activity_json,
       archived, created_by, version, created_at, updated_at, room_id
     ) VALUES (?, ?, 'task-bound', 'badge bound task', 'todo', 'none', '[]', '[]', '[]', '[]', 0, ?, 1, 4, 4, 'room_private')`,
  ).run(COLLAB_TENANT_ID, workspaceId, ADA);
  sqlite.prepare(
    `INSERT INTO team_work_tasks (
       tenant_id, workspace_id, task_id, title, status, priority, waiting_on_json, context_json, done_when_json, activity_json,
       archived, created_by, version, created_at, updated_at
     ) VALUES (?, ?, 'task-open', 'badge open task', 'todo', 'none', '[]', '[]', '[]', '[]', 0, ?, 1, 4, 4)`,
  ).run(COLLAB_TENANT_ID, workspaceId, ADA);
  sqlite.prepare(
    `INSERT INTO workspace_search_docs (tenant_id, workspace_id, doc_id, kind, title, body, updated_at, sender_actor_id)
     VALUES (?, ?, 'task-bound', 'task', 'badge bound task', 'bound body', 4, NULL),
            (?, ?, 'task-open', 'task', 'badge open task', 'open body', 4, NULL),
            (?, ?, 'run-ada', 'run', 'badge ada run', 'run body', 4, ?)`,
  ).run(COLLAB_TENANT_ID, workspaceId, COLLAB_TENANT_ID, workspaceId, COLLAB_TENANT_ID, workspaceId, `human:${ADA}`);
}

async function fixture() {
  const { database, sqlite } = customAgentD1();
  databases.push(sqlite);
  load(sqlite);
  const env = { AGENT_AUDIT: database } as unknown as Env;
  const workspace = await createTeamWorkspace(env, ADA, { name: "Palette" }, 1);
  const invite = await createTeamWorkspaceInvitation(env, workspace.workspaceId, ADA, { email: BEN, role: "member" }, 2);
  await acceptTeamWorkspaceInvitation(env, BEN, invite.token, 3);
  seed(sqlite, workspace.workspaceId);
  const ask = (userId: string, types = "chats,tasks") => {
    state.userId = userId;
    return handleSearch(new Request(`https://dashboard.test/api/search?q=badge&types=${types}&limit=1`, {
      headers: { "X-Shiba-Workspace": workspace.workspaceId },
    }), env);
  };
  return { env, sqlite, workspaceId: workspace.workspaceId, ask };
}

describe("membership-scoped search", () => {
  it("hides private rooms and direct messages from non-members and keeps LIMIT honest", async () => {
    const f = await fixture();
    const hidden = await searchWorkspace(f.env, f.workspaceId, "badge", BEN, 1, ["room", "message"]);
    expect(hidden.map((hit) => hit.id)).toEqual(["room_public:public-1"]);
    expect(hidden.some((hit) => hit.snippet.includes("secret") || hit.snippet.includes("direct"))).toBe(false);
    const visible = await searchWorkspace(f.env, f.workspaceId, "badge", ADA, 20);
    expect(visible.some((hit) => hit.id === "room_private:secret-4")).toBe(true);
    expect(visible.some((hit) => hit.id === "room_dm:dm-1")).toBe(true);
    expect(visible.some((hit) => hit.id === "task-bound")).toBe(true);
    const outsiderTasks = await searchWorkspace(f.env, f.workspaceId, "badge", BEN, 20, ["task", "run"]);
    expect(outsiderTasks.map((hit) => hit.id).sort()).toEqual(["task-open"]);
    const ownerRuns = await searchWorkspace(f.env, f.workspaceId, "badge", ADA, 20, ["run"]);
    expect(ownerRuns.map((hit) => hit.id)).toEqual(["run-ada"]);
  });

  it("returns chats and a Server-Timing duration", async () => {
    const f = await fixture();
    const response = await f.ask(ADA, "chats,tasks");
    expect(response?.status).toBe(200);
    expect(response?.headers.get("server-timing")).toMatch(/search;dur=\d+/);
    const body = await response?.json() as { chats: Array<{ roomId: string; snippet: string }>; bots: unknown[]; tasks: unknown[]; rooms: unknown[] };
    expect(body.bots).toEqual([]);
    expect(body.chats.length).toBeGreaterThan(0);
    expect(body.chats.every((hit) => hit.roomId === "room_private" || hit.roomId === "room_public" || hit.roomId === "room_dm")).toBe(true);
    expect(body.rooms.length).toBe(body.chats.length);
    const outsider = await f.ask(BEN, "chats");
    const hidden = await outsider?.json() as { chats: Array<{ snippet: string }> };
    expect(hidden.chats).toHaveLength(1);
    expect(hidden.chats[0]?.snippet).toContain("public");
  });
});
