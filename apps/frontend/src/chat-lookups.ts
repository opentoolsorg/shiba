/** Optional tools a Chat turn may opt into (backend `CHAT_OPT_IN_TOOLS`). */
export type ChatLookupId = "web_search" | "knowledge_search" | "browser";

export interface ChatLookupOption {
  id: ChatLookupId;
  label: string;
  on: boolean;
  available: boolean;
  /** Why the tool is off on this deployment, naming only the missing env or binding. */
  unavailableReason?: string;
}

const LOOKUPS: ReadonlyArray<{ id: ChatLookupId; label: string }> = [
  { id: "web_search", label: "Web" },
  { id: "knowledge_search", label: "Knowledge" },
  { id: "browser", label: "Browser" },
];

/** Unknown setup (still loading or unreadable) leaves the toggle usable; the backend answers honestly if it is off. */
export function chatLookupOptions(
  toolSetup: ReadonlyArray<{ id: string; ready: boolean; env: string }> | null,
  selected: readonly ChatLookupId[],
): ChatLookupOption[] {
  return LOOKUPS.map(({ id, label }) => {
    const row = toolSetup?.find((entry) => entry.id === id);
    const available = row ? row.ready : true;
    return {
      id, label, available, on: available && selected.includes(id),
      ...(available ? {} : { unavailableReason: `Not configured on this deployment (${row?.env}).` }),
    };
  });
}

export function selectedChatLookups(options: readonly ChatLookupOption[]): ChatLookupId[] {
  return options.filter((option) => option.on).map((option) => option.id);
}
