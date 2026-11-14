import type { WorkHeaderViewMode } from "./components/WorkHeader";

export type WorkPeekTab = "steps" | "approval" | "diff" | "output";
export type WorkTaskKind = "approval" | "run" | "session";
export interface WorkSearchState {
  view: WorkHeaderViewMode;
  task: string | null;
  taskKind?: WorkTaskKind;
  tab: WorkPeekTab;
}

/** Shared by the Work surface and route search validation; unknown values never become UI state. */
export function parseWorkSearch(search: URLSearchParams): WorkSearchState {
  const view = search.get("view");
  const tab = search.get("tab");
  const kind = search.get("taskKind");
  return {
    view: view === "board" || view === "timeline" || view === "organization" ? view : "list",
    task: search.get("task") || null,
    taskKind: kind === "run" || kind === "approval" || kind === "session" ? kind : undefined,
    tab:
      tab === "approval" || tab === "diff" || tab === "output" || tab === "steps"
        ? tab
        : kind === "approval"
          ? "approval"
          : "steps",
  };
}

/** Preserve OAuth, workspace, legacy-view and other caller-owned search parameters. */
export function updateWorkSearch(search: URLSearchParams, state: WorkSearchState): URLSearchParams {
  const next = new URLSearchParams(search);
  const ownsView = ["list", "board", "timeline", "organization"].includes(next.get("view") ?? "");
  const ownsTab = ["steps", "approval", "diff", "output"].includes(next.get("tab") ?? "");
  if (state.view === "list") {
    if (ownsView) next.delete("view");
  } else next.set("view", state.view);
  if (state.task) {
    next.set("task", state.task);
    if (state.taskKind) next.set("taskKind", state.taskKind);
    else next.delete("taskKind");
    if (state.tab === "steps" && state.taskKind !== "approval") {
      if (ownsTab) next.delete("tab");
    } else next.set("tab", state.tab);
  } else {
    next.delete("task");
    next.delete("taskKind");
    if (ownsTab) next.delete("tab");
  }
  return next;
}
