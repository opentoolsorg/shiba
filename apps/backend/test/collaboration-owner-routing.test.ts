import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodingOrchestrator, type OrchestratorState } from "../src/agents/orchestrator.js";
import { handleCollaboration } from "../src/collaboration-routes.js";
import { handleRuns, queueCollaborationRun, resolveRunStoreTarget } from "../src/runs-routes.js";
import { createCustomAgent } from "../src/custom-agents-store.js";
import type { Env } from "../src/env.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), names: [] as string[] }));
vi.mock("@cloudflare/think", () => ({ Think: class {
  onStart() {}
  getTools() { return {}; }
  onRequest() { return new Response(null, { status: 404 }); }
  keepAliveWhile(fn: () => Promise<unknown>) { return fn(); }
  schedule() { return Promise.resolve({}); }
} }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: mocks.execute }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("agents/routing", () => ({
  getAgentByName: async (namespace: { get(name: string): unknown }, name: string) => {
    mocks.names.push(name);
    return namespace.get(name);
  },
}));

function fixture() {
  const { database, sqlite } = customAgentD1();
  const owners = new Map<string, CodingOrchestrator>();
  const env = { ...productionEnvStubs(), AGENT_AUDIT: database, Sandbox: {}, REQUIRE_ACCESS: "1" } as unknown as Env;
  const owner = (name: string) => {
    let value = owners.get(name);
    if (!value) {
      value = Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
        name, env, state: { runs: [] } as OrchestratorState,
        setState(state: OrchestratorState) { setStateLikeProduction(this, state); },
      });
      owners.set(name, value);
    }
    return value;
  };
  Object.assign(env, { CodingOrchestrator: { get: (name: string) => ({
    fetch: (input: Request | string) => owner(name).onRequest(typeof input === "string" ? new Request(input) : input),
  }) } });
  const request = (path: string, userId: string, method = "GET", body?: unknown) => new Request(`https://worker.test${path}`, {
    method, headers: { "content-type": "application/json", origin: "https://worker.test", "cf-access-authenticated-user-email": userId },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const send = (path: string, userId: string, method = "GET", body?: unknown) => handleCollaboration(request(`/api/collaboration${path}`, userId, method, body), env);
  return { env, sqlite, owner, request, send };
}

beforeEach(() => { mocks.names.length = 0; mocks.execute.mockReset(); });

describe("mixed-case collaboration executor compatibility", () => {
  async function queue(f: ReturnType<typeof fixture>) {
    const identity = "User@Example.com";
    const employee = await createCustomAgent(f.env, "self-hosted", "writer", {
      name: "Writer", instructions: "Write a draft.", harness: "opencode", defaultRepoUrl: "https://github.com/example/repo",
    });
    const roomResponse = await f.send("/rooms", identity, "POST", { title: "Owner routing" });
    const { room } = await roomResponse!.json() as { room: { roomId: string } };
    await f.send(`/rooms/${room.roomId}/members`, identity, "POST", { userId: "reader@example.com" });
    const added = await f.send(`/rooms/${room.roomId}/agents`, identity, "POST", { profileId: employee.id, profileVersion: employee.version });
    const { member } = await added!.json() as { member: { actorId: string } };
    const result = await f.send(`/rooms/${room.roomId}/handoffs`, identity, "POST", {
      handoffId: "mixed-owner", taskId: "task-owner", recipientActorId: member.actorId, task: "Prepare draft",
    });
    expect(result?.status).toBe(201);
    const { handoff } = await result!.json() as { handoff: { approvalId: string; runId: string; executorAgentName: string } };
    return { identity, roomId: room.roomId, handoff, employee };
  }

  it("queues, reads, and fences the exact owner while preserving raw historical run/session routing", async () => {
    const f = fixture();
    const { identity, roomId, handoff } = await queue(f);
    expect(handoff.executorAgentName).toBe(identity);
    expect(f.owner(identity).state.pendingApprovals?.[0]?.approvalId).toBe(handoff.approvalId);
    expect(f.owner("user@example.com").state.pendingApprovals).toBeUndefined();
    const room = await f.send(`/rooms/${roomId}`, "reader@example.com");
    expect((await room!.json() as { handoffs: Array<{ execution: { approvalStatus: string } }> }).handoffs[0]?.execution.approvalStatus).toBe("pending");
    const runUrl = new URL(`https://worker.test/api/runs/${encodeURIComponent(handoff.runId)}`);
    expect(await resolveRunStoreTarget(f.request(runUrl.pathname, identity), f.env, runUrl)).toEqual({ agentName: identity, userId: identity });
    const removed = await f.send(`/rooms/${roomId}/members/${encodeURIComponent("human:reader@example.com")}`, identity, "DELETE");
    expect(removed?.status).toBe(200);
    const cancelled = await f.send("/handoffs/mixed-owner/cancel", "user@example.com", "POST");
    expect(cancelled?.status).toBe(200);
    expect(f.owner(identity).state.pendingApprovals?.[0]?.status).toBe("rejected");
    expect(mocks.execute).not.toHaveBeenCalled();
    const historical = await handleRuns(f.request("/api/runs", identity), f.env);
    expect(historical?.status).toBe(200);
    expect(mocks.names.at(-1)).toBe(identity);
  });

  it("uses the immutable pin when the authenticated owner returns with different casing", async () => {
    const f = fixture();
    const { identity, handoff, employee } = await queue(f);
    const retried = await queueCollaborationRun(f.request("/api/collaboration/rooms/r/handoffs", "user@example.com", "POST", {}), f.env, {
      task: "Prepare draft", repoUrl: "https://github.com/example/repo", customAgentId: employee.id,
      profileVersion: employee.version, commandId: "mixed-owner", collaborationHandoffId: "mixed-owner",
      executorAgentName: handoff.executorAgentName, runtime: "sandbox",
    });
    expect(retried?.status).toBe(200);
    expect((await retried!.json() as { approvalId: string }).approvalId).toBe(handoff.approvalId);
    expect(f.owner(identity).state.pendingApprovals).toHaveLength(1);
    expect(f.owner("user@example.com").state.pendingApprovals).toBeUndefined();
    const forged = await queueCollaborationRun(f.request("/api/collaboration/rooms/r/handoffs", "outsider@example.com", "POST", {}), f.env, {
      task: "Prepare draft", repoUrl: "https://github.com/example/repo", customAgentId: employee.id,
      profileVersion: employee.version, commandId: "forged", executorAgentName: identity,
    });
    expect(forged?.status).toBe(403);
  });

  it("reads a completed run and retains its room reply from the pinned mixed-case owner", async () => {
    const f = fixture();
    const { identity, handoff, roomId } = await queue(f);
    const owner = f.owner(identity);
    Object.assign(owner, { dispatchApprovedRun: vi.fn() });
    const approved = await owner.onRequest(new Request("https://internal/api/approvals", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadKey: identity, approvalId: handoff.approvalId, approved: true, decidedBy: identity }),
    }));
    expect(approved.status).toBe(200);
    owner.setState({ ...owner.state, runs: owner.state.runs.map(run => ({ ...run, status: "completed", summary: "Draft retained" })) });
    const response = await f.send(`/rooms/${roomId}`, "reader@example.com");
    expect((await response!.json() as { handoffs: Array<{ execution: { runStatus: string } }> }).handoffs[0]?.execution.runStatus).toBe("completed");
    expect(f.sqlite.prepare("SELECT body FROM collaboration_messages WHERE message_id='agent_reply_mixed-owner'").get()?.body).toContain("Draft retained");
  });

  it("reconciles a retained legacy run after its decided approval has been pruned", async () => {
    const f = fixture();
    const { identity, handoff, roomId } = await queue(f);
    const owner = f.owner(identity);
    Object.assign(owner, { dispatchApprovedRun: vi.fn() });
    await owner.onRequest(new Request("https://internal/api/approvals", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadKey: identity, approvalId: handoff.approvalId, approved: true, decidedBy: identity }),
    }));
    owner.setState({ ...owner.state, pendingApprovals: [], runs: owner.state.runs.map(run => ({ ...run, status: "completed", summary: "Historical retained draft" })) });
    f.sqlite.prepare("UPDATE collaboration_handoffs SET executor_agent_name=NULL WHERE handoff_id=?").run("mixed-owner");
    const response = await f.send(`/rooms/${roomId}`, identity);
    expect((await response!.json() as { handoffs: Array<{ execution: { runStatus: string } }> }).handoffs[0]?.execution.runStatus).toBe("completed");
    expect(f.sqlite.prepare("SELECT executor_agent_name FROM collaboration_handoffs WHERE handoff_id=?").get("mixed-owner")?.executor_agent_name).toBe(identity);
  });

  it("refuses ambiguous legacy matches instead of cancelling a guessed owner", async () => {
    const f = fixture();
    const { identity } = await queue(f);
    f.owner("user@example.com").setState(structuredClone(f.owner(identity).state));
    f.sqlite.prepare("UPDATE collaboration_handoffs SET executor_agent_name=NULL WHERE handoff_id=?").run("mixed-owner");
    const cancelled = await f.send("/handoffs/mixed-owner/cancel", identity, "POST");
    expect(cancelled?.status).toBe(202);
    expect(f.owner(identity).state.pendingApprovals?.[0]?.status).toBe("pending");
    expect(f.owner("user@example.com").state.pendingApprovals?.[0]?.status).toBe("pending");
    expect(f.sqlite.prepare("SELECT executor_agent_name FROM collaboration_handoffs WHERE handoff_id=?").get("mixed-owner")?.executor_agent_name).toBeNull();
  });

  it("reconciles legacy exact-handoff proof, then another member reads the same pinned owner", async () => {
    const f = fixture();
    const { identity, roomId, handoff } = await queue(f);
    f.sqlite.prepare("UPDATE collaboration_handoffs SET executor_agent_name=NULL WHERE handoff_id=?").run("mixed-owner");
    const unavailable = await f.send(`/rooms/${roomId}`, "reader@example.com");
    expect((await unavailable!.json() as { handoffs: Array<{ execution: { unavailable: boolean } }> }).handoffs[0]?.execution.unavailable).toBe(true);
    const reconciled = await f.send(`/rooms/${roomId}`, identity);
    expect((await reconciled!.json() as { handoffs: Array<{ execution: { approvalStatus: string } }> }).handoffs[0]?.execution.approvalStatus).toBe("pending");
    expect(f.sqlite.prepare("SELECT executor_agent_name FROM collaboration_handoffs WHERE handoff_id=?").get("mixed-owner")?.executor_agent_name).toBe(identity);
    const next = await f.send(`/rooms/${roomId}`, "reader@example.com");
    expect((await next!.json() as { handoffs: Array<{ execution: { approvalId: string } }> }).handoffs[0]?.execution.approvalId).toBe(handoff.approvalId);
  });

  it("does not acknowledge legacy cancellation when no executor mapping is proven", async () => {
    const f = fixture();
    const { roomId } = await queue(f);
    f.sqlite.prepare("UPDATE collaboration_handoffs SET executor_agent_name=NULL WHERE handoff_id=?").run("mixed-owner");
    const response = await f.send(`/rooms/${roomId}/members/${encodeURIComponent("human:user@example.com")}`, "reader@example.com", "DELETE");
    expect(response?.status).toBe(403);
    const cancelled = await f.send("/handoffs/mixed-owner/cancel", "user@example.com", "POST");
    expect(cancelled?.status).toBe(202);
    expect((await cancelled!.json() as { executorCancellationPending: boolean }).executorCancellationPending).toBe(true);
    expect(f.owner("User@Example.com").state.pendingApprovals?.[0]?.status).toBe("pending");
  });
});
