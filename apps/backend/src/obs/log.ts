/**
 * Structured operational logging (target-architecture M03).
 *
 * One JSON object per line through `console.*` — Workers Logs ingests it
 * natively, so previews are queryable without a log shipper. Every line
 * carries `ts`, `level`, `service`, and `msg`; contextual ids
 * (`requestId`, `threadId`, `runId`, …) come from an AsyncLocalStorage
 * scope installed at entry boundaries (`withLogContext`) and are merged
 * into each line automatically.
 *
 * Call-site shapes mirror `console.*` so the M03 sweep stays mechanical:
 *
 *   log.error("Slack mention dispatch failed", redactSecrets(String(error)));
 *   log.warn("memory_sweep_failed", { instance: this.agent, error: message });
 *   log.info("audit.prune", { deleted: auditDeleted });
 *
 * Extra positional args are normalized into fields: an `Error` becomes
 * `error: { name, message, stack }` (redacted, stack capped), a plain
 * object is merged field-by-field, and strings/scalars join `detail`.
 * Per-call fields override context fields of the same name; the envelope
 * keys (`ts`, `level`, `service`, `msg`) always win.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { redactSecrets } from "../security.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Context fields merged into every line emitted inside `withLogContext`. */
export interface LogContextFields {
  requestId?: string;
  threadId?: string;
  runId?: string;
  [key: string]: unknown;
}

const storage = new AsyncLocalStorage<LogContextFields>();

/** Run `fn` with `fields` merged into the ambient log context. */
export function withLogContext<T>(fields: LogContextFields, fn: () => T): T {
  const parent = storage.getStore();
  return storage.run({ ...parent, ...definedEntries(fields) }, fn);
}

/**
 * Merge `fields` into the active context mid-flight (e.g. a thread id that
 * is only known after early returns). No-op outside `withLogContext`.
 */
export function extendLogContext(fields: LogContextFields): void {
  const store = storage.getStore();
  if (store === undefined) return;
  Object.assign(store, definedEntries(fields));
}

/** The active context, or undefined outside `withLogContext`. */
export function currentLogContext(): LogContextFields | undefined {
  return storage.getStore();
}

const MAX_ERROR_STACK = 2000;
const MAX_DEPTH = 6;

function definedEntries(fields: LogContextFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function serializeError(error: Error): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: error.name,
    message: redactSecrets(error.message),
  };
  if (typeof error.stack === "string" && error.stack !== "") {
    out.stack = redactSecrets(error.stack.slice(0, MAX_ERROR_STACK));
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-normalize a field value into something `JSON.stringify` accepts:
 * secrets scrubbed from every string, Errors shaped, cycles and excess
 * depth replaced with markers, bigint/function/symbol dropped.
 */
function normalizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return redactSecrets(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return serializeError(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return "[circular]";
  if (depth <= 0) return "[truncated]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value
        .map((item) => normalizeValue(item, depth - 1, seen))
        .filter((item) => item !== undefined);
    }
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        const normalized = normalizeValue(item, depth - 1, seen);
        if (normalized !== undefined) out[key] = normalized;
      }
      return out;
    }
    // Class instances (Response, Request, SDK types, …) collapse to a tag.
    return `[${value.constructor?.name ?? "object"}]`;
  } finally {
    seen.delete(value);
  }
}

function normalizeFields(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!fields) return {};
  const normalized = normalizeValue(fields, MAX_DEPTH, new WeakSet()) as Record<string, unknown>;
  return normalized ?? {};
}

/**
 * Low-level emitter shared with `src/log.ts` (`logStructured`): merges the
 * ambient context under `record` and writes one JSON line. Envelope keys
 * (`ts`, `level`, `service`) always win over caller-supplied fields.
 */
export function emitLogRecord(level: LogLevel, record: Record<string, unknown>): void {
  const envelope: Record<string, unknown> = {
    ...normalizeFields(currentLogContext()),
    ...normalizeFields(record),
    ts: new Date().toISOString(),
    level,
    service: "shiba",
  };
  const line = JSON.stringify(envelope);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else if (level === "debug") console.debug(line);
  else console.log(line);
}

/** Fold `console.*`-style trailing args into structured fields. */
function restToFields(rest: unknown[]): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const details: string[] = [];
  for (const arg of rest) {
    if (arg === undefined || arg === null) continue;
    if (isPlainObject(arg)) {
      Object.assign(fields, arg);
      continue;
    }
    if (typeof arg === "string") {
      details.push(arg);
      continue;
    }
    const normalized = normalizeValue(arg, MAX_DEPTH, new WeakSet());
    if (normalized !== undefined) {
      if (isPlainObject(normalized) && "name" in normalized && "message" in normalized) {
        fields.error = normalized;
      } else {
        details.push(typeof normalized === "string" ? normalized : JSON.stringify(normalized));
      }
    }
  }
  if (details.length > 0) fields.detail = redactSecrets(details.join(" "));
  return fields;
}

function makeMethod(level: LogLevel): (message: unknown, ...rest: unknown[]) => void {
  return (message: unknown, ...rest: unknown[]) => {
    const fields = restToFields(rest);
    // `msg` last so a caller-supplied `msg` field cannot mask the message.
    emitLogRecord(level, { ...fields, msg: String(message ?? "") });
  };
}

/** Drop-in `console.*` replacement emitting structured JSON lines. */
export const log = {
  debug: makeMethod("debug"),
  info: makeMethod("info"),
  warn: makeMethod("warn"),
  error: makeMethod("error"),
} as const;
