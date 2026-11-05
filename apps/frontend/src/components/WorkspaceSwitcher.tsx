import { useId, type JSX } from "react";
import { Check, Plus } from "lucide-react";
import type { TeamWorkspaceSummary } from "@shiba/shared";

export interface WorkspaceSwitcherProps {
  workspaces: TeamWorkspaceSummary[];
  loading?: boolean;
  selectedWorkspaceId: string;
  onSelect: (workspaceId: string) => void;
  onManage: () => void;
}

export function WorkspaceSwitcher({
  workspaces,
  loading,
  selectedWorkspaceId,
  onSelect,
  onManage,
}: WorkspaceSwitcherProps): JSX.Element {
  const selectorId = useId();
  const unknownSelection = Boolean(selectedWorkspaceId && !workspaces.some((item) => item.workspaceId === selectedWorkspaceId));
  const knownSelection = selectedWorkspaceId;
  return (
    <div className="min-w-0 border-b border-[var(--line)] p-3 text-[var(--ink)]">
      <label
        htmlFor={selectorId}
        className="mb-1 block font-mono text-[10px] uppercase tracking-widest text-[var(--ink-2)]"
      >
        Workspace
      </label>
      <div className="flex min-w-0 gap-1">
        <select
          id={selectorId}
          value={knownSelection}
          disabled={loading}
          onChange={(event) => onSelect(event.target.value)}
          aria-busy={loading}
          className="min-h-11 min-w-0 flex-1 border border-[var(--line)] bg-[var(--card)] px-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]"
        >
          <option value="">Personal workspace</option>
          {unknownSelection ? <option value={selectedWorkspaceId}>{loading ? "Checking selected workspace…" : "Workspace unavailable"}</option> : null}
          {workspaces.map((item) => (
            <option key={item.workspaceId} value={item.workspaceId}>
              {item.name} · {item.membership.role}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={onManage}
          className="min-h-11 border border-[var(--line)] px-2 text-xs hover:bg-[var(--panel-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]"
          aria-label="Manage team workspaces"
        >
          Team
        </button>
      </div>
      {loading && (
        <p role="status" className="mt-1 text-xs text-[var(--ink-2)]">
          Checking memberships…
        </p>
      )}
    </div>
  );
}

/** Account-menu WORKSPACES list: personal plus verified workspaces, check on the current one. */
export function WorkspaceMenuList({
  workspaces,
  selectedWorkspaceId,
  onSelect,
  onCreate,
}: {
  workspaces: TeamWorkspaceSummary[];
  selectedWorkspaceId: string;
  onSelect: (workspaceId: string) => void;
  onCreate: () => void;
}): JSX.Element {
  const row = "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-[var(--muted-foreground-2)] hover:bg-[var(--popover-hover)] hover:text-[var(--fg)]";
  return (
    <div role="group" aria-label="Workspaces" className="border-b border-[var(--border-1)] py-1">
      <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-[var(--muted-foreground-3)]">Workspaces</p>
      <button type="button" role="menuitemradio" aria-checked={selectedWorkspaceId === ""} onClick={() => onSelect("")} className={row}>
        <span className="flex-1 truncate">Personal workspace</span>
        {selectedWorkspaceId === "" ? <Check className="size-3.5" aria-hidden="true" /> : null}
      </button>
      {workspaces.map((item) => (
        <button key={item.workspaceId} type="button" role="menuitemradio" aria-checked={selectedWorkspaceId === item.workspaceId} onClick={() => onSelect(item.workspaceId)} className={row}>
          <span className="flex-1 truncate">{item.name}</span>
          {selectedWorkspaceId === item.workspaceId ? <Check className="size-3.5" aria-hidden="true" /> : null}
        </button>
      ))}
      <button type="button" role="menuitem" onClick={onCreate} className={row}>
        <Plus className="size-3.5" aria-hidden="true" />
        <span>Create workspace</span>
      </button>
    </div>
  );
}
