import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { humanActorId } from "../src/collaboration-store.js";
import type { Env } from "../src/env.js";
import { handleTeamWork, type TeamWorkItemDto } from "../src/team-work-routes.js";
import { acceptTeamWorkspaceInvitation, createTeamWorkspace, createTeamWorkspaceInvitation } from "../src/team-workspaces-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const state = vi.hoisted(() => ({ userId: "member@example.test" }));
vi.mock("../src/request-auth.js", async (original) => ({
  ...await original<typeof import("../src/request-auth.js")>(),
  isAuthorizedRequest: async () => true,
  resolveUserId: async () => state.userId,
}));

const OWNER = "owner@example.test", MEMBER = "member@example.test", OTHER = "other@example.test";
const databases: DatabaseSync[] = [];
afterEach(() => { state.userId = MEMBER; for (const database of databases.splice(0)) database.close(); });

async function fixture(withEvents = false) {
  const { database, sqlite } = customAgentD1(); databases.push(sqlite);
  sqlite.exec(readFileSync(new URL("../migrations/0052_search_fts.sql", import.meta.url), "utf8"));
  const env = { AGENT_AUDIT: database } as unknown as Env;
  const frames: Array<{ kind: string; audience: { userIds: string[] } }> = [];
  if (withEvents) env.WorkspaceEvents = { getByName: () => ({ fetch: async (request: Request) => {
    frames.push(await request.json() as typeof frames[number]);
    return Response.json({ ok: true });
  } }) } as unknown as NonNullable<Env["WorkspaceEvents"]>;
  const workspace = await createTeamWorkspace(env, OWNER, { name: "Product" }, 1);
  const invite = await createTeamWorkspaceInvitation(env, workspace.workspaceId, OWNER, { email: MEMBER, role: "member" }, 2);
  await acceptTeamWorkspaceInvitation(env, MEMBER, invite.token, 3);
  const send = async (method: string, suffix = "", body?: unknown, headers: Record<string, string> = {}) => {
    const response = await handleTeamWork(new Request(`https://dashboard.test/api/workspaces/${workspace.workspaceId}/work${suffix}`, {
      method, headers: { Origin: "https://dashboard.test", "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
    if (!response) throw new Error("Expected the Work route to handle this request.");
    return { status: response.status, body: await response.json() as { task: TeamWorkItemDto; tasks: TeamWorkItemDto[]; error?: string } };
  };
  const create = async (title = "Draft launch notes") => {
    const created = await send("POST", "", { title });
    expect(created.status).toBe(201);
    return created.body.task;
  };
  return { send, create, frames };
}

describe("writable shared Work tasks", () => {
  it("names current workspace members for task live events", async () => {
    const f = await fixture(true);
    const task = await f.create();
    await f.send("PATCH", `/${task.id}`, { patch: { status: "done" } });
    await vi.waitFor(() => expect(f.frames).toHaveLength(2));
    expect(f.frames.map((frame) => frame.kind)).toEqual(["task.created", "task.updated"]);
    for (const frame of f.frames) expect(frame.audience.userIds.sort()).toEqual([MEMBER, OWNER].sort());
  });

  it("creates, edits, comments on and archives a task with recorded activity", async () => {
    const f = await fixture();
    const task = await f.create();
    expect(task).toMatchObject({ title: "Draft launch notes", status: "todo", priority: "medium", blocked: false, archived: false });
    expect(task.id).toMatch(/^task_[a-f0-9]{24}$/);
    expect(task.activity).toEqual([expect.objectContaining({ kind: "created", actorId: humanActorId(MEMBER) })]);

    const parent = await f.create("Launch");
    const patched = await f.send("PATCH", `/${task.id}`, { patch: {
      status: "in-progress", ownerId: humanActorId(OWNER), reviewerId: "agent:writer", priority: "high",
      startDate: "2026-11-02", endDate: "2026-11-09", parentId: parent.id, blocked: true,
      objective: "Ship the notes", waitingOn: ["Legal"], context: ["Draft doc"], doneWhen: ["Published"],
    } });
    expect(patched.status).toBe(200);
    expect(patched.body.task).toMatchObject({
      status: "in-progress", ownerId: humanActorId(OWNER), assigneeActorId: humanActorId(OWNER), assigneeKind: "human",
      assigneeUserId: OWNER, reviewerId: "agent:writer", priority: "high", startDate: "2026-11-02", endDate: "2026-11-09",
      parentId: parent.id, blocked: true, objective: "Ship the notes", waitingOn: ["Legal"], context: ["Draft doc"], doneWhen: ["Published"],
    });
    expect(patched.body.task.activity?.filter((entry) => entry.kind === "change")).toHaveLength(12);

    state.userId = OWNER;
    const commented = await f.send("POST", `/${task.id}/comments`, { text: "Looks good" });
    expect(commented.status).toBe(200);
    expect(commented.body.task.activity?.at(-1)).toMatchObject({ kind: "comment", actorId: humanActorId(OWNER), text: "Looks good" });

    const cleared = await f.send("PATCH", `/${task.id}`, { patch: { ownerId: null, parentId: null } });
    expect(cleared.body.task.ownerId).toBeUndefined();
    expect(cleared.body.task.parentId).toBeUndefined();

    let listed = await f.send("GET");
    expect(listed.status).toBe(200);
    expect(listed.body.tasks.map((item) => item.id).sort()).toEqual([task.id, parent.id].sort());
    expect(listed.body.tasks.find((item) => item.id === task.id)).toMatchObject({ status: "in-progress", objective: "Ship the notes" });

    const archived = await f.send("POST", `/${task.id}/archive`, {});
    expect(archived.body.task.archived).toBe(true);
    listed = await f.send("GET");
    expect(listed.body.tasks.map((item) => item.id)).toEqual([parent.id]);
    expect((await f.send("PATCH", `/${task.id}`, { patch: { status: "done" } })).status).toBe(404);
  });

  it("accepts optional patch fields when creating a task", async () => {
    const f = await fixture();
    const created = await f.send("POST", "", { title: "Review copy", status: "in-review", priority: "urgent", ownerId: "agent:writer", doneWhen: ["Approved"] });
    expect(created.status).toBe(201);
    expect(created.body.task).toMatchObject({ title: "Review copy", status: "in-review", priority: "urgent", assigneeKind: "agent",
      assigneeActorId: "agent:writer", doneWhen: ["Approved"], archived: false });
    expect(created.body.task.activity?.map((entry) => entry.kind)).toEqual(["created", "change", "change", "change", "change"]);
  });

  it("rejects non-members with 403 on every write and hides the workspace on read", async () => {
    const f = await fixture();
    const task = await f.create();
    state.userId = OTHER;
    expect((await f.send("POST", "", { title: "Intrude" })).status).toBe(403);
    expect((await f.send("PATCH", `/${task.id}`, { patch: { status: "done" } })).status).toBe(403);
    expect((await f.send("POST", `/${task.id}/comments`, { text: "hi" })).status).toBe(403);
    expect((await f.send("POST", `/${task.id}/archive`, {})).status).toBe(403);
    expect((await f.send("GET")).status).toBe(404);
  });

  it("validates bodies, methods and origin", async () => {
    const f = await fixture();
    const task = await f.create();
    for (const body of [{}, { title: "" }, { title: "x".repeat(201) }, { title: "ok", extra: 1 }, { title: "ok", status: "shipped" },
      { title: "ok", ownerId: humanActorId(OTHER) }, { title: "ok", parentId: `task_${"0".repeat(24)}` },
      { title: "ok", startDate: "2026-11-09", endDate: "2026-11-02" }]) {
      expect((await f.send("POST", "", body)).status).toBe(400);
    }
    expect((await f.send("GET")).body.tasks).toHaveLength(1);
    for (const patch of [{}, { status: "shipped" }, { unknown: 1 }, { startDate: "11/02/2026" }, { ownerId: "nobody" },
      { ownerId: humanActorId(OTHER) }, { parentId: task.id }, { startDate: "2026-11-09", endDate: "2026-11-02" }]) {
      expect((await f.send("PATCH", `/${task.id}`, { patch })).status).toBe(400);
    }
    expect((await f.send("POST", `/${task.id}/comments`, { text: "   " })).status).toBe(400);
    expect((await f.send("PATCH", `/task_${"0".repeat(24)}`, { patch: { status: "done" } })).status).toBe(404);
    expect((await f.send("POST", `/${task.id}`, { patch: { status: "done" } })).status).toBe(405);
    expect((await f.send("POST", "", { title: "x" }, { Origin: "https://evil.test" })).status).toBe(403);
    expect((await f.send("POST", "", { title: "x" }, { "Content-Type": "text/plain" })).status).toBe(415);
  });
});
