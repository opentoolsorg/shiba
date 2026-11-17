import {
  DEFAULT_LEARNING_TURNS,
  type LearningPort,
  type LearningSuggestion,
  type LearningThreadRef,
  type LearningThreadState,
  type LearningTurnSetting,
  parseLearningTurnSetting,
} from "./index.js";

type Row = Record<string, unknown>;

/** Mirrors migrations/0061_learning_review.sql for databases created before it applies. */
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS learning_settings ( workspace_id TEXT PRIMARY KEY, turn_setting TEXT NOT NULL, updated_at INTEGER NOT NULL )",
  "CREATE TABLE IF NOT EXISTS learning_threads ( thread_key TEXT PRIMARY KEY, org_id TEXT NOT NULL, workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL, employee_id TEXT NOT NULL, turns_total INTEGER NOT NULL DEFAULT 0, reviewed_through INTEGER NOT NULL DEFAULT 0, last_turn_at INTEGER NOT NULL, closed_at INTEGER, review_lease_until INTEGER )",
  "CREATE INDEX IF NOT EXISTS learning_threads_idle ON learning_threads(last_turn_at)",
  "CREATE TABLE IF NOT EXISTS learning_turns ( thread_key TEXT NOT NULL, seq INTEGER NOT NULL, run_id TEXT NOT NULL, text TEXT NOT NULL, completed_at INTEGER NOT NULL, PRIMARY KEY (thread_key, seq), UNIQUE (thread_key, run_id) )",
  "CREATE TABLE IF NOT EXISTS learning_usage ( id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, employee_id TEXT NOT NULL, thread_key TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, created_at INTEGER NOT NULL )",
  "CREATE INDEX IF NOT EXISTS learning_usage_employee ON learning_usage(workspace_id, employee_id)",
  "CREATE TABLE IF NOT EXISTS learning_suggestions ( id TEXT PRIMARY KEY, thread_key TEXT NOT NULL, workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL, employee_id TEXT NOT NULL, skill_id TEXT NOT NULL, skill_version INTEGER NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, instructions TEXT NOT NULL, dropped_share REAL NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','applied','dismissed')), created_at INTEGER NOT NULL )",
  "CREATE INDEX IF NOT EXISTS learning_suggestions_owner ON learning_suggestions(workspace_id, owner_id, status)",
];

const ready = new WeakMap<D1Database, Promise<void>>();

function ensureTables(db: D1Database): Promise<void> {
  let pending = ready.get(db);
  if (!pending) {
    pending = db.batch(SCHEMA.map((sql) => db.prepare(sql))).then(() => undefined);
    pending.catch(() => ready.delete(db));
    ready.set(db, pending);
  }
  return pending;
}

function threadFromRow(row: Row): LearningThreadState {
  return {
    threadKey: String(row.thread_key),
    orgId: String(row.org_id),
    workspaceId: String(row.workspace_id),
    ownerId: String(row.owner_id),
    employeeId: String(row.employee_id),
    turnsTotal: Number(row.turns_total),
    reviewedThrough: Number(row.reviewed_through),
    lastTurnAt: Number(row.last_turn_at),
    ...(row.closed_at === null || row.closed_at === undefined
      ? {}
      : { closedAt: Number(row.closed_at) }),
  };
}

