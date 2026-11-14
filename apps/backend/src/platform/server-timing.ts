/** Lightweight Server-Timing helper for boot-sensitive routes (WS01). */

export type ServerTimingMarks = {
  start: number;
  authMs?: number;
  d1Ms?: number;
};

export function startServerTiming(): ServerTimingMarks {
  return { start: performance.now() };
}

export function serverTimingHeader(marks: ServerTimingMarks): string {
  const total = Math.round(performance.now() - marks.start);
  const parts = [`total;dur=${total}`];
  if (marks.authMs !== undefined) parts.push(`auth;dur=${Math.round(marks.authMs)}`);
  if (marks.d1Ms !== undefined) parts.push(`d1;dur=${Math.round(marks.d1Ms)}`);
  return parts.join(", ");
}

export function withServerTiming<T extends Response>(response: T, marks: ServerTimingMarks): T {
  const headers = new Headers(response.headers);
  headers.set("Server-Timing", serverTimingHeader(marks));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers }) as T;
}