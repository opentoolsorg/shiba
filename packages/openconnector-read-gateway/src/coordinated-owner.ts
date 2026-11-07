import { AsyncLocalStorage } from "node:async_hooks";
import { boundedBody } from "./json.js";
import { OperatorGateError } from "./operator-envelope.js";

interface OwnerScope { owner: CoordinatedOwner; database: CoordinatedD1 | undefined; active: boolean; pending: Set<Promise<unknown>>; failures: boolean }
// Native appCache outlives individual DO instances. Its facade resolves the current scope, never an old instance/binding.
const activeScopes = new AsyncLocalStorage<OwnerScope>();
export interface CoordinatedExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): never;
}
/** Structural D1 methods used by the entire pinned native Worker, including cron and cached applications. */
export interface CoordinatedD1Statement {
  bind(...values: unknown[]): CoordinatedD1Statement;
  first<T = unknown>(column?: string): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean; meta: { changes?: number } }>;
}
export interface CoordinatedD1 {
  prepare(sql: string): CoordinatedD1Statement;
  batch(statements: CoordinatedD1Statement[]): Promise<{ results: Record<string, unknown>[] | null }[]>;
}

/**
 * One instance in ONE Durable Object owns all native traffic and operator dispatch.
 * Never use one instance per request or per epoch: old epochs must share the same owner.
 * No time-based lease, timeout release or background dispatch is supported.
 */
export class CoordinatedOwner {
  private databaseBinding: CoordinatedD1 | undefined;
  private tail: Promise<void> = Promise.resolve();
  private poisoned = false;
  private readonly statements = new WeakMap<CoordinatedD1Statement, { raw: CoordinatedD1Statement; scope: OwnerScope }>();
  private scope(): OwnerScope {
    const scope = activeScopes.getStore();
    if (!scope?.active || scope.owner.poisoned) throw new OperatorGateError("operator_scope_closed", 503);
    return scope;
  }
  private track<T>(work: () => Promise<T>): Promise<T> {
    const scope = this.scope();
    const task = Promise.resolve().then(() => { this.assertScope(scope); return work(); });
    scope.pending.add(task);
    void task.then(() => scope.pending.delete(task), () => { scope.pending.delete(task); scope.failures = true; });
    return task;
  }
  private assertScope(expected: OwnerScope): void {
    if (this.scope() !== expected) throw new OperatorGateError("operator_scope_mismatch", 503);
  }
  /** This single permanent facade is the only DB object ever handed to native appCache. */
  database(raw: CoordinatedD1): CoordinatedD1 {
    if (this.databaseBinding && this.databaseBinding !== raw) throw new OperatorGateError("operator_database_already_bound", 503);
    this.databaseBinding = raw;
    const currentDatabase = () => { const scope = this.scope(); if (!scope.database) throw new OperatorGateError("operator_database_unbound", 503); return scope.database; };
    const wrap = (statement: CoordinatedD1Statement, scope: OwnerScope): CoordinatedD1Statement => {
      const guarded: CoordinatedD1Statement = {
        bind: (...values) => { this.assertScope(scope); return wrap(statement.bind(...values), scope); },
        first: <T>(column?: string) => this.track(() => { this.assertScope(scope); return statement.first<T>(column); }),
        all: <T>() => this.track(() => { this.assertScope(scope); return statement.all<T>(); }),
        run: () => this.track(() => { this.assertScope(scope); return statement.run(); }),
      };
      this.statements.set(guarded, { raw: statement, scope }); return guarded;
    };
    return Object.freeze({
      prepare: (sql: string) => wrap(currentDatabase().prepare(sql), this.scope()),
      batch: (statements: CoordinatedD1Statement[]) => {
        const scope = this.scope();
        const originals = statements.map(statement => { const bound = this.statements.get(statement); if (!bound || bound.scope !== scope) throw new OperatorGateError("operator_statement_scope_invalid", 503); return bound.raw; });
        return this.track(() => currentDatabase().batch(originals));
      },
    });
  }
  run<T>(operation: (ctx: CoordinatedExecutionContext) => Promise<T>): Promise<T> {
    // Nested jobs would deadlock or weaken serialization. A callback must use its existing scope.
    if (activeScopes.getStore()?.active) return Promise.reject(new OperatorGateError("operator_nested_owner", 503));
    const next = this.tail.then(async () => {
      if (this.poisoned) throw new OperatorGateError("operator_owner_unavailable", 503);
      const scope: OwnerScope = { owner: this, database: this.databaseBinding, active: true, pending: new Set(), failures: false };
      return activeScopes.run(scope, async () => {
        const ctx: CoordinatedExecutionContext = {
          waitUntil: promise => { this.assertScope(scope); scope.pending.add(promise); void promise.then(() => scope.pending.delete(promise), () => { scope.pending.delete(promise); scope.failures = true; }); },
          passThroughOnException: () => { throw new OperatorGateError("operator_passthrough_forbidden", 503); },
        };
        try { return await operation(ctx); }
        finally {
          // Includes SQL issued but not awaited by native code, and recursively added waitUntil work.
          // An unresolved write holds the owner indefinitely rather than releasing a stale lease.
          while (scope.pending.size) await Promise.allSettled([...scope.pending]);
          scope.active = false;
          // Storage/background failures are not safe signals that native work completed.
          if (scope.failures) this.poisoned = true;
        }
      });
    });
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }
  barrier(): Promise<void> { return this.run(async () => undefined); }
  /** Consume continuations before releasing the guard. WebSockets and SSE are intentionally unsupported. */
  nativeFetch(handler: (ctx: CoordinatedExecutionContext) => Promise<Response>): Promise<Response> {
    return this.run(async ctx => {
      const response = await handler(ctx);
      if (response.status === 101 || response.headers.get("content-type")?.includes("text/event-stream")) {
        await response.body?.cancel(); throw new OperatorGateError("operator_streaming_native_unsupported", 503);
      }
      const body = await boundedBody(response.body, 8 * 1024 * 1024);
      return new Response([101, 204, 205, 304].includes(response.status) ? null : body.buffer as ArrayBuffer, { status: response.status, statusText: response.statusText, headers: response.headers });
    });
  }
}