function suggestionFromRow(row: Row): LearningSuggestion {
  return {
    id: String(row.id),
    threadKey: String(row.thread_key),
    workspaceId: String(row.workspace_id),
    ownerId: String(row.owner_id),
    employeeId: String(row.employee_id),
    skillId: String(row.skill_id),
    skillVersion: Number(row.skill_version),
    name: String(row.name),
    description: String(row.description),
    instructions: String(row.instructions),
    droppedShare: Number(row.dropped_share),
    status: row.status as LearningSuggestion["status"],
    createdAt: Number(row.created_at),
  };
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `learn_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** D1-backed learning port on the AGENT_AUDIT database. */
export function d1LearningPort(db: D1Database): LearningPort {
  const getThread = async (threadKey: string) => {
    await ensureTables(db);
    const row = await db
      .prepare("SELECT * FROM learning_threads WHERE thread_key = ?")
      .bind(threadKey)
      .first<Row>();
    return row ? threadFromRow(row) : null;
  };
  return {
    async getSetting(workspaceId) {
      await ensureTables(db);
      const row = await db
        .prepare("SELECT turn_setting FROM learning_settings WHERE workspace_id = ?")
        .bind(workspaceId)
        .first<Row>();
      return parseLearningTurnSetting(row?.turn_setting) ?? DEFAULT_LEARNING_TURNS;
    },
    async setSetting(workspaceId, value: LearningTurnSetting, now) {
      await ensureTables(db);
      await db
        .prepare(
          `INSERT INTO learning_settings (workspace_id, turn_setting, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET turn_setting = excluded.turn_setting, updated_at = excluded.updated_at`,
        )
        .bind(workspaceId, String(value), now)
        .run();
    },
    async recordTurn(ref: LearningThreadRef, turn) {
      await ensureTables(db);
      await db.batch([
        db
          .prepare(
            `INSERT INTO learning_threads (thread_key, org_id, workspace_id, owner_id, employee_id, turns_total, reviewed_through, last_turn_at)
           VALUES (?, ?, ?, ?, ?, 0, 0, ?) ON CONFLICT(thread_key) DO NOTHING`,
          )
          .bind(
            ref.threadKey,
            ref.orgId,
            ref.workspaceId,
            ref.ownerId,
            ref.employeeId,
            turn.completedAt,
          ),
        db
          .prepare(
            `INSERT OR IGNORE INTO learning_turns (thread_key, seq, run_id, text, completed_at)
           SELECT ?, turns_total + 1, ?, ?, ? FROM learning_threads WHERE thread_key = ?`,
          )
          .bind(ref.threadKey, turn.runId, turn.text, turn.completedAt, ref.threadKey),
        db
          .prepare(
            `UPDATE learning_threads SET
             turns_total = (SELECT COALESCE(MAX(seq), 0) FROM learning_turns WHERE thread_key = ?),
             last_turn_at = MAX(last_turn_at, ?)
           WHERE thread_key = ?`,
          )
          .bind(ref.threadKey, turn.completedAt, ref.threadKey),
      ]);
      const state = await getThread(ref.threadKey);
      if (!state) throw new Error("learning_thread_missing");
      return state;
    },
    getThread,
    async closeThread(threadKey, now) {
      await ensureTables(db);
      await db
        .prepare(
          "UPDATE learning_threads SET closed_at = COALESCE(closed_at, ?) WHERE thread_key = ?",
        )
        .bind(now, threadKey)
        .run();
      return getThread(threadKey);
    },
    async idleThreads(before, limit) {
      await ensureTables(db);
      const { results } = await db
        .prepare(
          `SELECT * FROM learning_threads WHERE last_turn_at <= ? AND turns_total > reviewed_through
         ORDER BY last_turn_at LIMIT ?`,
        )
        .bind(before, limit)
        .all<Row>();
      return (results ?? []).map(threadFromRow);
    },
    async turnsSince(threadKey, afterSeq, limit) {
      await ensureTables(db);
      const { results } = await db
        .prepare(
          "SELECT seq, run_id, text, completed_at FROM learning_turns WHERE thread_key = ? AND seq > ? ORDER BY seq LIMIT ?",
        )
        .bind(threadKey, afterSeq, limit)
        .all<Row>();
      return (results ?? []).map((row) => ({
        seq: Number(row.seq),
        runId: String(row.run_id),
        text: String(row.text),
        completedAt: Number(row.completed_at),
      }));
    },
    async claimReview(threadKey, now, leaseMs) {
      await ensureTables(db);
      const result = await db
        .prepare(
          `UPDATE learning_threads SET review_lease_until = ?
         WHERE thread_key = ? AND (review_lease_until IS NULL OR review_lease_until <= ?)`,
        )
        .bind(now + leaseMs, threadKey, now)
        .run();
      return result.meta?.changes === 1;
    },
    async completeReview(threadKey, throughSeq) {
      await ensureTables(db);
      await db
        .prepare(
          "UPDATE learning_threads SET reviewed_through = MAX(reviewed_through, ?), review_lease_until = NULL WHERE thread_key = ?",
        )
        .bind(throughSeq, threadKey)
        .run();
    },
    async releaseReview(threadKey) {
      await ensureTables(db);
      await db
        .prepare("UPDATE learning_threads SET review_lease_until = NULL WHERE thread_key = ?")
        .bind(threadKey)
        .run();
    },
    async recordUsage(ref, usage, now) {
      await ensureTables(db);
      await db
        .prepare(
          `INSERT INTO learning_usage (workspace_id, employee_id, thread_key, model, input_tokens, output_tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          ref.workspaceId,
          ref.employeeId,
          ref.threadKey,
          usage.model,
          usage.inputTokens,
          usage.outputTokens,
          now,
        )
        .run();
    },
    async usageByEmployee(workspaceId) {
      await ensureTables(db);
      const { results } = await db
        .prepare(
          `SELECT employee_id, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, COUNT(*) AS reviews
         FROM learning_usage WHERE workspace_id = ? GROUP BY employee_id ORDER BY employee_id`,
        )
        .bind(workspaceId)
        .all<Row>();
      return (results ?? []).map((row) => ({
        employeeId: String(row.employee_id),
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
        reviews: Number(row.reviews),
      }));
    },
    async addSuggestion(ref, proposal, now) {
      await ensureTables(db);
      const suggestion: LearningSuggestion = {
        ...proposal,
        id: randomId(),
        threadKey: ref.threadKey,
        workspaceId: ref.workspaceId,
        ownerId: ref.ownerId,
        employeeId: ref.employeeId,
        status: "pending",
        createdAt: now,
      };
      await db
        .prepare(
          `INSERT INTO learning_suggestions
          (id, thread_key, workspace_id, owner_id, employee_id, skill_id, skill_version, name, description, instructions, dropped_share, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .bind(
          suggestion.id,
          ref.threadKey,
          ref.workspaceId,
          ref.ownerId,
          ref.employeeId,
          proposal.skillId,
          proposal.skillVersion,
          proposal.name,
          proposal.description,
          proposal.instructions,
          proposal.droppedShare,
          now,
        )
        .run();
      return suggestion;
    },
    async listSuggestions(workspaceId, ownerId) {
      await ensureTables(db);
      const { results } = await db
        .prepare(
          `SELECT * FROM learning_suggestions WHERE workspace_id = ? AND owner_id = ? AND status = 'pending'
         ORDER BY created_at DESC LIMIT 50`,
        )
        .bind(workspaceId, ownerId)
        .all<Row>();
      return (results ?? []).map(suggestionFromRow);
    },
    async getSuggestion(id, ownerId) {
      await ensureTables(db);
      const row = await db
        .prepare("SELECT * FROM learning_suggestions WHERE id = ? AND owner_id = ?")
        .bind(id, ownerId)
        .first<Row>();
      return row ? suggestionFromRow(row) : null;
    },
    async resolveSuggestion(id, ownerId, status) {
      await ensureTables(db);
      const result = await db
        .prepare(
          "UPDATE learning_suggestions SET status = ? WHERE id = ? AND owner_id = ? AND status = 'pending'",
        )
        .bind(status, id, ownerId)
        .run();
      return result.meta?.changes === 1;
    },
  };
}
