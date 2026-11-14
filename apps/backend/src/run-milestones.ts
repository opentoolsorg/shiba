import type { ThreadMessagePayload, WorkspaceEvent } from "@shiba/shared";
import { postRoomEvent } from "./collaboration-thread-post.js";
import { COLLAB_TENANT_ID } from "./collaboration-store.js";
import type { Env } from "./env.js";
import { randomHex } from "./mailbox-store.js";
import { publishWorkspaceEvent } from "./platform/workspace-events-do.js";
import { buildRunProof } from "./run-proof.js";
import type { DelegatedRun } from "@shiba/shared";

export type MilestoneKind = "ack" | "status" | "milestone" | "result" | "blocked";

const STATUS_GAP_MS = 3_000;
const lastStatusAt = new Map<string, number>();

type StoreEnv = Pick<Env, "AGENT_AUDIT" | "WorkspaceEvents">;

async function nextSeq(env: StoreEnv, runId: string): Promise<number> {
  const row = await env.AGENT_AUDIT!.prepare(
    "SELECT COALESCE(MAX(seq), 0) AS seq FROM run_milestones WHERE run_id = ?",
  ).bind(runId).first<{ seq: number }>();
  return (row?.seq ?? 0) + 1;
}

export async function appendRunMilestone(
  env: StoreEnv,
  input: {
    workspaceId: string;
    runId: string;
    kind: MilestoneKind;
    text: string;
    payload?: Record<string, unknown>;
    roomId?: string | null;
    threadRootId?: string | null;
    userId?: string | null;
    at?: number;
  },
): Promise<void> {
  if (!env.AGENT_AUDIT) return;
  const now = input.at ?? Date.now();
  if (input.kind === "status") {
    const previous = lastStatusAt.get(input.runId) ?? 0;
    if (now - previous < STATUS_GAP_MS) return;
    lastStatusAt.set(input.runId, now);
  }
  const seq = await nextSeq(env, input.runId);
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO run_milestones (run_id, seq, kind, text, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(input.runId, seq, input.kind, input.text.slice(0, 500), input.payload ? JSON.stringify(input.payload) : null, now).run();
  const event: WorkspaceEvent = {
    id: `wse_${randomHex(12)}`,
    workspaceId: input.workspaceId,
    kind: "run.updated",
    entityId: input.runId,
    at: now,
    payload: { milestone: input.kind, seq },
    ...(input.roomId ? { audience: { roomId: input.roomId } } : {}),
  };
  await publishWorkspaceEvent(env, input.workspaceId, event);
  if (input.roomId) {
    const roomKind = input.kind === "ack" || input.kind === "status" || input.kind === "result" ? input.kind : "milestone";
    const payload: ThreadMessagePayload = { runId: input.runId };
    if (typeof input.payload?.pullUrl === "string") payload.pr = input.payload.pullUrl;
    await postRoomEvent(env as Env, {
      tenantId: COLLAB_TENANT_ID,
      workspaceId: input.workspaceId,
      userId: input.userId ?? input.workspaceId,
    }, {
      roomId: input.roomId,
      threadRootId: input.threadRootId ?? null,
      kind: roomKind,
      body: input.text,
      payload,
      ...(input.kind === "status" ? { editKey: "status" } : {}),
    });
  }
}

export async function recordQueuedAck(
  env: StoreEnv,
  input: { workspaceId: string; approvalId: string; task: string; roomId?: string | null; threadRootId?: string | null },
): Promise<void> {
  const first = input.task.trim().split(/[.\n]/)[0]?.trim() || "read the repository";
  try {
    await appendRunMilestone(env, {
      workspaceId: input.workspaceId,
      runId: input.approvalId,
      kind: "ack",
      text: `On it: first I'll ${first.replace(/^first I'll /i, "")}.`,
      roomId: input.roomId,
      threadRootId: input.threadRootId,
    });
  } catch {
    // Milestone storage is applied by migration 0053.
  }
}

export async function syncRunMilestones(
  env: StoreEnv,
  workspaceId: string,
  run: DelegatedRun,
  room?: { roomId?: string | null; threadRootId?: string | null },
): Promise<void> {
  try {
    if (run.status === "running") {
      await appendRunMilestone(env, {
        workspaceId,
        runId: run.runId,
        kind: "status",
        text: run.summary?.trim() || "Working",
        roomId: room?.roomId,
        threadRootId: room?.threadRootId,
      });
    }
    const blocked = run.signals?.some((signal) => signal.kind === "e2e.failed" || signal.kind === "ask_user.pending");
    if (blocked) {
      await appendRunMilestone(env, {
        workspaceId,
        runId: run.runId,
        kind: "milestone",
        text: run.signals?.find((signal) => signal.kind === "ask_user.pending")?.detail || "Blocked",
        roomId: room?.roomId,
        threadRootId: room?.threadRootId,
      });
    }
    if (run.status === "completed" || run.status === "error" || run.status === "cancelled" || run.status === "aborted" || run.status === "unknown") {
      const proof = buildRunProof(run);
      await appendRunMilestone(env, {
        workspaceId,
        runId: run.runId,
        kind: run.status === "completed" ? "result" : "blocked",
        text: run.summary?.trim() || (run.status === "completed" ? "Result ready" : "Stopped"),
        payload: { pullUrl: proof.pullUrl, screenshotUrl: proof.screenshotUrl, previewUrl: proof.previewUrl },
        roomId: room?.roomId,
        threadRootId: room?.threadRootId,
      });
    }
  } catch {
    // Ignore until migration 0053 is applied.
  }
}

export async function latestStatusText(env: StoreEnv, runId: string): Promise<string | null> {
  if (!env.AGENT_AUDIT) return null;
  const row = await env.AGENT_AUDIT.prepare(
    `SELECT text FROM run_milestones WHERE run_id = ? AND kind = 'status' ORDER BY seq DESC LIMIT 1`,
  ).bind(runId).first<{ text: string }>();
  return row?.text ?? null;
}