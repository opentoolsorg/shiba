import { randomHex } from "./mailbox-store.js";

export type CapabilityInvocationStatus =
  | "dispatching"
  | "succeeded"
  | "pending_approval"
  | "approved"
  | "denied"
  | "failed"
  | "unknown_outcome";

export interface CapabilityInvocationReceipt {
  invocationId: string;
  createdAt: number;
  updatedAt: number;
  principal: string;
  tool: string;
  argsHash: string;
  status: Exclude<CapabilityInvocationStatus, "dispatching"> | "in_progress";
  approvalId?: string;
  errorCode?: string;
  replayed?: true;
}

export interface CapabilityInvocationEnv {
  AGENT_AUDIT: D1Database;
}

export interface BeginInvocationInput {
  principal: string;
  orgId: string;
  tool: string;
  argsHash: string;
  idempotencyKey?: string;
  now?: number;
}

export type BeginInvocationResult =
  | { kind: "created"; receipt: CapabilityInvocationReceipt }
  | { kind: "replay"; receipt: CapabilityInvocationReceipt }
  | { kind: "payload_conflict" }
  | { kind: "failed" };

export const CAPABILITY_INVOCATION_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS capability_invocations (
    invocation_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    principal TEXT NOT NULL,
    tool TEXT NOT NULL,
    args_hash TEXT NOT NULL,
    idempotency_key TEXT,
    status TEXT NOT NULL CHECK (status IN ('dispatching','succeeded','pending_approval','approved','denied','failed','unknown_outcome')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    approval_id TEXT,
    error_code TEXT,
    UNIQUE (org_id, principal, idempotency_key)
  )`,
  `CREATE INDEX IF NOT EXISTS capability_invocations_created ON capability_invocations(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS capability_invocations_status_updated ON capability_invocations(status, updated_at)`,
] as const;

export const CAPABILITY_INVOCATION_UNKNOWN_AFTER_MS = 30_000;
export const MAX_CAPABILITY_INVOCATIONS = 50;
export const EMPLOYEE_ACTION_IDEMPOTENCY_PREFIX = "employee-action:";
const initialized = new WeakSet<D1Database>();

interface StoredInvocation {
  invocation_id: string;
  created_at: number;
  updated_at: number;
  principal: string;
  tool: string;
  args_hash: string;
  status: CapabilityInvocationStatus;
  approval_id: string | null;
  error_code: string | null;
}

async function ensureTable(env: CapabilityInvocationEnv): Promise<void> {
  if (initialized.has(env.AGENT_AUDIT)) return;
  for (const statement of CAPABILITY_INVOCATION_STATEMENTS) {
    await env.AGENT_AUDIT.prepare(statement).run();
  }
  initialized.add(env.AGENT_AUDIT);
}

function publicStatus(row: StoredInvocation, now: number): CapabilityInvocationReceipt["status"] {
  if (row.status === "dispatching") {
    return now - row.updated_at >= CAPABILITY_INVOCATION_UNKNOWN_AFTER_MS
      ? "unknown_outcome"
      : "in_progress";
  }
  return row.status;
}

function receipt(row: StoredInvocation, now = Date.now(), replayed = false): CapabilityInvocationReceipt {
  return {
    invocationId: row.invocation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    principal: row.principal,
    tool: row.tool,
    argsHash: row.args_hash,
    status: publicStatus(row, now),
    ...(row.approval_id ? { approvalId: row.approval_id } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(replayed ? { replayed: true as const } : {}),
  };
}

function validIdempotencyKey(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);
}

/** Insert a durable dispatch fence; a unique principal/key pair prevents concurrent replay. */
export async function beginCapabilityInvocation(
  env: CapabilityInvocationEnv,
  input: BeginInvocationInput,
): Promise<BeginInvocationResult> {
  if (!input.principal || !input.orgId || !input.tool || !/^[0-9a-f]{64}$/.test(input.argsHash)) return { kind: "failed" };
  if (input.idempotencyKey !== undefined && !validIdempotencyKey(input.idempotencyKey)) return { kind: "failed" };
  const now = input.now ?? Date.now();
  const invocationId = `inv-${randomHex(16)}`;
  try {
    await ensureTable(env);
    const inserted = await env.AGENT_AUDIT.prepare(
      `INSERT OR IGNORE INTO capability_invocations
       (invocation_id, org_id, principal, tool, args_hash, idempotency_key, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'dispatching', ?, ?)`,
    ).bind(invocationId, input.orgId, input.principal, input.tool, input.argsHash, input.idempotencyKey ?? null, now, now).run();
    const changes = inserted.meta?.changes;
    if (changes === 1 || (changes === undefined && input.idempotencyKey === undefined)) {
      return {
        kind: "created",
        receipt: {
          invocationId, createdAt: now, updatedAt: now, principal: input.principal,
          tool: input.tool, argsHash: input.argsHash, status: "in_progress",
        },
      };
    }
    const existing = await env.AGENT_AUDIT.prepare(
      `SELECT invocation_id, created_at, updated_at, principal, tool, args_hash, status, approval_id, error_code
       FROM capability_invocations WHERE org_id = ? AND principal = ? AND idempotency_key = ? LIMIT 1`,
    ).bind(input.orgId, input.principal, input.idempotencyKey).first<StoredInvocation>();
    if (!existing) return { kind: "failed" };
    if (existing.tool !== input.tool || existing.args_hash !== input.argsHash) return { kind: "payload_conflict" };
    return { kind: "replay", receipt: receipt(existing, now, true) };
  } catch {
    return { kind: "failed" };
  }
}

/** Read the durable fence for one employee approval without invoking a tool. */
export async function getCapabilityInvocationByIdempotencyKey(
  env: CapabilityInvocationEnv,
  input: { orgId: string; principal: string; idempotencyKey: string; now?: number },
): Promise<CapabilityInvocationReceipt | null> {
  await ensureTable(env);
  const row = await env.AGENT_AUDIT.prepare(
    `SELECT invocation_id, created_at, updated_at, principal, tool, args_hash, status, approval_id, error_code
     FROM capability_invocations WHERE org_id = ? AND principal = ? AND idempotency_key = ? LIMIT 1`,
  ).bind(input.orgId, input.principal, input.idempotencyKey).first<StoredInvocation>();
  return row ? receipt(row, input.now ?? Date.now()) : null;
}

export type EmployeeActionInvocationClaim =
  | { kind: "claimed" | "replay"; receipt: CapabilityInvocationReceipt }
  | { kind: "expired" | "consumed_receipt_missing" | "not_approved" | "payload_conflict" | "failed" };

/**
 * Atomically consume an approved employee action and insert its invocation
 * fence. Expiration uses SQLite's clock in production, at statement execution;
 * `now` exists only for deterministic store tests. Either this transaction
 * claims the one stable key, or expiration wins and no receipt is inserted.
 */
export async function claimEmployeeActionInvocation(
  env: CapabilityInvocationEnv,
  input: {
    approvalId: string; orgId: string; principal: string; tool: string;
    argsHash: string; idempotencyKey: string; now?: number;
  },
): Promise<EmployeeActionInvocationClaim> {
  if (!input.approvalId || !input.orgId || !input.principal || !input.tool ||
      !/^[0-9a-f]{64}$/.test(input.argsHash) ||
      input.idempotencyKey !== `${EMPLOYEE_ACTION_IDEMPOTENCY_PREFIX}${input.approvalId}`) return { kind: "failed" };
  const invocationId = `inv-${randomHex(16)}`;
  const timeExpression = input.now === undefined ? "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)" : "?";
  const timeBindings = input.now === undefined ? [] : [input.now];
  try {
    await ensureTable(env);
    await env.AGENT_AUDIT.batch([
      env.AGENT_AUDIT.prepare(`UPDATE employee_tool_approvals
        SET consumed_at = COALESCE(consumed_at, ${timeExpression}),
            consumed_invocation_id = COALESCE(consumed_invocation_id, (
              SELECT invocation_id FROM capability_invocations
              WHERE org_id = ? AND principal = ? AND idempotency_key = ? AND tool = ? AND args_hash = ? LIMIT 1
            ))
        WHERE approval_id = ? AND org_id = ? AND actor_id = ? AND status = 'approved'
          AND consumed_at IS NULL AND consumed_invocation_id IS NULL
          AND EXISTS (
            SELECT 1 FROM capability_invocations
            WHERE org_id = ? AND principal = ? AND idempotency_key = ? AND tool = ? AND args_hash = ?
          )`)
        .bind(...timeBindings, input.orgId, input.principal, input.idempotencyKey, input.tool, input.argsHash,
          input.approvalId, input.orgId, input.principal,
          input.orgId, input.principal, input.idempotencyKey, input.tool, input.argsHash),
      env.AGENT_AUDIT.prepare(`UPDATE employee_tool_approvals
        SET consumed_at = COALESCE(consumed_at, ${timeExpression}), consumed_invocation_id = COALESCE(consumed_invocation_id, ?)
        WHERE approval_id = ? AND org_id = ? AND actor_id = ? AND status = 'approved'
          AND expires_at > ${timeExpression} AND consumed_at IS NULL AND consumed_invocation_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM capability_invocations WHERE org_id = ? AND principal = ? AND idempotency_key = ?
          )`)
        .bind(...timeBindings, invocationId, input.approvalId, input.orgId, input.principal, ...timeBindings,
          input.orgId, input.principal, input.idempotencyKey),
      env.AGENT_AUDIT.prepare(`UPDATE employee_tool_approvals SET status = 'expired'
        WHERE approval_id = ? AND org_id = ? AND actor_id = ? AND status = 'approved'
          AND expires_at <= ${timeExpression} AND consumed_at IS NULL AND consumed_invocation_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM capability_invocations WHERE org_id = ? AND principal = ? AND idempotency_key = ?
          )`)
        .bind(input.approvalId, input.orgId, input.principal, ...timeBindings,
          input.orgId, input.principal, input.idempotencyKey),
      env.AGENT_AUDIT.prepare(`INSERT OR IGNORE INTO capability_invocations
        (invocation_id, org_id, principal, tool, args_hash, idempotency_key, status, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, 'dispatching', ${timeExpression}, ${timeExpression}
        WHERE EXISTS (
          SELECT 1 FROM employee_tool_approvals
          WHERE approval_id = ? AND org_id = ? AND actor_id = ? AND status = 'approved'
            AND consumed_invocation_id = ?
        )`)
        .bind(invocationId, input.orgId, input.principal, input.tool, input.argsHash, input.idempotencyKey,
          ...timeBindings, ...timeBindings, input.approvalId, input.orgId, input.principal, invocationId),
    ]);
    const existing = await getCapabilityInvocationByIdempotencyKey(env, {
      orgId: input.orgId, principal: input.principal, idempotencyKey: input.idempotencyKey,
      ...(input.now !== undefined ? { now: input.now } : {}),
    });
    if (existing) {
      if (existing.tool !== input.tool || existing.argsHash !== input.argsHash) return { kind: "payload_conflict" };
      return { kind: existing.invocationId === invocationId ? "claimed" : "replay", receipt: existing };
    }
    const approval = await env.AGENT_AUDIT.prepare(`SELECT status, consumed_invocation_id
      FROM employee_tool_approvals WHERE approval_id = ? AND org_id = ? AND actor_id = ? LIMIT 1`)
      .bind(input.approvalId, input.orgId, input.principal).first<{ status: string; consumed_invocation_id: string | null }>();
    if (approval?.consumed_invocation_id) return { kind: "consumed_receipt_missing" };
    if (approval?.status === "expired") return { kind: "expired" };
    return { kind: "not_approved" };
  } catch {
    return { kind: "failed" };
  }
}

export async function finishCapabilityInvocation(
  env: CapabilityInvocationEnv,
  input: {
    invocationId: string;
    status: Exclude<CapabilityInvocationStatus, "dispatching">;
    approvalId?: string;
    errorCode?: string;
    now?: number;
  },
): Promise<boolean> {
  try {
    await ensureTable(env);
    const result = await env.AGENT_AUDIT.prepare(
      `UPDATE capability_invocations SET status = ?, updated_at = ?, approval_id = ?, error_code = ?
       WHERE invocation_id = ? AND status = 'dispatching'`,
    ).bind(input.status, input.now ?? Date.now(), input.approvalId ?? null, input.errorCode ?? null, input.invocationId).run();
    // Cloudflare D1 always supplies `meta.changes`; a few supported D1
    // compatibility bindings omit it while still resolving successful writes.
    return result.meta?.changes === undefined ? true : result.meta.changes === 1;
  } catch {
    return false;
  }
}

/** Record the durable human decision without claiming the approved action finished. */
export async function resolveCapabilityInvocationApproval(
  env: CapabilityInvocationEnv,
  input: { approvalId: string; status: "approved" | "denied" | "failed"; errorCode?: string; now?: number },
): Promise<number> {
  if (!input.approvalId) return 0;
  try {
    await ensureTable(env);
    const result = await env.AGENT_AUDIT.prepare(
      `UPDATE capability_invocations SET status = ?, updated_at = ?, error_code = ?
       WHERE approval_id = ? AND status = 'pending_approval'`,
    ).bind(input.status, input.now ?? Date.now(), input.errorCode ?? (input.status === "denied" ? "approval_rejected" : null), input.approvalId).run();
    return typeof result.meta?.changes === "number" ? result.meta.changes : 0;
  } catch {
    return 0;
  }
}

/** Settle an approved tool receipt when its associated run or side effect finishes. */
export async function finishCapabilityInvocationApproval(
  env: CapabilityInvocationEnv,
  input: { approvalId: string; status: "succeeded" | "failed" | "unknown_outcome"; errorCode?: string; now?: number },
): Promise<number> {
  if (!input.approvalId) return 0;
  try {
    await ensureTable(env);
    const result = await env.AGENT_AUDIT.prepare(
      `UPDATE capability_invocations SET status = ?, updated_at = ?, error_code = ?
       WHERE approval_id = ? AND status = 'approved'`,
    ).bind(input.status, input.now ?? Date.now(), input.errorCode ?? null, input.approvalId).run();
    return typeof result.meta?.changes === "number" ? result.meta.changes : 0;
  } catch {
    return 0;
  }
}

export async function resolveDispatchingAsUnknown(
  env: CapabilityInvocationEnv,
  invocationId: string,
  now = Date.now(),
): Promise<void> {
  try {
    await ensureTable(env);
    await env.AGENT_AUDIT.prepare(
      `UPDATE capability_invocations SET status = 'unknown_outcome', updated_at = ?
       WHERE invocation_id = ? AND status = 'dispatching' AND updated_at <= ?`,
    ).bind(now, invocationId, now - CAPABILITY_INVOCATION_UNKNOWN_AFTER_MS).run();
  } catch {
    // A persisted dispatching row remains visible and is projected as unknown_outcome after its lease.
  }
}

export async function listCapabilityInvocations(
  env: CapabilityInvocationEnv,
  options: { limit?: number; orgId?: string; now?: number } = {},
): Promise<CapabilityInvocationReceipt[]> {
  await ensureTable(env);
  const limit = Math.max(1, Math.min(MAX_CAPABILITY_INVOCATIONS, Math.floor(options.limit ?? 25)));
  const rows = options.orgId
    ? await env.AGENT_AUDIT.prepare(
        `SELECT invocation_id, created_at, updated_at, principal, tool, args_hash, status, approval_id, error_code
         FROM capability_invocations WHERE org_id = ? ORDER BY created_at DESC LIMIT ?`,
      ).bind(options.orgId, limit).all<StoredInvocation>()
    : await env.AGENT_AUDIT.prepare(
        `SELECT invocation_id, created_at, updated_at, principal, tool, args_hash, status, approval_id, error_code
         FROM capability_invocations ORDER BY created_at DESC LIMIT ?`,
      ).bind(limit).all<StoredInvocation>();
  return (rows.results ?? []).map((row) => receipt(row, options.now ?? Date.now()));
}

export async function pruneCapabilityInvocations(env: CapabilityInvocationEnv, cutoff: number): Promise<number> {
  await ensureTable(env);
  const result = await env.AGENT_AUDIT.prepare(
    `DELETE FROM capability_invocations WHERE created_at < ?`,
  ).bind(cutoff).run();
  return typeof result.meta?.changes === "number" ? result.meta.changes : 0;
}

/**
 * Atomically release an expired employee write approval only when its durable
 * dispatch key has never been consumed. Any receipt state fences replay,
 * including dispatching/in-progress, pending approvals, success, failure or
 * unknown outcome. Caller initializes the employee approval table first.
 */
export async function expireUnusedEmployeeActionApproval(
  env: CapabilityInvocationEnv,
  input: { approvalId: string; orgId: string; principal: string; now?: number },
): Promise<boolean> {
  await ensureTable(env);
  const key = `${EMPLOYEE_ACTION_IDEMPOTENCY_PREFIX}${input.approvalId}`;
  const timeExpression = input.now === undefined ? "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)" : "?";
  const timeBindings = input.now === undefined ? [] : [input.now];
  const statements = await env.AGENT_AUDIT.batch([
    env.AGENT_AUDIT.prepare(`UPDATE employee_tool_approvals
      SET consumed_at = COALESCE(consumed_at, ${timeExpression}),
          consumed_invocation_id = COALESCE(consumed_invocation_id, (
            SELECT invocation_id FROM capability_invocations
            WHERE org_id = ? AND principal = ? AND idempotency_key = ? LIMIT 1
          ))
      WHERE approval_id = ? AND org_id = ? AND actor_id = ? AND status = 'approved'
        AND consumed_at IS NULL AND consumed_invocation_id IS NULL AND expires_at <= ${timeExpression}
        AND EXISTS (
          SELECT 1 FROM capability_invocations
          WHERE org_id = ? AND principal = ? AND idempotency_key = ?
        )`)
      .bind(...timeBindings, input.orgId, input.principal, key, input.approvalId, input.orgId, input.principal, ...timeBindings,
        input.orgId, input.principal, key),
    env.AGENT_AUDIT.prepare(`UPDATE employee_tool_approvals
      SET status = 'expired'
      WHERE approval_id = ? AND org_id = ? AND actor_id = ? AND status = 'approved'
        AND consumed_at IS NULL AND consumed_invocation_id IS NULL AND expires_at <= ${timeExpression}
        AND NOT EXISTS (
          SELECT 1 FROM capability_invocations
          WHERE org_id = ? AND principal = ? AND idempotency_key = ?
        )`)
      .bind(input.approvalId, input.orgId, input.principal, ...timeBindings, input.orgId, input.principal, key),
  ]);
  return statements[1]?.meta?.changes === 1;
}

/** Extract the optional Shiba idempotency extension from MCP request metadata. */
export function mcpIdempotencyKey(meta: unknown): string | undefined {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return undefined;
  const record = meta as Record<string, unknown>;
  const value = record["com.shiba/idempotencyKey"];
  return typeof value === "string" && validIdempotencyKey(value) ? value : undefined;
}
