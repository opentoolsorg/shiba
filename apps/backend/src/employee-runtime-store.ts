import type {
  EmployeeRuntimeExecution,
  EmployeeRuntimeMemory,
  EmployeeRuntimeMemoryWrite,
  EmployeeRuntimeMessage,
  EmployeeRuntimeMode,
  EmployeeRuntimeProfile,
} from "@shiba/shared";
import { InputError } from "./security.js";

export type SqlRow = Record<string, unknown>;
export type SqlExec = (sql: string, ...params: Array<string | number | boolean | null>) => SqlRow[];

const MAX_MESSAGES = 500;
const MAX_ROUTINE_MESSAGES = 100;
const MAX_MEMORIES = 1000;
const MAX_EXECUTIONS = 500;

export const EMPLOYEE_RUNTIME_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS employee_runtime_messages(
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
    content TEXT NOT NULL,
    execution_id TEXT,
    origin TEXT NOT NULL DEFAULT 'interactive',
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS employee_runtime_messages_conversation
    ON employee_runtime_messages(conversation_id,created_at,id)`,
  `CREATE TABLE IF NOT EXISTS employee_runtime_summaries(
    conversation_id TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    through_message_id TEXT NOT NULL,
    message_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS employee_runtime_profiles(
    conversation_id TEXT PRIMARY KEY,
    profile_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS employee_runtime_memories(
    id TEXT PRIMARY KEY,
    conversation_id TEXT,
    scope TEXT NOT NULL CHECK(scope IN ('employee','thread')),
    kind TEXT NOT NULL CHECK(kind IN ('fact','preference','summary','skill')),
    content TEXT NOT NULL,
    essential INTEGER NOT NULL DEFAULT 0,
    origin TEXT NOT NULL DEFAULT 'manual',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS employee_runtime_memories_scope
    ON employee_runtime_memories(scope,essential,updated_at)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS employee_runtime_memory_fts USING fts5(
    memory_id UNINDEXED,
    content
  )`,
  `CREATE TABLE IF NOT EXISTS employee_runtime_executions(
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('chat','work')),
    status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled','interrupted')),
    checkpoint TEXT NOT NULL,
    input_json TEXT NOT NULL,
    result_json TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS employee_runtime_executions_conversation
    ON employee_runtime_executions(conversation_id,created_at,id)`,
] as const;

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function cleanId(value: string, label: string): string {
  const clean = value.trim();
  if (!clean || clean.length > 600) throw new InputError(`${label} must be 1-600 characters.`);
  return clean;
}

function bounded<T>(rows: T[], limit: number): T[] {
  return rows.slice(Math.max(0, rows.length - limit));
}

function escapeFtsQuery(query: string): string {
  const terms = query.toLowerCase().match(/[\p{L}\p{N}_-]{1,64}/gu) ?? [];
  if (!terms.length) throw new InputError("Memory search needs at least one letter or number.");
  return terms.slice(0, 12).map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}


export interface EmployeeRuntimeSummary {
  conversationId: string;
  summary: string;
  throughMessageId: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

function rowToSummary(row: SqlRow): EmployeeRuntimeSummary {
  return {
    conversationId: String(row.conversation_id),
    summary: String(row.summary),
    throughMessageId: String(row.through_message_id),
    messageCount: Number(row.message_count),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class EmployeeRuntimeStore {
  constructor(private readonly exec: SqlExec) {}

  init(): void {
    for (const statement of EMPLOYEE_RUNTIME_SCHEMA) this.exec(statement);
    const columns = this.exec(`PRAGMA table_info(employee_runtime_messages)`).map((row) => String(row.name));
    if (!columns.includes("execution_id")) this.exec(`ALTER TABLE employee_runtime_messages ADD COLUMN execution_id TEXT`);
    if (!columns.includes("origin")) this.exec(`ALTER TABLE employee_runtime_messages ADD COLUMN origin TEXT NOT NULL DEFAULT 'interactive'`);
    const memoryColumns = this.exec(`PRAGMA table_info(employee_runtime_memories)`).map((row) => String(row.name));
    if (!memoryColumns.includes("origin")) this.exec(`ALTER TABLE employee_runtime_memories ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'`);
  }

  pinProfile(conversationId: string, profile: EmployeeRuntimeProfile, now = Date.now()): void {
    this.exec(
      `INSERT OR REPLACE INTO employee_runtime_profiles(conversation_id,profile_json,updated_at) VALUES(?,?,?)`,
      cleanId(conversationId, "conversationId"), JSON.stringify(profile), now,
    );
  }

  profile(conversationId: string): EmployeeRuntimeProfile | null {
    const row = this.exec(`SELECT profile_json FROM employee_runtime_profiles WHERE conversation_id=?`, cleanId(conversationId, "conversationId"))[0];
    if (!row) return null;
    try { return JSON.parse(String(row.profile_json)) as EmployeeRuntimeProfile; } catch { return null; }
  }

  appendMessage(input: { conversationId: string; role: EmployeeRuntimeMessage["role"]; content: string; executionId?: string; now?: number; origin?: "interactive" | "routine" }): EmployeeRuntimeMessage {
    const content = input.content.trim();
    if (!content || content.length > 16000) throw new InputError("Message content must be 1-16000 characters.");
    const message: EmployeeRuntimeMessage = {
      id: id("msg"), conversationId: cleanId(input.conversationId, "conversationId"), role: input.role,
      content, createdAt: input.now ?? Date.now(),
      ...(input.executionId ? { executionId: input.executionId } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
    };
    this.exec(
      `INSERT INTO employee_runtime_messages(id,conversation_id,role,content,execution_id,origin,created_at) VALUES(?,?,?,?,?,?,?)`,
      message.id, message.conversationId, message.role, message.content, message.executionId ?? null, input.origin ?? "interactive", message.createdAt,
    );
    this.pruneMessages(message.conversationId);
    return message;
  }

  listMessages(conversationId: string, limit = 100): EmployeeRuntimeMessage[] {
    const rows = this.exec(
      `SELECT * FROM employee_runtime_messages WHERE conversation_id=? ORDER BY created_at DESC, rowid DESC,id DESC LIMIT ?`,
      cleanId(conversationId, "conversationId"), Math.max(1, Math.min(500, Math.floor(limit))),
    );
    return rows.reverse().map(rowToMessage);
  }

  conversationSummary(conversationId: string): EmployeeRuntimeSummary | null {
    const row = this.exec(`SELECT * FROM employee_runtime_summaries WHERE conversation_id=?`, cleanId(conversationId, "conversationId"))[0];
    return row ? rowToSummary(row) : null;
  }

  upsertConversationSummary(conversationId: string, summary: string, throughMessageId: string, messageCount: number, now = Date.now()): void {
    const clean = summary.trim();
    if (!clean || clean.length > 8000) throw new InputError("Conversation summary must be 1-8000 characters.");
    this.exec(
      `INSERT INTO employee_runtime_summaries(conversation_id,summary,through_message_id,message_count,created_at,updated_at)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(conversation_id) DO UPDATE SET summary=excluded.summary,through_message_id=excluded.through_message_id,message_count=excluded.message_count,updated_at=excluded.updated_at`,
      cleanId(conversationId, "conversationId"), clean, cleanId(throughMessageId, "throughMessageId"), Math.max(0, Math.floor(messageCount)), now, now,
    );
  }

  private pruneMessages(conversationId: string): void {
    this.exec(
      `DELETE FROM employee_runtime_messages WHERE conversation_id=? AND origin='interactive' AND id NOT IN (
        SELECT id FROM employee_runtime_messages WHERE conversation_id=? AND origin='interactive' ORDER BY created_at DESC, rowid DESC,id DESC LIMIT ?
      )`, conversationId, conversationId, MAX_MESSAGES,
    );
    this.exec(
      `DELETE FROM employee_runtime_messages WHERE conversation_id=? AND origin='routine' AND id NOT IN (
        SELECT id FROM employee_runtime_messages WHERE conversation_id=? AND origin='routine' ORDER BY created_at DESC, rowid DESC,id DESC LIMIT ?
      )`, conversationId, conversationId, MAX_ROUTINE_MESSAGES,
    );
  }

  clearConversation(conversationId: string): void {
    const clean = cleanId(conversationId, "conversationId");
    this.exec(`DELETE FROM employee_runtime_messages WHERE conversation_id=?`, clean);
    this.exec(`DELETE FROM employee_runtime_summaries WHERE conversation_id=?`, clean);
    this.exec(`DELETE FROM employee_runtime_executions WHERE conversation_id=?`, clean);
    this.exec(`DELETE FROM employee_runtime_profiles WHERE conversation_id=?`, clean);
    const automatic = this.exec(`SELECT id FROM employee_runtime_memories WHERE conversation_id=? AND origin='automatic'`, clean);
    for (const row of automatic) {
      this.exec(`DELETE FROM employee_runtime_memories WHERE id=?`, String(row.id));
      this.exec(`DELETE FROM employee_runtime_memory_fts WHERE memory_id=?`, String(row.id));
    }
  }

  createMemory(input: EmployeeRuntimeMemoryWrite & { now?: number; origin?: "manual" | "automatic" }): EmployeeRuntimeMemory {
    if (input.scope === "thread" && !input.conversationId) throw new InputError("Thread memories require conversationId.");
    const essentialCount = Number(this.exec(`SELECT COUNT(*) AS n FROM employee_runtime_memories WHERE essential=1`)[0]?.n ?? 0);
    if (essentialCount >= MAX_MEMORIES) throw new InputError("Memory storage is full of essential memories; remove or unmark one before adding more.");
    const now = input.now ?? Date.now();
    const memory: EmployeeRuntimeMemory = {
      id: id("mem"),
      ...(input.conversationId ? { conversationId: cleanId(input.conversationId, "conversationId") } : {}),
      scope: input.scope, kind: input.kind, content: input.content.trim(), essential: input.essential,
      origin: input.origin ?? "manual", createdAt: now, updatedAt: now,
    };
    this.exec(
      `INSERT INTO employee_runtime_memories(id,conversation_id,scope,kind,content,essential,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
      memory.id, memory.conversationId ?? null, memory.scope, memory.kind, memory.content,
      memory.essential ? 1 : 0, memory.origin ?? "manual", memory.createdAt, memory.updatedAt,
    );
    this.exec(`INSERT INTO employee_runtime_memory_fts(memory_id,content) VALUES(?,?)`, memory.id, memory.content);
    this.pruneMemories();
    return memory;
  }

  updateMemory(memoryId: string, input: { content?: string; essential?: boolean; now?: number }): EmployeeRuntimeMemory | null {
    const current = this.getMemory(memoryId);
    if (!current) return null;
    const content = input.content?.trim() || current.content;
    if (!content || content.length > 8000) throw new InputError("Memory content must be 1-8000 characters.");
    const essential = input.essential ?? current.essential;
    const now = input.now ?? Date.now();
    this.exec(`UPDATE employee_runtime_memories SET content=?,essential=?,origin='manual',updated_at=? WHERE id=?`, content, essential ? 1 : 0, now, memoryId);
    this.exec(`DELETE FROM employee_runtime_memory_fts WHERE memory_id=?`, memoryId);
    this.exec(`INSERT INTO employee_runtime_memory_fts(memory_id,content) VALUES(?,?)`, memoryId, content);
    return { ...current, content, essential, origin: "manual", updatedAt: now };
  }

  deleteMemory(memoryId: string): boolean {
    const clean = cleanId(memoryId, "memoryId");
    const existed = this.getMemory(clean) !== null;
    this.exec(`DELETE FROM employee_runtime_memories WHERE id=?`, clean);
    this.exec(`DELETE FROM employee_runtime_memory_fts WHERE memory_id=?`, clean);
    return existed;
  }

  getMemory(memoryId: string): EmployeeRuntimeMemory | null {
    const row = this.exec(`SELECT * FROM employee_runtime_memories WHERE id=?`, cleanId(memoryId, "memoryId"))[0];
    return row ? rowToMemory(row) : null;
  }

  listMemories(input: { conversationId?: string; essential?: boolean; limit?: number; offset?: number } = {}): EmployeeRuntimeMemory[] {
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 100)));
    const offset = Math.max(0, Math.min(10000, Math.floor(input.offset ?? 0)));
    const rows = input.conversationId
      ? this.exec(
        `SELECT * FROM employee_runtime_memories WHERE ${input.essential ? "essential=1 AND " : ""}(scope='employee' OR conversation_id=?) ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
        cleanId(input.conversationId, "conversationId"), limit, offset,
      )
      : this.exec(
        `SELECT * FROM employee_runtime_memories WHERE ${input.essential ? "essential=1 AND " : ""}scope='employee' ORDER BY updated_at DESC LIMIT ? OFFSET ?`, limit, offset,
      );
    return rows.map(rowToMemory);
  }

  searchMemories(query: string, input: { conversationId?: string; limit?: number } = {}): EmployeeRuntimeMemory[] {
    const match = escapeFtsQuery(query);
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
    const rows = input.conversationId
      ? this.exec(
        `SELECT m.* FROM employee_runtime_memory_fts f JOIN employee_runtime_memories m ON m.id=f.memory_id
         WHERE employee_runtime_memory_fts MATCH ? AND (m.scope='employee' OR m.conversation_id=?)
         ORDER BY m.updated_at DESC LIMIT ?`, match, cleanId(input.conversationId, "conversationId"), limit,
      )
      : this.exec(
        `SELECT m.* FROM employee_runtime_memory_fts f JOIN employee_runtime_memories m ON m.id=f.memory_id
         WHERE employee_runtime_memory_fts MATCH ? AND m.scope='employee' ORDER BY m.updated_at DESC LIMIT ?`, match, limit,
      );
    return rows.map(rowToMemory);
  }

  private pruneMemories(): void {
    const stale = this.exec(
      `SELECT id FROM employee_runtime_memories WHERE essential=0 AND id NOT IN (
        SELECT id FROM employee_runtime_memories ORDER BY essential DESC,updated_at DESC LIMIT ?
      )`, MAX_MEMORIES,
    );
    for (const row of stale) {
      const memoryId = String(row.id);
      this.exec(`DELETE FROM employee_runtime_memories WHERE id=?`, memoryId);
      this.exec(`DELETE FROM employee_runtime_memory_fts WHERE memory_id=?`, memoryId);
    }
  }

  createExecution(input: { conversationId: string; mode: EmployeeRuntimeMode; inputJson: string; now?: number }): EmployeeRuntimeExecution {
    const now = input.now ?? Date.now();
    const execution: EmployeeRuntimeExecution = {
      id: id("run"), conversationId: cleanId(input.conversationId, "conversationId"), mode: input.mode,
      status: "running", checkpoint: "accepted", createdAt: now, updatedAt: now,
    };
    this.exec(
      `INSERT INTO employee_runtime_executions(id,conversation_id,mode,status,checkpoint,input_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`,
      execution.id, execution.conversationId, execution.mode, execution.status, execution.checkpoint,
      input.inputJson.slice(0, 16000), execution.createdAt, execution.updatedAt,
    );
    this.pruneExecutions();
    return execution;
  }

  updateExecution(executionId: string, patch: {
    status?: EmployeeRuntimeExecution["status"]; checkpoint?: string; resultJson?: string; error?: string; now?: number;
  }): EmployeeRuntimeExecution | null {
    const current = this.getExecution(executionId);
    if (!current) return null;
    const next: EmployeeRuntimeExecution = {
      ...current,
      status: patch.status ?? current.status,
      checkpoint: (patch.checkpoint ?? current.checkpoint).slice(0, 200),
      updatedAt: patch.now ?? Date.now(),
      ...(patch.error !== undefined ? { error: patch.error.slice(0, 2000) } : {}),
    };
    this.exec(
      `UPDATE employee_runtime_executions SET status=?,checkpoint=?,result_json=COALESCE(?,result_json),error=?,updated_at=? WHERE id=?`,
      next.status, next.checkpoint, patch.resultJson?.slice(0, 16000) ?? null,
      next.error ?? null, next.updatedAt, executionId,
    );
    return next;
  }

  getExecution(executionId: string): EmployeeRuntimeExecution | null {
    const row = this.exec(`SELECT * FROM employee_runtime_executions WHERE id=?`, cleanId(executionId, "executionId"))[0];
    return row ? rowToExecution(row) : null;
  }

  listExecutions(conversationId: string, limit = 100): EmployeeRuntimeExecution[] {
    return this.exec(
      `SELECT * FROM employee_runtime_executions WHERE conversation_id=? ORDER BY created_at DESC, rowid DESC,id DESC LIMIT ?`,
      cleanId(conversationId, "conversationId"), Math.max(1, Math.min(500, Math.floor(limit))),
    ).map(rowToExecution);
  }

  listExecutionsByStatus(status: EmployeeRuntimeExecution["status"], limit = 100, conversationId?: string): EmployeeRuntimeExecution[] {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    return (conversationId
      ? this.exec(
        `SELECT * FROM employee_runtime_executions WHERE status=? AND conversation_id=? ORDER BY created_at DESC, rowid DESC,id DESC LIMIT ?`,
        status, cleanId(conversationId, "conversationId"), boundedLimit,
      )
      : this.exec(
        `SELECT * FROM employee_runtime_executions WHERE status=? ORDER BY created_at DESC, rowid DESC,id DESC LIMIT ?`,
        status, boundedLimit,
      )).map(rowToExecution);
  }

  executionInputJson(executionId: string): string | null {
    const row = this.exec(`SELECT input_json FROM employee_runtime_executions WHERE id=?`, cleanId(executionId, "executionId"))[0];
    return row ? String(row.input_json) : null;
  }

  claimInterruptedExecution(executionId: string, claimToken: string, now = Date.now()): boolean {
    this.exec(
      `UPDATE employee_runtime_executions SET status='running',checkpoint='recovery_inference',error=?,updated_at=? WHERE id=? AND status='interrupted'`,
      claimToken, now, cleanId(executionId, "executionId"),
    );
    return this.getExecution(executionId)?.error === claimToken;
  }

  markInterruptedRunning(now = Date.now(), excludeIds: ReadonlySet<string> = new Set(), conversationId?: string): number {
    const rows = (conversationId
      ? this.exec(`SELECT id FROM employee_runtime_executions WHERE status='running' AND conversation_id=?`, cleanId(conversationId, "conversationId"))
      : this.exec(`SELECT id FROM employee_runtime_executions WHERE status='running'`))
      .filter((row) => !excludeIds.has(String(row.id)));
    for (const row of rows) {
      this.updateExecution(String(row.id), { status: "interrupted", checkpoint: "recovery_required", error: "Execution was interrupted before completion.", now });
    }
    return rows.length;
  }

  private pruneExecutions(): void {
    this.exec(
      `DELETE FROM employee_runtime_executions WHERE id NOT IN (
        SELECT id FROM employee_runtime_executions ORDER BY created_at DESC, rowid DESC,id DESC LIMIT ?
      )`, MAX_EXECUTIONS,
    );
  }
}

function rowToMessage(row: SqlRow): EmployeeRuntimeMessage {
  return {
    id: String(row.id), conversationId: String(row.conversation_id), role: row.role as EmployeeRuntimeMessage["role"],
    content: String(row.content), createdAt: Number(row.created_at),
    ...(row.execution_id != null ? { executionId: String(row.execution_id) } : {}),
    ...(row.origin === "routine" ? { origin: "routine" as const } : {}),
  };
}

function rowToMemory(row: SqlRow): EmployeeRuntimeMemory {
  return {
    id: String(row.id),
    ...(row.conversation_id != null ? { conversationId: String(row.conversation_id) } : {}),
    scope: row.scope as EmployeeRuntimeMemory["scope"], kind: row.kind as EmployeeRuntimeMemory["kind"],
    content: String(row.content), essential: Number(row.essential) === 1,
    ...(row.origin === "automatic" ? { origin: "automatic" as const } : { origin: "manual" as const }),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

function rowToExecution(row: SqlRow): EmployeeRuntimeExecution {
  return {
    id: String(row.id), conversationId: String(row.conversation_id), mode: row.mode as EmployeeRuntimeExecution["mode"],
    status: row.status as EmployeeRuntimeExecution["status"], checkpoint: String(row.checkpoint),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    ...(row.error != null ? { error: String(row.error) } : {}),
  };
}

