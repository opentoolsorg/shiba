import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInputHash, type DelegatedRun } from "@shiba/shared";
import { handleCollaborationLive, type CollaborationLiveScopeResolver } from "../src/collaboration-live-routes.js";
import { bindCollaborationContextApproval, freezeCollaborationContext } from "../src/collaboration-context.js";
import { createCollaborationMemory, revokeCollaborationMemory } from "../src/collaboration-memory.js";
import { addCollaborationMember, createCollaborationRoom, createCollaborationSlackLink, createRootCollaborationHandoff, humanActorId,
  linkCollaborationHandoffRun, observeCollaborationSlackThread, pinCollaborationHandoffExecutor, type CollaborationHandoffRow } from "../src/collaboration-store.js";
import { ConversationRoom, type RunRoomReplay } from "../src/conversation-room-do.js";
import { INTERNAL_SIGNATURE_HEADER, verifyInternalRequest } from "../src/edge-identity.js";
import type { Env } from "../src/env.js";
import { MAX_RUN_ROOM_EVENTS, type RunRoomIdentity } from "../src/run-room-events.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { acceptTeamWorkspaceInvitation, createTeamWorkspace, createTeamWorkspaceInvitation } from "../src/team-workspaces-store.js";

const state = vi.hoisted(() => ({ runs: new Map<string, DelegatedRun>(), names: [] as string[], requests: [] as Request[] }));
vi.mock("../src/request-auth.js", () => ({
  isAuthorizedRequest: async (request: Request) => request.headers.get("Authorization") === "Bearer fixture",
  resolveUserId: async (request: Request) => request.headers.get("X-Fixture-User"),
}));
vi.mock("agents/routing", () => ({ getAgentByName: async (_namespace: unknown, name: string) => {
  state.names.push(name);
  return { fetch: async (request: Request) => {
    state.requests.push(request);
    const runId = decodeURIComponent(new URL(request.url).pathname.split("/").pop()!);
    const run = state.runs.get(`${name}|${runId}`);
    return run ? Response.json({ run }) : Response.json({ error: "Not found" }, { status: 404 });
  } };
} }));

const OWNER = "owner@example.test";
const EXECUTOR = "Owner@Example.Test";
const TEAM_SESSION = "11111111-1111-4111-8111-111111111111";
const TEAM_EXECUTOR = `web:${EXECUTOR}:${TEAM_SESSION}`;
const MEMBER = "member@example.test";
const ROOM = `room_${"a".repeat(24)}`;
const HANDOFF = "handoff-task";
const APPROVAL = "approval-task";
const RUN = `agent-tool:${APPROVAL}`;
const scope = { tenantId: "self-hosted", workspaceId: "default", userId: OWNER };
const databases: DatabaseSync[] = [];
beforeEach(() => { state.runs.clear(); state.names.length = 0; state.requests.length = 0; });
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

