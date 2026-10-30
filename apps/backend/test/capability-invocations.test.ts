import { describe, expect, it } from "vitest";
import {
  beginCapabilityInvocation,
  finishCapabilityInvocation,
  listCapabilityInvocations,
  pruneCapabilityInvocations,
  type CapabilityInvocationEnv,
} from "../src/capability-invocations.js";

class InvocationD1 {
  readonly calls: Array<{ sql: string; params: unknown[] }> = [];
  readonly rows = new Map<string, Record<string, unknown>>();
  fail = false;

  prepare(sql: string) {
    const bind = (...params: unknown[]) => ({
      run: async () => {
        if (this.fail) throw new Error("D1 unavailable");
        this.calls.push({ sql, params });
        if (sql.includes("INSERT OR IGNORE INTO capability_invocations")) {
          const [id, org, principal, tool, argsHash, key, created, updated] = params;
          const composite = key == null ? String(id) : `${org}\u0000${principal}\u0000${key}`;
          if (this.rows.has(composite)) return { success: true, meta: { changes: 0 } };
          this.rows.set(composite, { invocation_id: id, org_id: org, principal, tool, args_hash: argsHash, idempotency_key: key, status: "dispatching", created_at: created, updated_at: updated, approval_id: null, error_code: null });
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE capability_invocations SET status = ?")) {
          const row = [...this.rows.values()].find((candidate) => candidate.invocation_id === params[4]);
          if (!row || row.status !== "dispatching") return { success: true, meta: { changes: 0 } };
          Object.assign(row, { status: params[0], updated_at: params[1], approval_id: params[2], error_code: params[3] });
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE capability_invocations SET status = 'unknown_outcome'")) {
          const row = [...this.rows.values()].find((candidate) => candidate.invocation_id === params[1]);
          if (!row || row.status !== "dispatching" || Number(row.updated_at) > Number(params[2])) return { success: true, meta: { changes: 0 } };
          Object.assign(row, { status: "unknown_outcome", updated_at: params[0] });
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 1 } };
      },
      first: async <T,>() => {
        if (this.fail) throw new Error("D1 unavailable");
        this.calls.push({ sql, params });
        const [org, principal, key] = params;
        const row = [...this.rows.values()].find((candidate) => candidate.org_id === org && candidate.principal === principal && candidate.idempotency_key === key);
        return (row ?? null) as T | null;
      },
      all: async <T,>() => {
        if (this.fail) throw new Error("D1 unavailable");
        this.calls.push({ sql, params });
        const limit = Number(params.at(-1));
        const scoped = sql.includes("WHERE org_id = ?")
          ? [...this.rows.values()].filter((row) => row.org_id === params[0])
          : [...this.rows.values()];
        return { results: scoped.sort((a, b) => Number(b.created_at) - Number(a.created_at)).slice(0, limit) as T[], success: true, meta: {} };
      },
    });
    return {
      run: async () => bind().run(),
      bind,
    };
  }
}

function env(): CapabilityInvocationEnv & { db: InvocationD1 } {
  const db = new InvocationD1();
  return { AGENT_AUDIT: db as unknown as D1Database, db };
}

const base = {
  principal: "local-agent",
  orgId: "self-hosted",
  tool: "send_email",
  argsHash: "a".repeat(64),
  idempotencyKey: "request-42",
};

describe("durable MCP invocation receipts", () => {
  it("persists a pending approval pointer without storing arguments or result bodies", async () => {
    const store = env();
    const begin = await beginCapabilityInvocation(store, { ...base, now: 100 });
    expect(begin.kind).toBe("created");
    if (begin.kind !== "created") return;
    expect(await finishCapabilityInvocation(store, {
      invocationId: begin.receipt.invocationId, status: "pending_approval", approvalId: "approval-1", now: 150,
    })).toBe(true);
    const [row] = await listCapabilityInvocations(store, { orgId: "self-hosted", now: 150 });
    expect(row).toMatchObject({
      invocationId: begin.receipt.invocationId,
      tool: "send_email",
      argsHash: "a".repeat(64),
      status: "pending_approval",
      approvalId: "approval-1",
    });
    expect(JSON.stringify(store.db.rows)).not.toContain("private email body");
    expect(store.db.calls.some(({ sql }) => /args_json|result_json|payload/i.test(sql))).toBe(false);
  });

  it("atomically suppresses duplicate requests and rejects a changed payload under the same key", async () => {
    const store = env();
    const first = await beginCapabilityInvocation(store, { ...base, now: 100 });
    const duplicate = await beginCapabilityInvocation(store, { ...base, now: 110 });
    const changed = await beginCapabilityInvocation(store, { ...base, argsHash: "b".repeat(64), now: 120 });
    expect(first.kind).toBe("created");
    expect(duplicate.kind).toBe("replay");
    expect(changed).toEqual({ kind: "payload_conflict" });
    if (first.kind === "created" && duplicate.kind === "replay") {
      expect(duplicate.receipt.invocationId).toBe(first.receipt.invocationId);
      expect(duplicate.receipt.status).toBe("in_progress");
      expect(await finishCapabilityInvocation(store, { invocationId: first.receipt.invocationId, status: "succeeded", now: 130 })).toBe(true);
      expect(await finishCapabilityInvocation(store, { invocationId: first.receipt.invocationId, status: "failed", now: 140 })).toBe(false);
    }
  });

  it("does not re-dispatch a stale unresolved call and exposes unknown outcome", async () => {
    const store = env();
    const first = await beginCapabilityInvocation(store, { ...base, now: 100 });
    expect(first.kind).toBe("created");
    const receipt = await listCapabilityInvocations(store, { now: 30_100 });
    expect(receipt[0]?.status).toBe("unknown_outcome");
    const retry = await beginCapabilityInvocation(store, { ...base, now: 30_100 });
    expect(retry.kind).toBe("replay");
    if (retry.kind === "replay") expect(retry.receipt.status).toBe("unknown_outcome");
  });

  it("fails closed on D1 outage or malformed idempotency keys", async () => {
    const store = env();
    store.db.fail = true;
    expect(await beginCapabilityInvocation(store, base)).toEqual({ kind: "failed" });
    store.db.fail = false;
    expect(await beginCapabilityInvocation(store, { ...base, idempotencyKey: "not safe\n" })).toEqual({ kind: "failed" });
  });

  it("keeps invocation receipts under the audit retention window", async () => {
    const store = env();
    await expect(pruneCapabilityInvocations(store, 500)).resolves.toBe(1);
    expect(store.db.calls.some(({ sql }) => sql.includes("DELETE FROM capability_invocations WHERE created_at < ?"))).toBe(true);
  });
});
