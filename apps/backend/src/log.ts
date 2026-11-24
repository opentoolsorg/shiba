/**
 * One JSON object per line. Callers pass ids and classified codes — never
 * raw errors, tokens, or stack traces.
 *
 * Emission lives in `obs/log.ts` so these lines share the structured
 * envelope (`ts`/`level`/`service`) and pick up ambient `withLogContext`
 * fields (requestId/threadId/runId) like every other `log.*` call.
 */
import { emitLogRecord } from "./obs/log.js";

export interface StructuredLog {
  event: string;
  runId?: string;
  threadId?: string;
  status?: string;
  errorCode?: string;
  checkpoint?: string;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  detail?: string;
}

export function logStructured(level: "info" | "warn" | "error", fields: StructuredLog): void {
  emitLogRecord(level, { ...fields });
}
