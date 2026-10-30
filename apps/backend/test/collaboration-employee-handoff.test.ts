import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleApprovals } from "../src/approvals-routes.js";
import { handleCollaboration } from "../src/collaboration-routes.js";
import { createCustomAgent, updateCustomAgent } from "../src/custom-agents-store.js";
import type { Env } from "../src/env.js";
import { handleRuns, queueCollaborationRun } from "../src/runs-routes.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const state = vi.hoisted(() => ({
  userId: "owner@example.test",
  approvalStatus: "",
  run: null as null | {
    runId?: string;
    status: string;
    summary?: string;
    error?: string;
    pullUrl?: string;
    customAgentId?: string;
    customAgentVersion?: number;
    approval?: { approvalId: string };
    deliverables?: Array<{
      path: string;
      artifactId?: string;
      version?: number;
      sha256?: string;
    }>;
  },
  queued: null as null | {
    task: string;
    repoUrl: string;
    customAgentId: string;
    profileVersion: number;
    commandId: string;
  },
}));

vi.mock("../src/request-auth.js", () => ({
  isAuthorizedRequest: vi.fn(async () => true),
  resolveUserId: vi.fn(async () => state.userId),
}));
vi.mock("../src/runs-routes.js", () => ({
  handleRuns: vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.startsWith("/api/runs/")) {
      return state.run
        ? Response.json({ run: state.run })
        : Response.json({ error: "Run not found." }, { status: 404 });
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/api/runs/")) {
      if (!state.run || !["pending", "running"].includes(state.run.status)) {
        return Response.json({ error: "Run not found." }, { status: 404 });
      }
      state.run = { status: "cancelled" };
      return Response.json({ run: state.run });
    }
    return null;
  }),
  queueCollaborationRun: vi.fn(async (_request: Request, _env: Env, input: typeof state.queued) => {
    state.queued = input;
    state.approvalStatus = "pending";
    state.run = null;
    return Response.json({ ok: true, approvalId: "approval-employee-1" });
  }),
}));
vi.mock("../src/approvals-routes.js", () => ({
  handleApprovals: vi.fn(async (request: Request) => {
    const body = (await request.json()) as { approvalId?: string; approved?: boolean };
    if (body.approved === true) {
      state.approvalStatus = "approved";
      state.run = { status: "pending" };
    } else if (state.approvalStatus === "pending") {
      state.approvalStatus = "rejected";
    }
    return Response.json({ result: state.approvalStatus });
  }),
}));
vi.mock("agents/routing", () => ({
  getAgentByName: vi.fn(async () => ({
    fetch: vi.fn(async (request: Request | string) => {
      const url = new URL(typeof request === "string" ? request : request.url);
      if (url.pathname === "/api/approvals") {
        const item = { approvalId: "approval-employee-1", status: state.approvalStatus };
        return Response.json(
          state.approvalStatus === "pending"
            ? { approvals: [item], decided: [] }
            : { approvals: [], decided: [item] },
        );
      }
      if (
        url.pathname.startsWith("/api/runs/") &&
        decodeURIComponent(url.pathname.slice("/api/runs/".length)) ===
          "agent-tool:approval-employee-1"
      ) {
        return state.run
          ? Response.json({ run: state.run })
          : Response.json({ error: "Run not found." }, { status: 404 });
      }
      return Response.json({ error: "Not found." }, { status: 404 });
    }),
  })),
}));

