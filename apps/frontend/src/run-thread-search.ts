export type RunThreadTab = "conversation" | "timeline" | "diff" | "proof";

const VALID: readonly RunThreadTab[] = ["conversation", "timeline", "diff", "proof"];

export function parseRunThreadSearch(search: URLSearchParams): { runId: string | null; tab: RunThreadTab } {
  const tab = search.get("tab");
  const runId = search.get("run");
  return {
    runId: runId?.trim() || null,
    tab: VALID.includes(tab as RunThreadTab) ? (tab as RunThreadTab) : "conversation",
  };
}

export function updateRunThreadSearch(search: URLSearchParams, state: { runId: string | null; tab: RunThreadTab }): URLSearchParams {
  const next = new URLSearchParams(search);
  if (state.runId) next.set("run", state.runId);
  else next.delete("run");
  if (state.tab === "conversation") next.delete("tab");
  else next.set("tab", state.tab);
  return next;
}