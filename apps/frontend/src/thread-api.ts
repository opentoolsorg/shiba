/** Run IDs live inside a user's selected session, including review/PR reads. */
export function threadApiPath(threadId: string, path: string, sessionId?: string): string {
  const route = `/api/v1/threads/${encodeURIComponent(threadId)}${path}`;
  return sessionId && sessionId !== "default"
    ? `${route}?${new URLSearchParams({ session: sessionId })}`
    : route;
}
