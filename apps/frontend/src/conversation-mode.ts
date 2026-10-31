export type ConversationMode = "chat" | "work";

const MODE_KEY_PREFIX = "shiba:conversation-mode:";
const SELECTED_SESSION_KEY = "shiba:selected-session";

export function readRememberedSessionId(): string | null {
  try {
    const id = localStorage.getItem(SELECTED_SESSION_KEY)?.trim();
    return id || null;
  } catch {
    return null;
  }
}

export function writeRememberedSessionId(sessionId: string): void {
  try {
    localStorage.setItem(SELECTED_SESSION_KEY, sessionId);
  } catch {
    // Restoring the last thread is a preference; session navigation still works.
  }
}

/** A persisted id is accepted only after the authenticated session list confirms it. */
export function resolveRememberedSessionId(
  rememberedId: string | null,
  sessions: readonly { id: string }[],
): string {
  return rememberedId && sessions.some((session) => session.id === rememberedId)
    ? rememberedId
    : "default";
}

export function readConversationMode(sessionId: string): ConversationMode {
  try {
    return localStorage.getItem(`${MODE_KEY_PREFIX}${sessionId}`) === "work" ? "work" : "chat";
  } catch {
    return "chat";
  }
}

export function writeConversationMode(sessionId: string, mode: ConversationMode): void {
  try {
    localStorage.setItem(`${MODE_KEY_PREFIX}${sessionId}`, mode);
  } catch {
    // The mode is a preference; the current view remains usable without storage.
  }
}
