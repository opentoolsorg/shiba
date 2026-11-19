export type ConversationMode = "chat" | "work";

/** An explicit app target only narrows authority; Chat still takes precedence. */
export function isAppToolsOnlyTurn(messages: readonly unknown[] | undefined): boolean {
  const latest = [...(messages ?? [])].reverse().find((message) => typeof message === "object" && message !== null &&
    (message as { role?: unknown }).role === "user") as { metadata?: unknown } | undefined;
  return typeof latest?.metadata === "object" && latest.metadata !== null && !Array.isArray(latest.metadata) &&
    (latest.metadata as { shibaWorkTarget?: unknown }).shibaWorkTarget === "app-tools";
}

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

/** Read-only lookups a Chat user can switch on for one message; nothing here acts or spends beyond the search budget. */
export const CHAT_OPT_IN_TOOLS = ["web_search", "knowledge_search"] as const;
export type ChatOptInTool = (typeof CHAT_OPT_IN_TOOLS)[number];

/** The lookups the latest Chat user turn explicitly opted into; empty for Work turns and unmarked Chat turns. */
export function chatOptInTools(messages: readonly unknown[] | undefined): ChatOptInTool[] {
  if (!isChatOnlyTurn(messages)) return [];
  const latest = [...(messages ?? [])].reverse().find((message) => typeof message === "object" && message !== null &&
    (message as { role?: unknown }).role === "user") as { metadata?: { shibaChatTools?: unknown } } | undefined;
  const requested = latest?.metadata?.shibaChatTools;
  if (!Array.isArray(requested)) return [];
  return CHAT_OPT_IN_TOOLS.filter((name) => requested.includes(name));
}

/** One generation a Chat user can pick for a single message; each maps to exactly one tool. */
export const CHAT_CREATE_TOOLS = { image: "generate_image", video: "generate_video", report: "generate_report", page: "generate_page" } as const;
export type ChatCreateTool = (typeof CHAT_CREATE_TOOLS)[keyof typeof CHAT_CREATE_TOOLS];

/** The generation tool the latest Chat user turn explicitly chose, or null. */
export function chatCreateTool(messages: readonly unknown[] | undefined): ChatCreateTool | null {
  if (!isChatOnlyTurn(messages)) return null;
  const latest = [...(messages ?? [])].reverse().find((message) => typeof message === "object" && message !== null &&
    (message as { role?: unknown }).role === "user") as { metadata?: { shibaChatCreate?: unknown } } | undefined;
  const choice = latest?.metadata?.shibaChatCreate;
  return typeof choice === "string" && Object.hasOwn(CHAT_CREATE_TOOLS, choice) ? CHAT_CREATE_TOOLS[choice as keyof typeof CHAT_CREATE_TOOLS] : null;
}

/** Chat turns get no registered tools; work turns keep the existing gated tool set. */
export function toolsForConversationMode<T extends Record<string, unknown>>(
  mode: ConversationMode,
  tools: T,
): Partial<T> | Record<string, never> {
  return mode === "chat" ? {} : tools;
}
