import {
  askUserAnswerSchema,
  askUserRequestSchema,
  type AskUserAnswer,
  type AskUserReceipt,
  type AskUserRequest,
} from "@shiba/shared";
import { COLLAB_TENANT_ID } from "./collaboration-store.js";
import type { Env } from "./env.js";
import { randomHex } from "./mailbox-store.js";

type StoreEnv = Pick<Env, "AGENT_AUDIT">;

export class AskUserError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "AskUserError";
  }
}

interface Row {
  owner_id: string;
  run_id: string;
  ask_id: string;
  request_json: string;
  status: "pending" | "answered" | "cancelled";
  answer_json: string | null;
  created_at: number;
  answered_at: number | null;
}

export interface PendingAskUser {
  ownerId: string;
  runId: string;
  askId: string;
  request: AskUserRequest;
  status: "pending" | "answered" | "cancelled";
  createdAt: number;
  answer?: AskUserAnswer;
  answeredAt?: number;
}

function parseRow(row: Row): PendingAskUser {
  const request = askUserRequestSchema.parse(JSON.parse(row.request_json));
  const answer = row.answer_json ? askUserAnswerSchema.parse(JSON.parse(row.answer_json)) : undefined;
  return {
    ownerId: row.owner_id,
    runId: row.run_id,
    askId: row.ask_id,
    request,
    status: row.status,
    createdAt: row.created_at,
    ...(answer ? { answer, answeredAt: row.answered_at ?? undefined } : {}),
  };
}

export async function createAskUserPause(
  env: StoreEnv,
  ownerId: string,
  runId: string,
  request: AskUserRequest,
  now = Date.now(),
): Promise<PendingAskUser> {
  if (!env.AGENT_AUDIT) throw new AskUserError("Ask-user storage is unavailable.", 503);
  const parsed = askUserRequestSchema.parse(request);
  const existing = await env.AGENT_AUDIT.prepare(
    "SELECT 1 FROM ask_user_pending WHERE tenant_id=? AND owner_id=? AND run_id=? AND status='pending' LIMIT 1",
  )
    .bind(COLLAB_TENANT_ID, ownerId, runId)
    .first();
  if (existing) throw new AskUserError("This run already has a pending question.", 409);
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO ask_user_pending
     (tenant_id, owner_id, run_id, ask_id, request_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
  )
    .bind(COLLAB_TENANT_ID, ownerId, runId, parsed.askId, JSON.stringify(parsed), now)
    .run();
  return { ownerId, runId, askId: parsed.askId, request: parsed, status: "pending", createdAt: now };
}

export async function getPendingAskUser(
  env: StoreEnv,
  ownerId: string,
  runId: string,
): Promise<PendingAskUser | null> {
  if (!env.AGENT_AUDIT) return null;
  const row = await env.AGENT_AUDIT.prepare(
    "SELECT * FROM ask_user_pending WHERE tenant_id=? AND owner_id=? AND run_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1",
  )
    .bind(COLLAB_TENANT_ID, ownerId, runId)
    .first<Row>();
  return row ? parseRow(row) : null;
}

export async function answerAskUser(
  env: StoreEnv,
  ownerId: string,
  runId: string,
  askId: string,
  answer: AskUserAnswer,
  now = Date.now(),
): Promise<{ pending: PendingAskUser; receipt: AskUserReceipt }> {
  if (!env.AGENT_AUDIT) throw new AskUserError("Ask-user storage is unavailable.", 503);
  const parsedAnswer = askUserAnswerSchema.parse(answer);
  const row = await env.AGENT_AUDIT.prepare(
    "SELECT * FROM ask_user_pending WHERE tenant_id=? AND owner_id=? AND run_id=? AND ask_id=? AND status='pending'",
  )
    .bind(COLLAB_TENANT_ID, ownerId, runId, askId)
    .first<Row>();
  if (!row) throw new AskUserError("No pending question matches this run.", 404);
  const request = askUserRequestSchema.parse(JSON.parse(row.request_json));
  if (request.mode !== parsedAnswer.mode) throw new AskUserError("Answer mode does not match the question.", 400);
  const receipt: AskUserReceipt = {
    commandId: `ask_user:${runId}:${askId}`,
    kind: "ask_user.answer",
    askId,
    runId,
    request,
    answer: parsedAnswer,
    at: now,
  };
  const updated = await env.AGENT_AUDIT.prepare(
    `UPDATE ask_user_pending SET status='answered', answer_json=?, answered_at=?
     WHERE tenant_id=? AND owner_id=? AND run_id=? AND ask_id=? AND status='pending'`,
  )
    .bind(JSON.stringify(parsedAnswer), now, COLLAB_TENANT_ID, ownerId, runId, askId)
    .run();
  if (updated.meta.changes !== 1) throw new AskUserError("Question was answered elsewhere.", 409);
  return {
    pending: { ownerId, runId, askId, request, status: "answered", createdAt: row.created_at, answer: parsedAnswer, answeredAt: now },
    receipt,
  };
}

export function pauseCommandId(runId: string, askId: string): string {
  return `ask_user:pause:${runId}:${askId}`;
}

export function resumeToken(runId: string, askId: string): string {
  return `ask_resume_${randomHex(8)}_${runId}_${askId}`;
}