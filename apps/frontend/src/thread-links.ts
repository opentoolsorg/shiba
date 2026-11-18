/**
 * A thread is addressable: `/threads/?session=<id>` is what a sidebar click,
 * a reload and a pasted link all produce. The server mints session UUIDs, so a
 * link is recognised by shape and never trusted as an identity — the sessions
 * list still decides whether this viewer may open it.
 */
export type ThreadLinkIntent = { threadId: string } | "invalid" | null;

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const DEFAULT_THREAD_ID = "default";

export function isThreadId(value: string): boolean {
  return value === DEFAULT_THREAD_ID || THREAD_ID.test(value);
}

/** null: no thread selector. "invalid": a selector this app must not act on. */
export function readThreadLink(search: string): ThreadLinkIntent {
  const params = new URLSearchParams(search);
  const values = params.getAll("session");
  if (values.length === 0) return null;
  const threadId = values[0] ?? "";
  if (values.length !== 1 || !isThreadId(threadId)) return "invalid";
  return { threadId };
}

/** The default session has no link; it is the absence of a thread selector. */
export function withThreadLink(search: string, threadId: string | null): string {
  const params = new URLSearchParams(search);
  params.delete("session");
  if (threadId && threadId !== DEFAULT_THREAD_ID && isThreadId(threadId)) params.set("session", threadId);
  return params.toString();
}

/**
 * A link outranks the remembered session, but only for a thread this viewer can
 * list: anything else falls back to the default session, never to a guess.
 */
export function resolveLinkedThread(linked: string, available: readonly { id: string }[]): string {
  if (linked === DEFAULT_THREAD_ID) return DEFAULT_THREAD_ID;
  return available.some((session) => session.id === linked) ? linked : DEFAULT_THREAD_ID;
}
