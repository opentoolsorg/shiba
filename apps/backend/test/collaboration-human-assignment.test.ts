import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleCollaboration } from "../src/collaboration-routes.js";
import { readCollaborationHumanAssignment } from "../src/collaboration-context.js";
import { acceptTeamWorkspaceInvitation, createTeamWorkspace, createTeamWorkspaceInvitation } from "../src/team-workspaces-store.js";
import type { Env } from "../src/env.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const auth = vi.hoisted(() => ({ userId: "owner@example.test" }));
const queue = vi.hoisted(() => vi.fn());
vi.mock("../src/request-auth.js", () => ({ isAuthorizedRequest: async () => true, resolveUserId: async () => auth.userId }));
vi.mock("../src/runs-routes.js", () => ({ queueCollaborationRun: queue }));
beforeEach(() => { auth.userId = "owner@example.test"; queue.mockReset(); });
async function fixture() {
  const { database, sqlite } = customAgentD1();
  const env = { AGENT_AUDIT: database } as unknown as Env;
  for (const key of ["Memory", "CodingOrchestrator", "Sandbox"]) Object.defineProperty(env, key, { get() { throw new Error("Human assignment must not use private memory, providers or execution."); } });
  const workspace = await createTeamWorkspace(env, auth.userId, { name: "Human team" });
  const invitation = await createTeamWorkspaceInvitation(env, workspace.workspaceId, auth.userId, { email: "member@example.test", role: "member" });
  await acceptTeamWorkspaceInvitation(env, "member@example.test", invitation.token);
  const scope = { tenantId: "self-hosted", workspaceId: workspace.workspaceId, userId: auth.userId };
  const send = async (path: string, method = "GET", body?: unknown): Promise<Response> => {
    const response = await handleCollaboration(new Request(`https://worker.test/api/collaboration${path}`, { method,
      headers: { "Content-Type": "application/json", "X-Shiba-Workspace": workspace.workspaceId, ...(method === "GET" ? {} : { Origin: "https://worker.test" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env);
    if (!response) throw new Error("Route not handled");
    return response;
  };
  const created = await send("/rooms", "POST", { title: "Shared assignment" });
  const { room } = await created.json() as { room: { roomId: string } };
  expect((await send(`/rooms/${room.roomId}/members`, "POST", { userId: "member@example.test" })).status).toBe(201);
  const request = { handoffId: "human-work", taskId: "Release follow-up", task: "Prepare the launch checklist by Friday.", recipientActorId: "human:member@example.test", budget: 2 };
  return { env, sqlite, database, scope, send, roomId: room.roomId, request };
}
interface HumanBody { handoff: { humanRequest?: { instructions: string; task: string; digest: string; requestedByUserId: string; messageCount: number; noteCount: number }; approvalId?: string; runId?: string } }
interface RoomBody { handoffs: Array<HumanBody["handoff"] & { handoffId: string; execution?: { unavailable?: boolean } }> }

describe("durable human task assignments", () => {
  it("persists task-only instructions and reloads them for the actual human assignee without execution", async () => {
    const f = await fixture();
    const result = await f.send(`/rooms/${f.roomId}/handoffs`, "POST", f.request);
    expect(result.status).toBe(201);
    const body = await result.json() as HumanBody;
    expect(body.handoff.humanRequest).toMatchObject({ instructions: f.request.task, task: f.request.task, requestedByUserId: "owner@example.test", messageCount: 0, noteCount: 0 });
    expect(body.handoff.humanRequest?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(body.handoff.approvalId).toBeUndefined();
    expect(body.handoff.runId).toBeUndefined();
    auth.userId = "member@example.test";
    const loaded = await (await f.send(`/rooms/${f.roomId}`)).json() as RoomBody;
    expect(loaded.handoffs[0]?.humanRequest?.instructions).toBe(f.request.task);
    expect(f.sqlite.prepare("SELECT COUNT(*) count FROM collaboration_context_snapshots").get()?.count).toBe(1);
    expect(queue).not.toHaveBeenCalled();
  });

  it("freezes only selected attributed messages and note versions, and withholds the body after source revocation", async () => {
    const f = await fixture();
    await f.send(`/rooms/${f.roomId}/messages`, "POST", { messageId: "selected_fact", body: "Launch owner is Alex." });
    await f.send(`/rooms/${f.roomId}/messages`, "POST", { messageId: "unselected_fact", body: "Unselected conversation must stay out." });
    const noteResponse = await f.send(`/rooms/${f.roomId}/memory`, "POST", { id: "ctx_constraints", title: "Constraints", content: "Keep the budget unchanged." });
    const { memory } = await noteResponse.json() as { memory: { id: string; version: number; sha256: string } };
    const request = { ...f.request, contextMessageIds: ["selected_fact"], memoryRefs: [{ id: memory.id, version: memory.version, sha256: memory.sha256 }] };
    const result = await f.send(`/rooms/${f.roomId}/handoffs`, "POST", request);
    expect(result.status).toBe(201);
    const { handoff } = await result.json() as HumanBody;
    expect(handoff.humanRequest?.task).toContain("Launch owner is Alex.");
    expect(handoff.humanRequest?.task).toContain("human:owner@example.test");
    expect(handoff.humanRequest?.task).toContain("Keep the budget unchanged.");
    expect(handoff.humanRequest?.task).not.toContain("Unselected conversation");
    expect(handoff.humanRequest).toMatchObject({ messageCount: 1, noteCount: 1 });
    await f.send(`/rooms/${f.roomId}/memory/ctx_constraints`, "DELETE", { version: 1 });
    auth.userId = "member@example.test";
    const reloaded = await (await f.send(`/rooms/${f.roomId}`)).json() as RoomBody;
    expect(reloaded.handoffs[0]?.humanRequest).toBeUndefined();
    expect(reloaded.handoffs[0]?.execution?.unavailable).toBe(true);
    expect(await readCollaborationHumanAssignment(f.env, { ...f.scope, userId: auth.userId }, f.roomId, f.request.handoffId)).toBeNull();
    auth.userId = "outsider@example.test";
    expect((await f.send(`/rooms/${f.roomId}`)).status).toBe(404);
    expect(queue).not.toHaveBeenCalled();
  });

  it("deduplicates an identical assignment and rejects changed task or selection without altering the original", async () => {
    const f = await fixture();
    expect((await f.send(`/rooms/${f.roomId}/handoffs`, "POST", f.request)).status).toBe(201);
    expect((await f.send(`/rooms/${f.roomId}/handoffs`, "POST", f.request)).status).toBe(201);
    expect((await f.send(`/rooms/${f.roomId}/handoffs`, "POST", { ...f.request, task: "Changed intent" })).status).toBe(409);
    expect((await f.send(`/rooms/${f.roomId}/handoffs`, "POST", { ...f.request, contextMessageIds: ["new_selection"] })).status).toBe(409);
    const loaded = await (await f.send(`/rooms/${f.roomId}`)).json() as RoomBody;
    expect(loaded.handoffs[0]?.humanRequest?.instructions).toBe(f.request.task);
    expect(f.sqlite.prepare("SELECT COUNT(*) count FROM collaboration_handoffs").get()?.count).toBe(1);
    expect(f.sqlite.prepare("SELECT COUNT(*) count FROM collaboration_context_snapshots").get()?.count).toBe(1);
    expect(f.sqlite.prepare("SELECT remaining FROM collaboration_handoff_budgets").get()?.remaining).toBe(2);
  });

  it("rejects malformed, oversized or unavailable selected context before creating any handoff", async () => {
    const f = await fixture();
    for (const invalid of [{ task: "" }, { task: "x".repeat(4001) }, { contextMessageIds: ["foreign_or_missing"] }]) {
      expect([400, 409]).toContain((await f.send(`/rooms/${f.roomId}/handoffs`, "POST", { ...f.request, ...invalid })).status);
    }
    expect(f.sqlite.prepare("SELECT COUNT(*) count FROM collaboration_handoffs").get()?.count).toBe(0);
    expect(f.sqlite.prepare("SELECT COUNT(*) count FROM collaboration_handoff_budgets").get()?.count).toBe(0);
    expect(f.sqlite.prepare("SELECT COUNT(*) count FROM collaboration_context_snapshots").get()?.count).toBe(0);
  });

  it("rolls back the handoff and budget if immutable snapshot persistence fails", async () => {
    const f = await fixture();
    const original = f.database.prepare.bind(f.database);
    f.database.prepare = (sql) => {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(target, property, receiver) {
        if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        if (property === "execute" && sql.startsWith("INSERT INTO collaboration_context_snapshots")) return () => { throw new Error("Injected snapshot failure"); };
        return Reflect.get(target, property, receiver);
      } });
      return wrap(original(sql));
    };
    expect((await f.send(`/rooms/${f.roomId}/handoffs`, "POST", f.request)).status).toBe(503);
    expect(f.sqlite.prepare("SELECT COUNT(*) count FROM collaboration_handoffs").get()?.count).toBe(0);
    expect(f.sqlite.prepare("SELECT COUNT(*) count FROM collaboration_handoff_budgets").get()?.count).toBe(0);
    expect(f.sqlite.prepare("SELECT COUNT(*) count FROM collaboration_context_snapshots").get()?.count).toBe(0);
  });

  it("hides a saved assignment after its author or assignee loses the room grant", async () => {
    const f = await fixture();
    expect((await f.send(`/rooms/${f.roomId}/handoffs`, "POST", f.request)).status).toBe(201);
    await f.send(`/rooms/${f.roomId}/members/${encodeURIComponent("human:member@example.test")}`, "DELETE");
    auth.userId = "member@example.test";
    expect((await f.send(`/rooms/${f.roomId}`)).status).toBe(404);
    expect(await readCollaborationHumanAssignment(f.env, { ...f.scope, userId: auth.userId }, f.roomId, f.request.handoffId)).toBeNull();
    expect(queue).not.toHaveBeenCalled();
  });
});

it("rolls back a source-revocation race between preflight and the human handoff transaction", async () => {
  const f = await fixture();
  const result = await f.send(`/rooms/${f.roomId}/memory`, "POST", { id: "ctx_race", title: "Current", content: "Keep this source private after revocation." });
  const { memory } = await result.json() as { memory: { id: string; version: number; sha256: string } };
  const batch = f.database.batch.bind(f.database);
  f.database.batch = async <T>(statements: D1PreparedStatement[]) => {
    f.sqlite.prepare("UPDATE collaboration_memory SET revoked_at=100 WHERE context_id='ctx_race'").run();
    return batch<T>(statements);
  };
  const response = await f.send(`/rooms/${f.roomId}/handoffs`, "POST", { ...f.request, memoryRefs: [{ id: memory.id, version: memory.version, sha256: memory.sha256 }] });
  expect(response.status).toBe(409);
  expect(f.sqlite.prepare("SELECT COUNT(*) count FROM collaboration_handoffs").get()?.count).toBe(0);
  expect(f.sqlite.prepare("SELECT COUNT(*) count FROM collaboration_handoff_budgets").get()?.count).toBe(0);
  expect(f.sqlite.prepare("SELECT COUNT(*) count FROM collaboration_context_snapshots").get()?.count).toBe(0);
});

it("atomically saves a child human request and restores its budget after a failed snapshot write", async () => {
  const f = await fixture();
  expect((await f.send(`/rooms/${f.roomId}/handoffs`, "POST", f.request)).status).toBe(201);
  auth.userId = "member@example.test";
  const prepare = f.database.prepare.bind(f.database);
  f.database.prepare = (sql) => {
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(target, property, receiver) {
      if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
      if (property === "execute" && sql.startsWith("INSERT INTO collaboration_context_snapshots")) return () => { throw new Error("Injected child snapshot failure"); };
      return Reflect.get(target, property, receiver);
    } });
    return wrap(prepare(sql));
  };
  const child = { ...f.request, handoffId: "human-child", parentHandoffId: f.request.handoffId, recipientActorId: "human:owner@example.test", task: "Review the prepared checklist." };
  expect((await f.send(`/rooms/${f.roomId}/handoffs`, "POST", child)).status).toBe(503);
  expect(f.sqlite.prepare("SELECT remaining FROM collaboration_handoff_budgets").get()?.remaining).toBe(2);
  expect(f.sqlite.prepare("SELECT COUNT(*) count FROM collaboration_handoffs").get()?.count).toBe(1);
  f.database.prepare = prepare;
  expect((await f.send(`/rooms/${f.roomId}/handoffs`, "POST", child)).status).toBe(201);
  expect(f.sqlite.prepare("SELECT remaining FROM collaboration_handoff_budgets").get()?.remaining).toBe(1);
  auth.userId = "owner@example.test";
  const room = await (await f.send(`/rooms/${f.roomId}`)).json() as RoomBody;
  expect(room.handoffs.find((item) => item.handoffId === child.handoffId)?.humanRequest?.instructions).toBe(child.task);
  expect(queue).not.toHaveBeenCalled();
});
