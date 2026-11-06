/**
 * Stdout lines the session runner prints: `{"type":"shiba.event","event":…,"text":…}`.
 * Claude and Codex parseEvent both accept these so a cloud run's progress
 * feed stays the same shape whether the CLI or the session layer wrote the line.
 */
import { sanitizedEventText, type HarnessTextSanitizer } from "./event-sanitizer.js";
import type { HarnessEvent } from "./types.js";

export type SessionLine =
  | { kind: "foreign" }
  | { kind: "skip" }
  | { kind: "event"; event: HarnessEvent }
  | { kind: "error"; detail: string; usageLimited: boolean };

export function classifySessionLine(line: string, sanitize?: HarnessTextSanitizer): SessionLine {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return { kind: "foreign" };
  let record: unknown;
  try {
    record = JSON.parse(trimmed);
  } catch {
    return { kind: "foreign" };
  }
  if (record === null || typeof record !== "object" || Array.isArray(record))
    return { kind: "foreign" };
  const row = record as Record<string, unknown>;
  if (row.type !== "shiba.event" && row.type !== "shiba.result") return { kind: "foreign" };
  if (row.type === "shiba.result") return { kind: "skip" };
  const event = row.event;
  if (event === null || typeof event !== "object" || Array.isArray(event)) return { kind: "skip" };
  const body = event as Record<string, unknown>;
  const failedTurn = body.type === "turn.completed" && (body.status === "failed" || body.status === "error");
  if (body.type === "error" || failedTurn) {
    const detail = failedTurn
      ? typeof body.summary === "string" && body.summary ? body.summary : "session execution failed"
      : typeof body.message === "string" ? body.message : "session error";
    return { kind: "error", detail: sanitizedEventText(detail, sanitize), usageLimited: body.usageLimited === true || /usage|rate.?limit|quota/i.test(detail) };
  }
  const text = typeof row.text === "string" ? row.text : "";
  if (text.trim() === "") return { kind: "skip" };
  const shown = sanitizedEventText(text, sanitize, 500, true);
  if (body.type === "tool.started" || body.type === "tool.completed") {
    const name = typeof body.name === "string" && body.name !== "" ? body.name : "tool";
    return { kind: "event", event: { kind: "tool", name: sanitizedEventText(name, sanitize), text: shown } };
  }
  if (body.type === "turn.completed") {
    return { kind: "event", event: { kind: "result", text: shown } };
  }
  if (body.type === "message.delta" || body.type === "message.completed") {
    return { kind: "event", event: { kind: "text", text: shown } };
  }
  return { kind: "event", event: { kind: "progress", text: shown } };
}
