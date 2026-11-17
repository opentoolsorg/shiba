import { parseUiBlock, uiAnswerSchema, uiBlockFallbackQuestions, validateUiAnswer, type UiAnswer, type UiBlock } from "@shiba/shared";
import { COLLAB_TENANT_ID } from "./collaboration-store.js";
import type { Env } from "./env.js";

type StoreEnv = Pick<Env, "AGENT_AUDIT">;

export class UiBlockError extends Error {
  constructor(message: string, readonly status = 400, readonly errors: string[] = [message]) {
    super(message);
    this.name = "UiBlockError";
  }
}

interface Row {
  owner_id: string;
  run_id: string;
  block_id: string;
  block_json: string;
  fallback_text: string;
  status: "pending" | "answered" | "cancelled";
  answer_json: string | null;
  answered_via: string | null;
  created_at: number;
  answered_at: number | null;
}

export interface UiBlockQuestion {
  ownerId: string;
  runId: string;
  blockId: string;
  block: UiBlock;
  fallbackText: string;
  status: Row["status"];
  answer?: UiAnswer;
  answeredVia?: string;
  createdAt: number;
  answeredAt?: number;
}

function database(env: StoreEnv): D1Database {
  if (!env.AGENT_AUDIT) throw new UiBlockError("UI block storage is unavailable.", 503);
  return env.AGENT_AUDIT;
}

function parseRow(row: Row): UiBlockQuestion {
  const parsed = parseUiBlock(JSON.parse(row.block_json));
  if (!parsed.ok) throw new UiBlockError("Stored UI block is invalid.", 503);
  return {
    ownerId: row.owner_id, runId: row.run_id, blockId: row.block_id,
    block: parsed.block, fallbackText: row.fallback_text, status: row.status,
    createdAt: row.created_at,
    ...(row.answer_json ? { answer: uiAnswerSchema.parse(JSON.parse(row.answer_json)) } : {}),
    ...(row.answered_via ? { answeredVia: row.answered_via } : {}),
    ...(row.answered_at !== null ? { answeredAt: row.answered_at } : {}),
  };
}

export async function getUiBlock(env: StoreEnv, ownerId: string, runId: string, blockId: string): Promise<UiBlockQuestion | null> {
  const row = await database(env).prepare(
    "SELECT * FROM ui_block_questions WHERE tenant_id=? AND owner_id=? AND run_id=? AND block_id=?",
  ).bind(COLLAB_TENANT_ID, ownerId, runId, blockId).first<Row>();
  return row ? parseRow(row) : null;
}

export async function listUiBlocks(env: StoreEnv, ownerId: string, runId: string, includeAnswered = false): Promise<UiBlockQuestion[]> {
  const db = database(env);
  const pending = await db.prepare(
    "SELECT * FROM ui_block_questions WHERE tenant_id=? AND owner_id=? AND run_id=? AND status='pending' ORDER BY created_at DESC",
  ).bind(COLLAB_TENANT_ID, ownerId, runId).all<Row>();
  if (!includeAnswered) return pending.results.map(parseRow);
  const answered = await db.prepare(
    "SELECT * FROM ui_block_questions WHERE tenant_id=? AND owner_id=? AND run_id=? AND status='answered' ORDER BY answered_at DESC LIMIT 20",
  ).bind(COLLAB_TENANT_ID, ownerId, runId).all<Row>();
  return [...pending.results, ...answered.results].map(parseRow);
}

export async function createUiBlock(env: StoreEnv, ownerId: string, runId: string, input: unknown, now = Date.now()): Promise<{ question: UiBlockQuestion; created: boolean }> {
  const parsed = parseUiBlock(input);
  if (!parsed.ok) throw new UiBlockError("Invalid UI block.", 400, parsed.errors);
  const block = parsed.block;
  const serialized = JSON.stringify(block);
  const db = database(env);
  const inserted = await db.prepare(
    `INSERT INTO ui_block_questions
     (tenant_id, owner_id, run_id, block_id, block_json, fallback_text, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?) ON CONFLICT DO NOTHING`,
  ).bind(COLLAB_TENANT_ID, ownerId, runId, block.id, serialized, uiBlockFallbackQuestions(block), now).run();
  const question = await getUiBlock(env, ownerId, runId, block.id);
  if (!question || JSON.stringify(question.block) !== serialized) throw new UiBlockError("A different question already exists for this block or run.", 409);
  return { question, created: inserted.meta.changes === 1 };
}

export async function answerUiBlock(env: StoreEnv, ownerId: string, runId: string, blockId: string, input: unknown, answeredVia: string, now = Date.now()) {
  const question = await getUiBlock(env, ownerId, runId, blockId);
  if (!question) throw new UiBlockError("Question not found.", 404);
  if (question.status !== "pending") throw new UiBlockError("Question is already resolved.", 409);
  const checked = validateUiAnswer(question.block, input);
  if (!checked.ok) throw new UiBlockError("Invalid UI answer.", 400, checked.errors);
  const result = await database(env).prepare(
    `UPDATE ui_block_questions SET status='answered', answer_json=?, answered_via=?, answered_at=?
     WHERE tenant_id=? AND owner_id=? AND run_id=? AND block_id=? AND status='pending'`,
  ).bind(JSON.stringify(checked.answer), answeredVia, now, COLLAB_TENANT_ID, ownerId, runId, blockId).run();
  if (result.meta.changes !== 1) throw new UiBlockError("Question was answered elsewhere.", 409);
  const receipt = { kind: "ui_block.answered" as const, runId, blockId, answer: checked.answer, answeredVia, at: now };
  return { question: { ...question, status: "answered" as const, answer: checked.answer, answeredVia, answeredAt: now }, receipt };
}