async function fixture(selectedSource = false, teamWorkspace = false) {
  const { database, sqlite } = customAgentD1();
  databases.push(sqlite);
  let duringRead: (() => void | Promise<void>) | undefined;
  let response: RunRoomReplay = {
    runId: RUN, after: 0, oldest: 1, latest: 4, nextCursor: 4, hasMore: false, gap: false,
    frames: [
      { type: "run:event", sequence: 1, eventId: crypto.randomUUID(), runId: RUN, createdAt: 1, event: { kind: "terminal", stream: "stdout", data: "Approved output\n" } },
      { type: "run:event", sequence: 2, eventId: crypto.randomUUID(), runId: RUN, createdAt: 1, event: { kind: "diff", data: "+ approved change", reset: true, complete: true } },
      { type: "run:event", sequence: 3, eventId: crypto.randomUUID(), runId: RUN, createdAt: 1, event: { kind: "child", childId: "reviewer", status: "completed" } },
      { type: "run:event", sequence: 4, eventId: crypto.randomUUID(), runId: RUN, createdAt: 1, event: { kind: "status", status: "running" } },
    ],
  };
  const readRunEvents = vi.fn(async (_identity: RunRoomIdentity, after: number) => {
    await duringRead?.();
    return { ...response, after };
  });
  const roomNames: string[] = [];
  const env = { AGENT_AUDIT: database, CodingOrchestrator: {}, INTERNAL_SIGNING_KEY: "fixture-worker-only-internal-signing-key",
    ConversationRoom: { getByName: (name: string) => { roomNames.push(name); return { readRunEvents }; } },
  } as unknown as Env;
  const roomScope = { ...scope };
  if (teamWorkspace) {
    const workspace = await createTeamWorkspace(env, OWNER, { name: "Task team" });
    roomScope.workspaceId = workspace.workspaceId;
    const invite = await createTeamWorkspaceInvitation(env, workspace.workspaceId, OWNER, { email: MEMBER, role: "member" });
    await acceptTeamWorkspaceInvitation(env, MEMBER, invite.token);
  }
  await createCollaborationRoom(env, roomScope, { roomId: ROOM, title: "Shared task", visibility: "shared", createdAt: 1 });
  for (const [userId, actorId, kind] of [[MEMBER, humanActorId(MEMBER), "human"], [OWNER, "agent:writer", "agent"]] as const) {
    expect(await addCollaborationMember(env, roomScope, ROOM, { userId, actorId, kind, displayName: actorId, profileVersion: 1, createdAt: 2 })).toBe(true);
  }
  const handoff: CollaborationHandoffRow = { ...roomScope, handoffId: HANDOFF, roomId: ROOM, taskId: "task", senderUserId: OWNER,
    senderActorId: humanActorId(OWNER), recipientUserId: OWNER, recipientActorId: "agent:writer", parentHandoffId: null,
    rootHandoffId: HANDOFF, depth: 0, ancestorHandoffIds: [], remainingBudget: 0, grantedCapabilities: ["room.read"],
    profileVersion: 1, status: "active", createdAt: 3, cancelledAt: null };
  expect(await createRootCollaborationHandoff(env, roomScope, handoff)).not.toBeNull();
  let task = "Implement the approved room task.";
  let note: Awaited<ReturnType<typeof createCollaborationMemory>> | undefined;
  if (selectedSource) {
    note = await createCollaborationMemory(env, roomScope, ROOM, { id: "ctx_release", title: "Release", content: "The release is Tuesday." }, 4);
    task = (await freezeCollaborationContext(env, roomScope, ROOM, HANDOFF, task, [], [{ id: note.id, version: note.version, sha256: note.sha256 }])).task;
    await bindCollaborationContextApproval(env, HANDOFF, APPROVAL, task);
  }
  const executorName = teamWorkspace ? TEAM_EXECUTOR : EXECUTOR;
  expect(await pinCollaborationHandoffExecutor(env, roomScope, HANDOFF, executorName)).toBe(true);
  expect(await linkCollaborationHandoffRun(env, roomScope, HANDOFF, APPROVAL, RUN)).toBe(true);
  const run: DelegatedRun = { runId: RUN, sandboxId: "sandbox-task", repoUrl: "https://github.com/example/repo", task, baseBranch: "main",
    publishPullRequest: false, status: "running", generation: 1, createdAt: 4, updatedAt: 5,
    ...(teamWorkspace ? { orgId: `team:${roomScope.workspaceId}` } : {}),
    customAgentId: "writer", customAgentVersion: 1, collaborationHandoffId: HANDOFF };
  run.approval = { approvalId: APPROVAL, decidedBy: OWNER, decidedAt: 5, inputHash: runInputHash(run) };
  state.runs.set(`${executorName}|${RUN}`, run);
  const send = (user = MEMBER, query = "", headers: Record<string, string> = {}, method = "GET", resolver?: CollaborationLiveScopeResolver) =>
    handleCollaborationLive(new Request(`https://dashboard.test/api/collaboration/rooms/${ROOM}/handoffs/${HANDOFF}/live${query}`, {
      method, headers: { Authorization: "Bearer fixture", "X-Fixture-User": user, "X-Agent-Principal": "spoof", Cookie: "private", ...headers },
    }), env, resolver);
  return { env, sqlite, run, note, readRunEvents, roomNames, send, roomScope, executorName,
    duringRead: (callback: () => void | Promise<void>) => { duringRead = callback; },
    replay: (value: RunRoomReplay) => { response = value; }, response,
  };
}

