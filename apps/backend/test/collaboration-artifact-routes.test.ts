import { beforeEach, describe, expect, it, vi } from "vitest";
import { runInputHash, type DelegatedRun } from "@shiba/shared";
import { handleCollaborationArtifact } from "../src/collaboration-artifact-routes.js";
import { bindCollaborationContextApproval, freezeCollaborationContext } from "../src/collaboration-context.js";
import { createCollaborationMemory, revokeCollaborationMemory } from "../src/collaboration-memory.js";
import {
  addCollaborationMember, createCollaborationAgentReply, createCollaborationRoom, createCollaborationSlackLink,
  createRootCollaborationHandoff, humanActorId, linkCollaborationHandoffRun, observeCollaborationSlackThread,
  pinCollaborationHandoffExecutor, type CollaborationHandoffRow,
} from "../src/collaboration-store.js";
import { INTERNAL_SIGNATURE_HEADER, verifyInternalRequest } from "../src/edge-identity.js";
import type { Env } from "../src/env.js";
import { deliverableStorageKey, persistRunDeliverables, verifyExpectedDeliverables } from "../src/run-deliverables.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { acceptTeamWorkspaceInvitation, createTeamWorkspace, createTeamWorkspaceInvitation } from "../src/team-workspaces-store.js";

const state = vi.hoisted(() => ({ runs: new Map<string, DelegatedRun>(), requests: [] as Request[], names: [] as string[] }));
vi.mock("../src/request-auth.js", () => ({
  isAuthorizedRequest: async (request: Request) => request.headers.get("Authorization") === "Bearer fixture",
  resolveUserId: async (request: Request) => request.headers.get("X-Fixture-User"),
}));
vi.mock("agents/routing", () => ({
  getAgentByName: async (_namespace: unknown, name: string) => {
    state.names.push(name);
    return { fetch: async (request: Request) => {
      state.requests.push(request);
      const runId = decodeURIComponent(new URL(request.url).pathname.split("/").pop()!);
      const run = state.runs.get(`${name}|${runId}`);
      return run ? Response.json({ run }) : Response.json({ error: "Not found" }, { status: 404 });
    } };
  },
}));

const OWNER = "owner@example.test";
const EXECUTOR = "Owner@Example.Test";
const TEAM_SESSION = "11111111-1111-4111-8111-111111111111";
const TEAM_EXECUTOR = `web:${EXECUTOR}:${TEAM_SESSION}`;
const MEMBER = "member@example.test";
const ROOM = `room_${"a".repeat(24)}`;
const HANDOFF = "handoff-report";
const APPROVAL = "approval-report";
const RUN = `agent-tool:${APPROVAL}`;
const TEXT = "# Report\nOnly the shared approved deliverable.\n";
const scope = { tenantId: "self-hosted", workspaceId: "default", userId: OWNER };

beforeEach(() => { state.runs.clear(); state.requests.length = 0; state.names.length = 0; });

