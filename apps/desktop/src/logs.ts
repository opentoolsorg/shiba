/**
 * Structured, allowlisted logging. Every structured line is one JSON object
 * with a fixed key set, and every value passes through the same redaction, so
 * a stray token can never ride along in an unexpected field.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripControlChars } from "./safe-text.js";

export const MAX_LOG_BYTES = 5 * 1024 * 1024;
export const MAX_LOG_FIELD_CHARS = 2000;

/**
 * Keys a structured record may carry. Every one is a code, a number, or a
 * validated origin; there is deliberately no free-form key, so no page, deep
 * link, or daemon line can be persisted through the log.
 */
export const LOG_FIELDS = ["event", "state", "code", "action", "url", "bytes"] as const;

export type LogField = (typeof LOG_FIELDS)[number];
export type LogValue = string | number | null | undefined;

export interface Logger {
  line(text: string): void;
  event(fields: Partial<Record<LogField, LogValue>>): void;
}

const BEARER = /\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
// `Authorization: Basic <base64>` carries a credential in one token.
const BASIC = /\b(basic\s+)[A-Za-z0-9+/=]{8,}/gi;
const KEYED =
  /("?[A-Za-z0-9_-]*(?:token|secret|password|authorization|credential|cookie)"?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&"']+)/gi;
// Pairing tokens are two long base64url segments joined by a dot. Nothing else
// in a log line has that shape, so this never eats a commit SHA or a run id.
const PAIRING_BLOB = /[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{20,}/g;

/** Redacts credential-shaped substrings and caps length; logs never keep a secret. */
export function sanitizeLogLine(text: string): string {
  const redacted = stripControlChars(
    text
      .replace(BEARER, "$1[redacted]")
      .replace(BASIC, "$1[redacted]")
      .replace(KEYED, "$1[redacted]")
      .replace(PAIRING_BLOB, "[redacted]"),
  );
  return redacted.length > MAX_LOG_FIELD_CHARS
    ? `${redacted.slice(0, MAX_LOG_FIELD_CHARS)}…`
    : redacted;
}

/** One JSON line: allowlisted keys only, every value sanitized. */
export function formatLogEvent(fields: Partial<Record<LogField, LogValue>>): string {
  const record: Record<string, string | number> = {};
  for (const key of LOG_FIELDS) {
    const value = fields[key];
    if (value === undefined || value === null) continue;
    record[key] = typeof value === "number" ? value : sanitizeLogLine(value);
  }
  return JSON.stringify(record);
}

// Appends to <dir>/<name>, rotating to a single <name>.1 once it would pass maxBytes.
export function createLogger(dir: string, name: string, maxBytes = MAX_LOG_BYTES): Logger {
  const file = join(dir, name);
  mkdirSync(dir, { recursive: true });
  const write = (text: string) => {
    const data = `${new Date().toISOString()} ${text.replace(/\n$/, "")}\n`;
    try {
      if (statSync(file).size + data.length > maxBytes) renameSync(file, `${file}.1`);
    } catch {
      // no file yet
    }
    // Runs inside daemon stdout handlers in main: a full disk must not crash the app.
    try {
      appendFileSync(file, data);
    } catch {}
  };
  return {
    line(text) {
      write(sanitizeLogLine(text));
    },
    event(fields) {
      write(formatLogEvent(fields));
    },
  };
}