describe("shared room execution HTTP replay", () => {
  it("serves only approved trusted frames to active humans without owner credentials or room URLs", async () => {
    const f = await fixture(true);
    const response = await f.send();
    expect(response?.status).toBe(200);
    expect(response?.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await response!.json() as Record<string, unknown>;
    expect(body).toMatchObject({ roomId: ROOM, handoffId: HANDOFF, runId: RUN, runtime: "sandbox", readOnly: true,
      source: "trusted-run-journal", nextCursor: 4, frames: f.response.frames });
    expect(JSON.stringify(body)).not.toContain(OWNER);
    expect(JSON.stringify(body)).not.toMatch(/websocket|Cookie|roomUrl|sandbox-task/);
    expect(f.roomNames).toEqual([JSON.stringify([OWNER, "default"])]);
    expect(f.readRunEvents).toHaveBeenCalledWith({ ownerId: EXECUTOR, sessionId: "default", runId: RUN }, 0, 256);
    expect(state.names).toEqual([EXECUTOR]);
    for (const request of state.requests) {
      expect(request.headers.has(INTERNAL_SIGNATURE_HEADER)).toBe(true);
      expect(request.headers.has("X-Agent-Principal")).toBe(false);
      expect(request.headers.has("Authorization")).toBe(false);
      expect(request.headers.has("Cookie")).toBe(false);
      expect((await verifyInternalRequest(request, f.env)).ok).toBe(true);
    }
  });

  it("rejects outsiders and removed members before reading the executor or journal", async () => {
    const f = await fixture();
    expect((await f.send("outsider@example.test"))?.status).toBe(404);
    f.sqlite.prepare("UPDATE collaboration_memberships SET status='removed' WHERE actor_id=?").run(humanActorId(MEMBER));
    expect((await f.send())?.status).toBe(404);
    expect(state.names).toHaveLength(0);
    expect(f.readRunEvents).not.toHaveBeenCalled();
  });

  it.each(["room-member", "source", "handoff", "workspace", "run-hash"])("denies %s changes during the journal await", async (kind) => {
    const f = await fixture(true);
    let workspaceActive = true;
    const resolver: CollaborationLiveScopeResolver = async () => workspaceActive ? { ...scope, userId: MEMBER } : null;
    f.duringRead(async () => {
      if (kind === "room-member") f.sqlite.prepare("UPDATE collaboration_memberships SET status='removed' WHERE actor_id=?").run(humanActorId(MEMBER));
      if (kind === "source") await revokeCollaborationMemory(f.env, scope, ROOM, { id: f.note!.id, version: 1 }, 10);
      if (kind === "handoff") f.sqlite.prepare("UPDATE collaboration_handoffs SET status='cancelled'").run();
      if (kind === "workspace") workspaceActive = false;
      if (kind === "run-hash") f.run.task = "Different work";
    });
    const response = await f.send(MEMBER, "", {}, "GET", resolver);
    expect(response?.status).toBe(404);
    expect(await response!.text()).not.toContain("Approved output");
  });

  it.each(["customAgentId", "customAgentVersion", "collaborationHandoffId", "approval", "task"])("rejects mismatched %s proof", async (field) => {
    const f = await fixture();
    Object.assign(f.run, { [field]: field === "customAgentVersion" ? 2 : field === "approval" ? { ...f.run.approval, decidedBy: "automation:run" } : "other" });
    expect((await f.send())?.status).toBe(404);
    expect(f.readRunEvents).not.toHaveBeenCalled();
  });

  it("rejects every reserved autonomous identity before journal replay", async () => {
    const f = await fixture();
    for (const actor of ["default", "system", "automation", "agent", "mcp", "child", "subagent", " System ", "automation:daily"]) {
      f.run.approval!.decidedBy = actor;
      expect((await f.send())?.status, actor).toBe(404);
    }
    expect(f.readRunEvents).not.toHaveBeenCalled();
  });

  it("requires the exact executor pin, with no session guessing or default owner fallback", async () => {
    const f = await fixture();
    for (const executor of [null, "other@example.test", `web:${OWNER}:11111111-1111-4111-8111-111111111111`]) {
      f.sqlite.prepare("UPDATE collaboration_handoffs SET executor_agent_name=?").run(executor);
      expect((await f.send())?.status).toBe(404);
    }
    expect(state.names).toHaveLength(0);
    expect(f.readRunEvents).not.toHaveBeenCalled();
  });

  it("rejects explicit workspace selection unless its checked resolver grants the exact scope", async () => {
    const f = await fixture();
    expect((await f.send(MEMBER, "", { "X-Shiba-Workspace": `ws_${"b".repeat(24)}` }))?.status).toBe(404);
    const wrongScope: CollaborationLiveScopeResolver = async () => ({ ...scope, workspaceId: `ws_${"b".repeat(24)}`, userId: MEMBER });
    expect((await f.send(MEMBER, "", {}, "GET", wrongScope))?.status).toBe(404);
    const otherHuman: CollaborationLiveScopeResolver = async () => ({ ...scope, userId: OWNER });
    expect((await f.send(MEMBER, "", {}, "GET", otherHuman))?.status).toBe(404);
    expect(f.readRunEvents).not.toHaveBeenCalled();
  });

  it("rechecks the exact Slack audience, including changes while fetching retained output", async () => {
    const f = await fixture();
    f.env.SLACK_CANVAS_OWNERS = JSON.stringify([{ teamId: "T1", channelId: "C1", ownerId: OWNER, viewerIds: [MEMBER] }]);
    await observeCollaborationSlackThread(f.env, { teamId: "T1", channelId: "C1", threadTs: "1700000000.001", eventId: "event1", userId: "U1", seenAt: Date.now() });
    expect(await createCollaborationSlackLink(f.env, scope, { linkId: "link1", roomId: ROOM, teamId: "T1", channelId: "C1", threadTs: "1700000000.001", createdAt: Date.now() })).not.toBeNull();
    f.duringRead(() => { f.env.SLACK_CANVAS_OWNERS = undefined; });
    expect((await f.send())?.status).toBe(404);
  });

  it("serves a selected team workspace only to its current members and never falls back across workspaces", async () => {
    const f = await fixture(true, true);
    const ws = f.roomScope.workspaceId;
    expect((await f.send())?.status).toBe(404);
    expect((await f.send(MEMBER, `?workspaceId=${ws}`))?.status).toBe(200);
    expect((await f.send(MEMBER, "", { "X-Shiba-Workspace": ws }))?.status).toBe(200);
    const other = await createTeamWorkspace(f.env, OWNER, { name: "Other team" });
    expect((await f.send(OWNER, "", { "X-Shiba-Workspace": other.workspaceId }))?.status).toBe(404);
    expect((await f.send(MEMBER, "?workspaceId=default", { "X-Shiba-Workspace": ws }))?.status).toBe(404);
    f.duringRead(() => { f.sqlite.prepare("UPDATE team_workspace_memberships SET status='removed' WHERE workspace_id=? AND user_id=?").run(ws, MEMBER); });
    expect((await f.send(MEMBER, "", { "X-Shiba-Workspace": ws }))?.status).toBe(404);
  });

  it("uses only the saved isolated team executor and its exact session journal, ignoring client routing claims", async () => {
    const f = await fixture(true, true);
    const response = await f.send(MEMBER, "", { "X-Shiba-Workspace": f.roomScope.workspaceId,
      "x-shiba-room-owner": "attacker@example.test", "x-shiba-room-session": "default", "x-shiba-executor": OWNER });
    expect(response?.status).toBe(200);
    expect(state.names).toEqual([TEAM_EXECUTOR]);
    expect(f.roomNames).toEqual([JSON.stringify([OWNER, TEAM_SESSION])]);
    expect(f.readRunEvents).toHaveBeenCalledWith({ ownerId: EXECUTOR, sessionId: TEAM_SESSION, runId: RUN }, 0, 256);
    const body = await response!.text();
    expect(body).not.toContain(TEAM_EXECUTOR);
    expect(body).not.toContain(TEAM_SESSION);
    expect(body).not.toMatch(/roomUrl|websocket|attacker@example/);
    for (const request of state.requests) {
      expect(request.headers.has("x-shiba-executor")).toBe(false);
      expect(request.headers.has("x-shiba-room-owner")).toBe(false);
      expect((await verifyInternalRequest(request, f.env)).ok).toBe(true);
    }
  });

  it.each([OWNER, EXECUTOR, null, `web:attacker@example.test:${TEAM_SESSION}`, `web:${OWNER}:default`, `web:${OWNER}:not-a-session`])(
    "rejects a base, missing or forged team executor pin %s before any private lookup", async (pin) => {
      const f = await fixture(false, true);
      f.sqlite.prepare("UPDATE collaboration_handoffs SET executor_agent_name=?").run(pin);
      expect((await f.send(MEMBER, "", { "X-Shiba-Workspace": f.roomScope.workspaceId }))?.status).toBe(404);
      expect(state.names).toHaveLength(0);
      expect(f.readRunEvents).not.toHaveBeenCalled();
    });

  it("never searches a base-owner store when the saved isolated run is absent", async () => {
    const f = await fixture(false, true);
    state.runs.delete(`${TEAM_EXECUTOR}|${RUN}`);
    state.runs.set(`${EXECUTOR}|${RUN}`, f.run);
    expect((await f.send(MEMBER, "", { "X-Shiba-Workspace": f.roomScope.workspaceId }))?.status).toBe(404);
    expect(state.names).toEqual([TEAM_EXECUTOR]);
    expect(f.readRunEvents).not.toHaveBeenCalled();
  });

  it.each(["room-grant", "executor-pin"])("rechecks a changed team %s after isolated journal read", async (change) => {
    const f = await fixture(true, true);
    f.duringRead(() => {
      if (change === "room-grant") f.sqlite.prepare("UPDATE collaboration_memberships SET status='removed' WHERE workspace_id=? AND actor_id=?").run(f.roomScope.workspaceId, humanActorId(MEMBER));
      else f.sqlite.prepare("UPDATE collaboration_handoffs SET executor_agent_name=?").run(`web:${EXECUTOR}:22222222-2222-4222-8222-222222222222`);
    });
    const response = await f.send(MEMBER, "", { "X-Shiba-Workspace": f.roomScope.workspaceId });
    expect(response?.status).toBe(404);
    expect(await response!.text()).not.toContain("Approved output");
    expect(f.roomNames).toEqual([JSON.stringify([OWNER, TEAM_SESSION])]);
  });

  it("rejects an injected other-run frame rather than leaking any partial response", async () => {
    const f = await fixture();
    f.replay({ ...f.response, frames: [{ ...f.response.frames[0]!, runId: "private-other-run" }] });
    expect((await f.send())?.status).toBe(503);
  });

  it("retains cursor, pagination and retention-gap indicators", async () => {
    const f = await fixture();
    f.replay({ ...f.response, oldest: 3, latest: 5, frames: f.response.frames.slice(2), hasMore: true, gap: true });
    const response = await f.send(MEMBER, "?after=2");
    expect(response?.status).toBe(200);
    expect(await response!.json()).toMatchObject({ after: 2, oldest: 3, latest: 5, nextCursor: 4, gap: true, hasMore: true });
  });

  it.each(["?after=-1", "?after=1.5", "?after=01", "?after=9007199254740992", "?after=1&after=2", "?runId=other"])("rejects invalid cursor/selectors %s", async (query) => {
    const f = await fixture();
    expect((await f.send(MEMBER, query))?.status).toBe(400);
    expect(f.readRunEvents).not.toHaveBeenCalled();
  });

  it("exposes no client write/control path and enforces authentication and same-origin reads", async () => {
    const f = await fixture();
    for (const method of ["POST", "PATCH", "DELETE"]) expect((await f.send(MEMBER, "", {}, method))?.status).toBe(405);
    expect((await f.send(MEMBER, "", { Authorization: "" }))?.status).toBe(401);
    expect((await f.send(MEMBER, "", { Origin: "https://evil.test" }))?.status).toBe(403);
    expect((await f.send(MEMBER, "", { "Sec-Fetch-Site": "cross-site" }))?.status).toBe(403);
    expect(f.readRunEvents).not.toHaveBeenCalled();
  });
});

function durableFixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const ctx = { storage: { sql: { exec<T>(sql: string, ...values: SQLInputValue[]) {
    const rows = db.prepare(sql).all(...values) as T[];
    return { toArray: () => rows };
  } } }, getWebSockets: () => [] } as unknown as DurableObjectState;
  const room = new ConversationRoom(ctx, {} as Env);
  const identity = { ownerId: OWNER, sessionId: "default", runId: RUN };
  return { room, db, ctx, identity };
}