async function fixture(withSelectedSource = false, teamWorkspace = false) {
  const { database, sqlite } = customAgentD1();
  const objects = new Map<string, Uint8Array>();
  let duringRead: (() => Promise<void> | void) | undefined;
  let reportedSize: number | undefined;
  let storedBody: Uint8Array | undefined;
  const get = vi.fn(async (key: string) => {
    const value = storedBody ?? objects.get(key);
    if (!value) return null;
    return { size: reportedSize ?? value.byteLength, body: new ReadableStream<Uint8Array>({
      async start(controller) {
        await duringRead?.();
        controller.enqueue(value);
        controller.close();
      },
    }) };
  });
  const env = {
    AGENT_AUDIT: database, CodingOrchestrator: {}, INTERNAL_SIGNING_KEY: "fixture-worker-only-internal-key",
    ATTACHMENTS: { get, put: async (key: string, value: string) => {
      objects.set(key, new TextEncoder().encode(value)); return { key };
    } },
  } as unknown as Env;
  const roomScope = { ...scope };
  if (teamWorkspace) {
    const workspace = await createTeamWorkspace(env, OWNER, { name: "Report team" });
    roomScope.workspaceId = workspace.workspaceId;
    const invite = await createTeamWorkspaceInvitation(env, workspace.workspaceId, OWNER, { email: MEMBER, role: "member" });
    await acceptTeamWorkspaceInvitation(env, MEMBER, invite.token);
  }
  await createCollaborationRoom(env, roomScope, { roomId: ROOM, title: "Report", visibility: "shared", createdAt: 1 });
  for (const [userId, actorId, kind] of [[MEMBER, humanActorId(MEMBER), "human"], [OWNER, "agent:writer", "agent"]] as const) {
    expect(await addCollaborationMember(env, roomScope, ROOM, { userId, actorId, kind, displayName: actorId, profileVersion: 1, createdAt: 2 })).toBe(true);
  }
  const handoff: CollaborationHandoffRow = {
    ...roomScope, handoffId: HANDOFF, roomId: ROOM, taskId: "task-report", senderUserId: OWNER, senderActorId: humanActorId(OWNER),
    recipientUserId: OWNER, recipientActorId: "agent:writer", parentHandoffId: null, rootHandoffId: HANDOFF, depth: 0,
    ancestorHandoffIds: [], remainingBudget: 0, grantedCapabilities: ["room.read"], profileVersion: 1,
    status: "active", createdAt: 3, cancelledAt: null,
  };
  expect(await createRootCollaborationHandoff(env, roomScope, handoff)).not.toBeNull();
  let task = "Write the report.";
  let note: Awaited<ReturnType<typeof createCollaborationMemory>> | undefined;
  if (withSelectedSource) {
    note = await createCollaborationMemory(env, roomScope, ROOM, { id: "ctx_release", title: "Release fact", content: "Release is on Tuesday." }, 4);
    task = (await freezeCollaborationContext(env, roomScope, ROOM, HANDOFF, task, [], [{ id: note.id, version: note.version, sha256: note.sha256 }])).task;
    await bindCollaborationContextApproval(env, HANDOFF, APPROVAL, task);
  }
  const executorName = teamWorkspace ? TEAM_EXECUTOR : EXECUTOR;
  expect(await pinCollaborationHandoffExecutor(env, roomScope, HANDOFF, executorName)).toBe(true);
  expect(await linkCollaborationHandoffRun(env, roomScope, HANDOFF, APPROVAL, RUN)).toBe(true);
  const artifacts = await verifyExpectedDeliverables(["reports/report.md"], [{ path: "reports/report.md", content: TEXT, encoding: "utf8" }]);
  const deliverables = (await persistRunDeliverables(env, "sandbox-report", artifacts)).map((item) => ({
    ...item, artifactId: `artifact_${"b".repeat(32)}`, version: 1, sourceRunId: RUN,
  }));
  const run: DelegatedRun = {
    runId: RUN, sandboxId: "sandbox-report", repoUrl: "https://github.com/example/repo", task, baseBranch: "main", publishPullRequest: false,
    ...(teamWorkspace ? { orgId: `team:${roomScope.workspaceId}` } : {}),
    status: "completed", generation: 2, createdAt: 4, updatedAt: 6, customAgentId: "writer", customAgentVersion: 1,
    collaborationHandoffId: HANDOFF, expectedDeliverables: ["reports/report.md"], deliverables,
  };
  run.approval = { approvalId: APPROVAL, decidedBy: OWNER, decidedAt: 5, inputHash: runInputHash(run) };
  state.runs.set(`${executorName}|${RUN}`, run);
  const refs = deliverables.map(({ path, artifactId, version, sha256 }, index) => ({ index, path, artifactId, version, sha256 }));
  expect(await createCollaborationAgentReply(env, roomScope, {
    messageId: `agent_reply_${HANDOFF}`, roomId: ROOM, handoffId: HANDOFF, runId: RUN, agentUserId: OWNER,
    agentActorId: "agent:writer", profileVersion: 1, body: "The approved report is ready.", sourceArtifactRefs: refs, createdAt: 6,
  })).not.toBeNull();
  const send = (user = MEMBER, path = `/api/collaboration/rooms/${ROOM}/handoffs/${HANDOFF}/artifacts/0`, headers: Record<string, string> = {}, method = "GET") =>
    handleCollaborationArtifact(new Request(`https://dashboard.test${path}`, { method, headers: {
      Authorization: "Bearer fixture", "X-Fixture-User": user,
      "X-Agent-Principal": "agent:spoof", "X-Shiba-Intake": "forged", Cookie: "private-cookie", ...headers,
    } }), env);
  return { env, sqlite, run, refs, note, get, objects, send, roomScope, executorName,
    duringRead: (action: () => Promise<void> | void) => { duringRead = action; },
    storedBody: (value: Uint8Array, size = artifacts[0]!.bytes) => { storedBody = value; reportedSize = size; },
  };
}

