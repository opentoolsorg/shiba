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
const MAX_MEMORIES = 1000;
const MAX_EXECUTIONS = 500;

export const EMPLOYEE_RUNTIME_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS employee_runtime_messages(
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS employee_runtime_messages_conversation
    ON employee_runtime_messages(conversation_id,created_at,id)`,
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
  if (!clean || clean.length > 128) throw new InputError(`${label} must be 1-128 characters.`);
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

export class EmployeeRuntimeStore {
  constructor(private readonly exec: SqlExec) {}

  init(): void {
    for (const statement of EMPLOYEE_RUNTIME_SCHEMA) this.exec(statement);
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

  appendMessage(input: { conversationId: string; role: EmployeeRuntimeMessage["role"]; content: string; now?: number }): EmployeeRuntimeMessage {
    const content = input.content.trim();
    if (!content || content.length > 16000) throw new InputError("Message content must be 1-16000 characters.");
    const message: EmployeeRuntimeMessage = {
      id: id("msg"), conversationId: cleanId(input.conversationId, "conversationId"), role: input.role,
      content, createdAt: input.now ?? Date.now(),
    };
    this.exec(
      `INSERT INTO employee_runtime_messages(id,conversation_id,role,content,created_at) VALUES(?,?,?,?,?)`,
      message.id, message.conversationId, message.role, message.content, message.createdAt,
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

  private pruneMessages(conversationId: string): void {
    this.exec(
      `DELETE FROM employee_runtime_messages WHERE conversation_id=? AND id NOT IN (
        SELECT id FROM employee_runtime_messages WHERE conversation_id=? ORDER BY created_at DESC, rowid DESC,id DESC LIMIT ?
      )`, conversationId, conversationId, MAX_MESSAGES,
    );
  }

  createMemory(input: EmployeeRuntimeMemoryWrite & { now?: number }): EmployeeRuntimeMemory {
    if (input.scope === "thread" && !input.conversationId) throw new InputError("Thread memories require conversationId.");
    const now = input.now ?? Date.now();
    const memory: EmployeeRuntimeMemory = {
      id: id("mem"),
      ...(input.conversationId ? { conversationId: cleanId(input.conversationId, "conversationId") } : {}),
      scope: input.scope, kind: input.kind, content: input.content.trim(), essential: input.essential,
      createdAt: now, updatedAt: now,
    };
    this.exec(
      `INSERT INTO employee_runtime_memories(id,conversation_id,scope,kind,content,essential,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`,
      memory.id, memory.conversationId ?? null, memory.scope, memory.kind, memory.content,
      memory.essential ? 1 : 0, memory.createdAt, memory.updatedAt,
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
    this.exec(`UPDATE employee_runtime_memories SET content=?,essential=?,updated_at=? WHERE id=?`, content, essential ? 1 : 0, now, memoryId);
    this.exec(`DELETE FROM employee_runtime_memory_fts WHERE memory_id=?`, memoryId);
    this.exec(`INSERT INTO employee_runtime_memory_fts(memory_id,content) VALUES(?,?)`, memoryId, content);
    return { ...current, content, essential, updatedAt: now };
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

  listMemories(input: { conversationId?: string; essential?: boolean; limit?: number } = {}): EmployeeRuntimeMemory[] {
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 100)));
    const rows = input.essential
      ? this.exec(`SELECT * FROM employee_runtime_memories WHERE essential=1 ORDER BY updated_at DESC LIMIT ?`, limit)
      : input.conversationId
        ? this.exec(
          `SELECT * FROM employee_runtime_memories WHERE scope='employee' OR conversation_id=? ORDER BY updated_at DESC LIMIT ?`,
          cleanId(input.conversationId, "conversationId"), limit,
        )
        : this.exec(`SELECT * FROM employee_runtime_memories ORDER BY updated_at DESC LIMIT ?`, limit);
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
         WHERE employee_runtime_memory_fts MATCH ? ORDER BY m.updated_at DESC LIMIT ?`, match, limit,
      );
    return rows.map(rowToMemory);
  }

  private pruneMemories(): void {
    const stale = this.exec(
      `SELECT id FROM employee_runtime_memories WHERE id NOT IN (
        SELECT id FROM employee_runtime_memories ORDER BY updated_at DESC LIMIT ?
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

  markInterruptedRunning(now = Date.now(), excludeIds: ReadonlySet<string> = new Set()): number {
    const rows = this.exec(`SELECT id FROM employee_runtime_executions WHERE status='running'`)
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
  };
}

function rowToMemory(row: SqlRow): EmployeeRuntimeMemory {
  return {
    id: String(row.id),
    ...(row.conversation_id != null ? { conversationId: String(row.conversation_id) } : {}),
    scope: row.scope as EmployeeRuntimeMemory["scope"], kind: row.kind as EmployeeRuntimeMemory["kind"],
    content: String(row.content), essential: Number(row.essential) === 1,
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

