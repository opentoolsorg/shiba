/**
 * One JSON object per line. Callers pass ids and classified codes — never
 * raw errors, tokens, or stack traces.
 */
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
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    service: "shiba",
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
