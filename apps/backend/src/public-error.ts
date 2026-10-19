/**
 * User-facing run errors. API responses carry the closed vocabulary's
 * summary, never a stack frame or a raw executor string.
 */
import { runErrorWire, type RunErrorCode } from "@shiba/shared";

const STACK_LINE = /^\s*at\s+/;

export function stripStack(message: string): string {
  const kept = message
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "" && !STACK_LINE.test(line));
  const first = kept[0] ?? "Something went wrong.";
  return first.replace(/^Error:\s*/, "").slice(0, 300);
}

export function runTimedOut(run: { error?: string; errorCode?: RunErrorCode }): boolean {
  if (run.errorCode === "request_timeout" || run.errorCode === "timeout_scope") return true;
  return /\b(deadline|timed out|timeout)\b/i.test(run.error ?? "");
}

/** Message safe to put in a dashboard, Slack post, or v1 body. */
export function publicRunMessage(run: { error?: string; errorCode?: RunErrorCode }): string | null {
  if (run.errorCode) return runErrorWire(run.errorCode).userMessage;
  if (!run.error) return null;
  if (STACK_LINE.test(run.error)) return "Something went wrong. The run log has the error code.";
  return stripStack(run.error);
}