function fixture() {
  const { database, sqlite } = customAgentD1();
  const env = { AGENT_AUDIT: database, CodingOrchestrator: {} } as unknown as Env;
  const send = async (path: string, method = "GET", body?: unknown) =>
    handleCollaboration(
      new Request(`https://worker.test/api/collaboration${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(method === "GET" ? {} : { origin: "https://worker.test" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
    );
  return { env, sqlite, send };
}

async function json<T>(response: Response | null): Promise<T> {
  if (!response) throw new Error("route not handled");
  return (await response.json()) as T;
}

beforeEach(() => {
  state.userId = "owner@example.test";
  state.approvalStatus = "";
  state.run = null;
  state.queued = null;
  vi.mocked(queueCollaborationRun).mockClear();
  vi.mocked(handleRuns).mockClear();
  vi.mocked(handleApprovals).mockClear();
});

describe("approval-gated employee handoffs", () => {
  it("carries the pinned employee version through a human-to-human-to-employee continuation", async () => {
    const f = fixture();
    const employee = await createCustomAgent(f.env, "self-hosted", "planner", {
      name: "Release Planner",
      instructions: "Plan the release.",
      harness: "opencode",
      defaultRepoUrl: "https://github.com/example/repo",
    });
    const room = await json<{ room: { roomId: string } }>(
      await f.send("/rooms", "POST", { title: "Continuation" }),
    );
    const roomId = room.room.roomId;
    expect((await f.send(`/rooms/${roomId}/members`, "POST", { userId: "bob@example.test" }))?.status).toBe(201);
    const employeeMember = await json<{ member: { actorId: string; profileVersion: number } }>(
      await f.send(`/rooms/${roomId}/agents`, "POST", {
        profileId: employee.id,
        profileVersion: employee.version,
      }),
    );
    expect(employeeMember.member.profileVersion).toBe(employee.version);
    expect((await f.send(`/rooms/${roomId}/handoffs`, "POST", {
      handoffId: "human-root-1",
      taskId: "continuation-task",
      recipientActorId: "human:bob@example.test",
      budget: 1,
    }))?.status).toBe(201);

    state.userId = "bob@example.test";
    const continuation = await f.send(`/rooms/${roomId}/handoffs`, "POST", {
      handoffId: "human-to-employee-1",
      taskId: "continuation-task",
      parentHandoffId: "human-root-1",
      recipientActorId: employeeMember.member.actorId,
      task: "Review the release notes.",
    });
    expect(continuation?.status).toBe(201);
    const saved = await json<{ handoff: { profileVersion: number; depth: number; rootHandoffId: string } }>(continuation);
    expect(saved.handoff).toMatchObject({ profileVersion: employee.version, depth: 1, rootHandoffId: "human-root-1" });
    expect(state.queued).toMatchObject({ profileVersion: employee.version, customAgentId: employee.id });
  });

  it("queues a pinned employee request, waits for human approval, shows run results, then cancels and reloads", async () => {
    const f = fixture();
    const employeeV1 = await createCustomAgent(f.env, "self-hosted", "reviewer", {
      name: "Release Reviewer",
      instructions: "Review only the requested repository.",
      harness: "opencode",
      defaultRepoUrl: "https://github.com/example/repo",
    });
    const room = await json<{ room: { roomId: string } }>(
      await f.send("/rooms", "POST", { title: "Release" }),
    );
    const roomId = room.room.roomId;
    const member = await json<{
      member: { actorId: string; profileVersion: number; displayName: string };
    }>(
      await f.send(`/rooms/${roomId}/agents`, "POST", {
        profileId: employeeV1.id,
        profileVersion: employeeV1.version,
      }),
    );
    expect(member.member).toMatchObject({
      actorId: `agent:${employeeV1.id}`,
      profileVersion: 1,
      displayName: "Release Reviewer",
    });

    // A later profile edit does not rewrite this room's membership pin.
    await updateCustomAgent(
      f.env,
      "self-hosted",
      employeeV1.id,
      {
        name: "Release Reviewer v2",
        instructions: "New instructions that do not apply to the existing room binding.",
        harness: "opencode",
        defaultRepoUrl: "https://github.com/example/repo",
      },
      1,
    );

    const handoff = await json<{
      handoff: { handoffId: string; approvalId: string; runId: string; profileVersion: number };
    }>(
      await f.send(`/rooms/${roomId}/handoffs`, "POST", {
        handoffId: "room-handoff-001",
        taskId: "release-42",
        recipientActorId: member.member.actorId,
        task: "Review the release notes and identify blockers.",
      }),
    );
    expect(handoff.handoff).toMatchObject({
      approvalId: "approval-employee-1",
      runId: "agent-tool:approval-employee-1",
      profileVersion: 1,
    });
    expect(state.queued).toMatchObject({
      task: "Review the release notes and identify blockers.",
      repoUrl: "https://github.com/example/repo",
      customAgentId: employeeV1.id,
      profileVersion: 1,
      commandId: "room-handoff-001",
    });
    expect(state.run).toBeNull(); // Queueing creates an approval only.

    const beforeApproval = await json<{
      handoffs: Array<{ execution?: { approvalStatus?: string; runStatus?: string } }>;
    }>(await f.send(`/rooms/${roomId}`));
    expect(beforeApproval.handoffs[0]?.execution).toMatchObject({ approvalStatus: "pending" });
    expect(beforeApproval.handoffs[0]?.execution?.runStatus).toBeUndefined();

    await handleApprovals(
      new Request("https://worker.test/api/approvals", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://worker.test" },
        body: JSON.stringify({
          threadKey: state.userId,
          approvalId: handoff.handoff.approvalId,
          approved: true,
        }),
      }),
      f.env,
    );
    expect(state.run).toEqual({ status: "pending" });
    state.run = {
      runId: handoff.handoff.runId,
      status: "completed",
      summary: "No release blockers found.",
      pullUrl: "https://github.com/example/repo/pull/7",
      customAgentId: employeeV1.id,
      customAgentVersion: employeeV1.version,
      approval: { approvalId: handoff.handoff.approvalId },
      deliverables: [{
        path: "reports/release-review.md",
        artifactId: "artifact-release-review",
        version: 1,
        sha256: "a".repeat(64),
      }],
    };
    const result = await json<{
      handoffs: Array<{
        execution?: {
          approvalStatus?: string;
          runStatus?: string;
          summary?: string;
          pullUrl?: string;
        };
      }>;
    }>(await f.send(`/rooms/${roomId}`));
    expect(result.handoffs[0]?.execution).toMatchObject({
      approvalStatus: "approved",
      runStatus: "completed",
      summary: "No release blockers found.",
      pullUrl: "https://github.com/example/repo/pull/7",
    });
    const replyView = await json<{
      messages: Array<{
        senderActorId: string;
        senderKind: string;
        sourceRunId?: string;
        sourceHandoffId?: string;
        sourceArtifactRefs?: Array<{ index: number; path: string; artifactId?: string }>;
        body: string;
      }>;
    }>(await f.send(`/rooms/${roomId}`));
    expect(replyView.messages).toHaveLength(1);
    expect(replyView.messages[0]).toMatchObject({
      senderActorId: `agent:${employeeV1.id}`,
      senderKind: "agent",
      sourceRunId: handoff.handoff.runId,
      sourceHandoffId: handoff.handoff.handoffId,
      sourceArtifactRefs: [{
        index: 0,
        path: "reports/release-review.md",
        artifactId: "artifact-release-review",
      }],
    });
    expect(replyView.messages[0]?.body).toContain("No release blockers found.");
    // A repeated read replays the same completion observation without duplication.
    expect((await json<{ messages: unknown[] }>(await f.send(`/rooms/${roomId}`))).messages).toHaveLength(1);

    expect(
      (await f.send(`/handoffs/${handoff.handoff.handoffId}/cancel`, "POST", {}))?.status,
    ).toBe(200);
    const reloaded = await json<{
      handoffs: Array<{
        status: string;
        approvalId?: string;
        execution?: { runStatus?: string; summary?: string };
      }>;
    }>(await f.send(`/rooms/${roomId}`));
    expect(reloaded.handoffs[0]).toMatchObject({
      status: "cancelled",
      approvalId: "approval-employee-1",
      execution: { runStatus: "completed", summary: "No release blockers found." },
    });
    expect((await json<{ messages: Array<{ sourceRunId?: string }> }>(await f.send(`/rooms/${roomId}`)))
      .messages.filter((message) => message.sourceRunId === handoff.handoff.runId)).toHaveLength(1);
    expect(
      f.sqlite
        .prepare(
          "SELECT approval_id,run_id FROM collaboration_handoffs WHERE handoff_id='room-handoff-001'",
        )
        .get(),
    ).toEqual({ approval_id: "approval-employee-1", run_id: "agent-tool:approval-employee-1" });
  });

  it("does not append a completed employee reply after that employee is removed", async () => {
    const f = fixture();
    const employee = await createCustomAgent(f.env, "self-hosted", "reviewer", {
      name: "Release Reviewer",
      instructions: "Review the requested task.",
      harness: "opencode",
      defaultRepoUrl: "https://github.com/example/repo",
    });
    const room = await json<{ room: { roomId: string } }>(
      await f.send("/rooms", "POST", { title: "Revoked employee" }),
    );
    const roomId = room.room.roomId;
    const member = await json<{ member: { actorId: string } }>(
      await f.send(`/rooms/${roomId}/agents`, "POST", {
        profileId: employee.id,
        profileVersion: employee.version,
      }),
    );
    const created = await json<{ handoff: { handoffId: string; runId: string } }>(
      await f.send(`/rooms/${roomId}/handoffs`, "POST", {
        handoffId: "revoked-employee-handoff",
        taskId: "revoked-task",
        recipientActorId: member.member.actorId,
        task: "Review the change.",
      }),
    );
    state.approvalStatus = "approved";
    state.run = {
      runId: created.handoff.runId,
      status: "completed",
      summary: "Completed after removal.",
      customAgentId: employee.id,
      customAgentVersion: employee.version,
      approval: { approvalId: "approval-employee-1" },
    };
    expect(
      (
        await f.send(
          `/rooms/${roomId}/members/${encodeURIComponent(member.member.actorId)}`,
          "DELETE",
        )
      )?.status,
    ).toBe(200);
    const detail = await json<{ messages: unknown[] }>(await f.send(`/rooms/${roomId}`));
    expect(detail.messages).toEqual([]);
  });

  it("surfaces failed and unknown outcomes without writing employee completion replies", async () => {
    for (const status of ["error", "unknown"] as const) {
      const f = fixture();
      const employee = await createCustomAgent(f.env, "self-hosted", `employee-${status}`, {
        name: `Employee ${status}`,
        instructions: "Perform the approved task.",
        harness: "opencode",
        defaultRepoUrl: "https://github.com/example/repo",
      });
      const room = await json<{ room: { roomId: string } }>(
        await f.send("/rooms", "POST", { title: `Run ${status}` }),
      );
      const member = await json<{ member: { actorId: string } }>(
        await f.send(`/rooms/${room.room.roomId}/agents`, "POST", {
          profileId: employee.id,
          profileVersion: employee.version,
        }),
      );
      const handoff = await json<{ handoff: { runId: string } }>(
        await f.send(`/rooms/${room.room.roomId}/handoffs`, "POST", {
          handoffId: `outcome-${status}-handoff`,
          taskId: `outcome-${status}`,
          recipientActorId: member.member.actorId,
          task: "Perform the approved task.",
        }),
      );
      state.approvalStatus = "approved";
      state.run = {
        runId: handoff.handoff.runId,
        status,
        ...(status === "error" ? { error: "Local stand-in failed." } : {}),
        customAgentId: employee.id,
        customAgentVersion: employee.version,
        approval: { approvalId: "approval-employee-1" },
      };
      const detail = await json<{
        handoffs: Array<{ execution?: { runStatus?: string; error?: string } }>;
        messages: unknown[];
      }>(await f.send(`/rooms/${room.room.roomId}`));
      expect(detail.handoffs[0]?.execution).toMatchObject({ runStatus: status });
      expect(detail.handoffs[0]?.execution?.error).toBeTruthy();
      expect(detail.messages).toEqual([]);
    }
  });
});