describe("membership-bound collaboration artifact downloads", () => {
  it("downloads from only the saved isolated team executor without forwarding browser routing claims", async () => {
    const f = await fixture(true, true);
    const response = await f.send(MEMBER, undefined, { "X-Shiba-Workspace": f.roomScope.workspaceId,
      "x-shiba-executor": OWNER, "x-shiba-room-session": "default" });
    expect(response?.status).toBe(200);
    expect(await response!.text()).toBe(TEXT);
    expect(state.names).toEqual([TEAM_EXECUTOR]);
    expect(response!.headers.has("location")).toBe(false);
    for (const request of state.requests) {
      expect(request.headers.has("x-shiba-executor")).toBe(false);
      expect(request.headers.has("x-shiba-room-session")).toBe(false);
      expect((await verifyInternalRequest(request, f.env)).ok).toBe(true);
    }
  });

  it.each([OWNER, EXECUTOR, null, `web:attacker@example.test:${TEAM_SESSION}`, `web:${OWNER}:default`, `web:${OWNER}:not-a-session`])(
    "rejects a base, missing or forged team artifact executor pin %s", async (pin) => {
      const f = await fixture(false, true);
      f.sqlite.prepare("UPDATE collaboration_handoffs SET executor_agent_name=?").run(pin);
      expect((await f.send(MEMBER, undefined, { "X-Shiba-Workspace": f.roomScope.workspaceId }))?.status).toBe(404);
      expect(state.names).toHaveLength(0);
      expect(f.get).not.toHaveBeenCalled();
    });

  it("does not fall back to a base-owner run when the isolated artifact run is missing", async () => {
    const f = await fixture(false, true);
    state.runs.delete(`${TEAM_EXECUTOR}|${RUN}`); state.runs.set(`${EXECUTOR}|${RUN}`, f.run);
    expect((await f.send(MEMBER, undefined, { "X-Shiba-Workspace": f.roomScope.workspaceId }))?.status).toBe(404);
    expect(state.names).toEqual([TEAM_EXECUTOR]);
    expect(f.get).not.toHaveBeenCalled();
  });

  it.each(["room-grant", "executor-pin"])("rechecks a changed team %s after the artifact body await", async (change) => {
    const f = await fixture(true, true);
    f.duringRead(() => {
      if (change === "room-grant") f.sqlite.prepare("UPDATE collaboration_memberships SET status='removed' WHERE workspace_id=? AND actor_id=?").run(f.roomScope.workspaceId, humanActorId(MEMBER));
      else f.sqlite.prepare("UPDATE collaboration_handoffs SET executor_agent_name=?").run(`web:${EXECUTOR}:22222222-2222-4222-8222-222222222222`);
    });
    const response = await f.send(MEMBER, undefined, { "X-Shiba-Workspace": f.roomScope.workspaceId });
    expect(response?.status).toBe(404);
    expect(await response!.text()).not.toContain(TEXT);
    expect(f.get).toHaveBeenCalledOnce();
  });

  it("binds team downloads to the selected workspace and rechecks membership after the body read", async () => {
    const f = await fixture(true, true);
    const ws = f.roomScope.workspaceId;
    expect((await f.send())?.status).toBe(404);
    expect((await f.send(MEMBER, `/api/collaboration/rooms/${ROOM}/handoffs/${HANDOFF}/artifacts/0?workspaceId=${ws}`))?.status).toBe(200);
    expect((await f.send(MEMBER, undefined, { "X-Shiba-Workspace": ws }))?.status).toBe(200);
    const other = await createTeamWorkspace(f.env, OWNER, { name: "Another team" });
    expect((await f.send(OWNER, undefined, { "X-Shiba-Workspace": other.workspaceId }))?.status).toBe(404);
    expect((await f.send(MEMBER, "/api/collaboration/rooms/" + ROOM + "/handoffs/" + HANDOFF + "/artifacts/0?workspaceId=default", { "X-Shiba-Workspace": ws }))?.status).toBe(404);
    f.duringRead(() => { f.sqlite.prepare("UPDATE team_workspace_memberships SET status='removed' WHERE workspace_id=? AND user_id=?").run(ws, MEMBER); });
    expect((await f.send(MEMBER, undefined, { "X-Shiba-Workspace": ws }))?.status).toBe(404);
  });

  it("returns only verified private bytes to either active human member, without bearer links or client headers", async () => {
    const f = await fixture(true);
    for (const user of [OWNER, MEMBER]) {
      const response = await f.send(user);
      expect(response?.status).toBe(200);
      expect(await response!.text()).toBe(TEXT);
      expect(response!.headers.get("cache-control")).toBe("private, no-store");
      expect(response!.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
      expect(response!.headers.get("content-disposition")).toBe('attachment; filename="report.md"');
      expect(response!.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response!.headers.has("location")).toBe(false);
    }
    expect(state.names).toEqual([EXECUTOR, EXECUTOR]);
    expect(f.get).toHaveBeenCalledWith(deliverableStorageKey("sandbox-report", f.run.deliverables![0]!.sha256, 0));
    for (const request of state.requests) {
      for (const header of ["X-Agent-Principal", "X-Shiba-Intake", "Authorization", "Cookie", "X-Fixture-User"]) expect(request.headers.has(header)).toBe(false);
      expect(request.headers.has(INTERNAL_SIGNATURE_HEADER)).toBe(true);
      expect((await verifyInternalRequest(request, f.env)).ok).toBe(true);
    }
  });

  it("denies anonymous callers, unrelated third users and removed members before manifest or storage reads", async () => {
    const f = await fixture();
    expect((await f.send(MEMBER, undefined, { Authorization: "" }))?.status).toBe(401);
    expect((await f.send("third@example.test"))?.status).toBe(404);
    f.sqlite.prepare("UPDATE collaboration_memberships SET status='removed',removed_at=10 WHERE actor_id=?").run(humanActorId(MEMBER));
    expect((await f.send())?.status).toBe(404);
    expect(state.requests).toHaveLength(0);
    expect(f.get).not.toHaveBeenCalled();
  });

  it("requires an active human room.read grant rather than an actor name or agent membership", async () => {
    const f = await fixture();
    f.sqlite.prepare("UPDATE collaboration_memberships SET capabilities_json='[\"message.send\"]' WHERE actor_id=?").run(humanActorId(MEMBER));
    expect((await f.send())?.status).toBe(404);
    f.sqlite.prepare("UPDATE collaboration_memberships SET capabilities_json='[\"room.read\"]',actor_kind='agent' WHERE actor_id=?").run(humanActorId(MEMBER));
    expect((await f.send())?.status).toBe(404);
    expect(f.get).not.toHaveBeenCalled();
  });

  it("rejects revoked selected shared memory even while the requester remains a room member", async () => {
    const f = await fixture(true);
    expect(await revokeCollaborationMemory(f.env, scope, ROOM, { id: f.note!.id, version: 1 }, 10)).toBe(true);
    expect((await f.send())?.status).toBe(404);
    expect(f.get).not.toHaveBeenCalled();
  });

  it("binds the actual run task to the original source snapshot even if a replacement hash is supplied", async () => {
    const f = await fixture(true);
    f.run.task += "\nUse different context.";
    f.run.approval!.inputHash = runInputHash(f.run);
    expect((await f.send())?.status).toBe(404);
    expect(f.get).not.toHaveBeenCalled();
  });

  it("checks retained Slack-origin audience policy, including after the link is revoked", async () => {
    const f = await fixture();
    f.env.SLACK_CANVAS_OWNERS = JSON.stringify([{ teamId: "T1", channelId: "C1", ownerId: OWNER, viewerIds: [MEMBER] }]);
    await observeCollaborationSlackThread(f.env, { teamId: "T1", channelId: "C1", threadTs: "1700000000.001", eventId: "event1", userId: "U1", seenAt: Date.now() });
    expect(await createCollaborationSlackLink(f.env, scope, { linkId: "link1", roomId: ROOM, teamId: "T1", channelId: "C1", threadTs: "1700000000.001", createdAt: Date.now() })).not.toBeNull();
    expect((await f.send())?.status).toBe(200);
    f.get.mockClear();
    f.sqlite.prepare("UPDATE collaboration_slack_room_links SET status='revoked',revoked_at=10").run();
    f.env.SLACK_CANVAS_OWNERS = undefined;
    expect((await f.send())?.status).toBe(404);
    expect(f.get).not.toHaveBeenCalled();
  });

  it.each(["artifactId", "version", "sha256", "path"] as const)("denies a changed stored artifact %s rather than exposing another output", async (field) => {
    const f = await fixture();
    const refs = f.refs.map((ref) => ({ ...ref, [field]: field === "version" ? 2 : "different" }));
    f.sqlite.prepare("UPDATE collaboration_messages SET source_artifact_refs_json=?").run(JSON.stringify(refs));
    expect((await f.send())?.status).toBe(404);
    expect(f.get).not.toHaveBeenCalled();
  });

  it.each(["collaborationHandoffId", "customAgentId", "customAgentVersion", "task", "approval"] as const)("denies a run with mismatched %s", async (field) => {
    const f = await fixture();
    Object.assign(f.run, { [field]: field === "customAgentVersion" ? 2 : field === "approval" ? { ...f.run.approval, approvalId: "other" } : "different" });
    expect((await f.send())?.status).toBe(404);
    expect(f.get).not.toHaveBeenCalled();
  });

  it("requires the exact executor pin and never falls back to another owner store", async () => {
    const f = await fixture();
    f.sqlite.prepare("UPDATE collaboration_handoffs SET executor_agent_name=NULL").run();
    expect((await f.send())?.status).toBe(404);
    expect(state.names).toHaveLength(0);
    f.sqlite.prepare("UPDATE collaboration_handoffs SET executor_agent_name='other@example.test'").run();
    expect((await f.send())?.status).toBe(404);
    expect(state.names).toHaveLength(0);
    expect(f.get).not.toHaveBeenCalled();
  });

  it("denies automated approval evidence and human-forged completion references", async () => {
    const f = await fixture();
    for (const actor of ["default", "system", "automation", "agent", "mcp", "child", "subagent", " System ", " automation:daily"]) {
      f.run.approval!.decidedBy = actor;
      expect((await f.send())?.status, actor).toBe(404);
    }
    f.run.approval!.decidedBy = OWNER;
    f.sqlite.prepare("UPDATE collaboration_messages SET sender_kind='human'").run();
    expect((await f.send())?.status).toBe(404);
    expect(f.get).not.toHaveBeenCalled();
  });

  it("denies cancelled handoffs, changed approval binding and unshared artifact slots", async () => {
    const f = await fixture();
    expect((await f.send(MEMBER, `/api/collaboration/rooms/${ROOM}/handoffs/${HANDOFF}/artifacts/1`))?.status).toBe(404);
    f.sqlite.prepare("UPDATE collaboration_handoffs SET approval_id='other'").run();
    expect((await f.send())?.status).toBe(404);
    f.sqlite.prepare("UPDATE collaboration_handoffs SET approval_id=?,status='cancelled',cancelled_at=10").run(APPROVAL);
    expect((await f.send())?.status).toBe(404);
    expect(f.get).not.toHaveBeenCalled();
  });

  it.each(["member", "source", "handoff", "artifact"])("rechecks %s revocation after the private storage await", async (kind) => {
    const f = await fixture(true);
    f.duringRead(async () => {
      if (kind === "member") f.sqlite.prepare("UPDATE collaboration_memberships SET status='removed',removed_at=10 WHERE actor_id=?").run(humanActorId(MEMBER));
      else if (kind === "source") await revokeCollaborationMemory(f.env, scope, ROOM, { id: f.note!.id, version: 1 }, 10);
      else if (kind === "handoff") f.sqlite.prepare("UPDATE collaboration_handoffs SET status='cancelled',cancelled_at=10").run();
      else f.sqlite.prepare("UPDATE collaboration_messages SET source_artifact_refs_json='[]'").run();
    });
    const response = await f.send();
    expect(response?.status).toBe(404);
    expect(await response!.text()).not.toContain(TEXT);
    expect(f.get).toHaveBeenCalledOnce();
  });

  it("rejects altered body bytes, oversized streams and wrong object length without returning content", async () => {
    const f = await fixture();
    const sameLength = new TextEncoder().encode(TEXT.replace("Report", "Alter!"));
    f.storedBody(sameLength);
    expect((await f.send())?.status).toBe(409);
    f.storedBody(new Uint8Array(20_000));
    expect((await f.send())?.status).toBe(409);
    f.storedBody(new TextEncoder().encode(TEXT), 20_000);
    expect((await f.send())?.status).toBe(409);
  });

  it("requires same-origin browser reads and canonical route identities; unrelated paths are not handled", async () => {
    const f = await fixture();
    expect((await f.send(MEMBER, undefined, { Origin: "https://evil.test" }))?.status).toBe(403);
    expect((await f.send(MEMBER, undefined, { "Sec-Fetch-Site": "cross-site" }))?.status).toBe(403);
    expect((await f.send(MEMBER, undefined, {}, "POST"))?.status).toBe(405);
    for (const index of ["8", "00", "-1", "%GG", "1.0"]) expect((await f.send(MEMBER, `/api/collaboration/rooms/${ROOM}/handoffs/${HANDOFF}/artifacts/${index}`))?.status).toBe(400);
    expect(await f.send(MEMBER, "/api/collaboration/rooms")).toBeNull();
    expect(f.get).not.toHaveBeenCalled();
  });
});