describe("binding-only bounded run replay", () => {
  it("reads exactly one persisted run after object restart without including private chat or other runs", async () => {
    const f = durableFixture();
    await f.room.appendRunEvent(f.identity, crypto.randomUUID(), { kind: "terminal", stream: "stdout", data: "shared" });
    await f.room.appendRunEvent({ ...f.identity, runId: "other" }, crypto.randomUUID(), { kind: "terminal", stream: "stdout", data: "private" });
    await f.room.appendRunEvent(f.identity, crypto.randomUUID(), { kind: "status", status: "completed" });
    f.db.prepare("INSERT INTO room_messages VALUES (?,?,?,?)").run("private", "owner", "private chat", 1);
    const restarted = new ConversationRoom(f.ctx, {} as Env);
    const replay = await restarted.readRunEvents(f.identity, 0);
    expect(replay.frames.map((frame) => frame.sequence)).toEqual([1, 3]);
    expect(replay).toMatchObject({ nextCursor: 3, oldest: 1, latest: 3, hasMore: false, gap: false });
    expect(JSON.stringify(replay)).not.toContain("private");
    await expect(restarted.readRunEvents({ ...f.identity, ownerId: MEMBER }, 0)).rejects.toThrow("identity");
    await expect(restarted.readRunEvents({ ...f.identity, sessionId: crypto.randomUUID() }, 0)).rejects.toThrow("identity");
  });

  it("bounds pages, resumes without duplicates, and signals an expired or future cursor", async () => {
    const f = durableFixture();
    for (let index = 0; index < MAX_RUN_ROOM_EVENTS + 2; index++) {
      await f.room.appendRunEvent(f.identity, crypto.randomUUID(), { kind: "status", status: "running" });
    }
    const page = await f.room.readRunEvents(f.identity, 0);
    expect(page.frames).toHaveLength(256);
    expect(page).toMatchObject({ gap: true, hasMore: true, oldest: 3, latest: MAX_RUN_ROOM_EVENTS + 2, nextCursor: 258 });
    const next = await f.room.readRunEvents(f.identity, page.nextCursor);
    expect(next.frames[0]!.sequence).toBe(259);
    expect(next.gap).toBe(false);
    const future = await f.room.readRunEvents(f.identity, MAX_RUN_ROOM_EVENTS + 100);
    expect(future.gap).toBe(true);
    expect(future.frames[0]!.sequence).toBe(3);
    await expect(f.room.readRunEvents(f.identity, -1)).rejects.toThrow("Invalid");
    await expect(f.room.readRunEvents(f.identity, 0, 257)).rejects.toThrow("Invalid");
  });

  it("does not create a room identity through reads", async () => {
    const f = durableFixture();
    expect(await f.room.readRunEvents(f.identity, 0)).toMatchObject({ frames: [], nextCursor: 0, gap: false, hasMore: false });
    expect(f.db.prepare("SELECT * FROM room_identity").all()).toHaveLength(0);
  });
});
