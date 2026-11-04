import { useId, type JSX } from "react";
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
