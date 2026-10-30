export type ConversationMode = "chat" | "work";

/** Only an explicit, latest user-turn marker can restrict the turn to chat. */
export function isChatOnlyTurn(messages: readonly unknown[] | undefined): boolean {
  if (!messages) return false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
    const row = message as { role?: unknown; metadata?: unknown };
    if (row.role !== "user") continue;
    if (typeof row.metadata !== "object" || row.metadata === null || Array.isArray(row.metadata)) return false;
    return (row.metadata as { shibaMode?: unknown }).shibaMode === "chat";
  }
  return false;
}

/** Chat turns get no registered tools; work turns keep the existing gated tool set. */
export function toolsForConversationMode<T extends Record<string, unknown>>(
  mode: ConversationMode,
  tools: T,
): Partial<T> | Record<string, never> {
  return mode === "chat" ? {} : tools;
}
