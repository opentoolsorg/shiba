import { AsyncLocalStorage } from "node:async_hooks";

export type RequestTiming = {
  start: number;
  authMs: number;
  dbMs: number;
  dbCount: number;
};

const context = new AsyncLocalStorage<RequestTiming>();
const databases = new WeakMap<D1Database, D1Database>();
const environments = new WeakMap<object, object>();
const statements = new WeakMap<object, D1PreparedStatement>();

export async function timeAuth<T>(resolve: () => Promise<T>): Promise<T> {
  const marks = context.getStore();
  const start = performance.now();
  try {
    return await resolve();
  } finally {
    if (marks) marks.authMs += performance.now() - start;
  }
}

async function timeDatabase<T>(run: () => Promise<T>, count = 1): Promise<T> {
  const marks = context.getStore();
  const start = performance.now();
  if (marks) marks.dbCount += count;
  try {
    return await run();
  } finally {
    if (marks) marks.dbMs += performance.now() - start;
  }
}

function instrumentStatement(statement: D1PreparedStatement): D1PreparedStatement {
  const wrapped = new Proxy(statement, {
    get(target, key) {
      if (key === "bind") return (...args: unknown[]) => instrumentStatement(target.bind(...args));
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (key === "first" || key === "all" || key === "run" || key === "raw") {
        return (...args: unknown[]) => timeDatabase(() => value.apply(target, args));
      }
      return value.bind(target);
    },
  });
  statements.set(wrapped, statement);
  return wrapped;
}

/** Stable proxies keep the auth instance and schema caches warm across requests. */
export function withTimingDatabase<T extends { AGENT_AUDIT?: D1Database }>(env: T): T {
  const cached = environments.get(env);
  if (cached) return cached as T;
  const wrapped = new Proxy(env, {
    get(target, key) {
      if (key !== "AGENT_AUDIT") return Reflect.get(target, key, target);
      const value = target.AGENT_AUDIT;
      if (!value) return value;
      let db = databases.get(value);
      if (!db) {
        db = new Proxy(value as D1Database, {
          get(database, method) {
            if (method === "prepare") return (sql: string) => instrumentStatement(database.prepare(sql));
            if (method === "batch") return (batch: D1PreparedStatement[]) => timeDatabase(
              () => database.batch(batch.map(statement => statements.get(statement) ?? statement)), batch.length,
            );
            const member = Reflect.get(database, method, database);
            if (method === "exec") return (sql: string) => timeDatabase(() => database.exec(sql));
            return typeof member === "function" ? member.bind(database) : member;
          },
        });
        databases.set(value, db);
      }
      return db;
    },
  });
  environments.set(env, wrapped);
  return wrapped;
}

export async function withRequestTiming(request: Request, handle: () => Promise<Response>): Promise<Response> {
  if (!new URL(request.url).pathname.startsWith("/api/")) return handle();
  const marks: RequestTiming = { start: performance.now(), authMs: 0, dbMs: 0, dbCount: 0 };
  return context.run(marks, async () => {
    const response = await handle();
    const timing = `total;dur=${Math.round(performance.now() - marks.start)}, auth;dur=${Math.round(marks.authMs)}, db;dur=${Math.round(marks.dbMs)};desc="n=${marks.dbCount}"`;
    // Mutating the original preserves streaming bodies and WebSocket upgrades.
    try {
      response.headers.append("Server-Timing", timing);
      return response;
    } catch {
      const headers = new Headers(response.headers);
      headers.append("Server-Timing", timing);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers,
        ...(response.webSocket ? { webSocket: response.webSocket } : {}),
      });
    }
  });
}
