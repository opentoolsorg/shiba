import type { JSX } from "react";
import type { VMRun } from "../types";
import { statusChipClass, statusLabel } from "../ui-helpers";

function childrenOf(parentId: string | null, runs: VMRun[]): VMRun[] {
  return runs.filter((run) => (parentId ? run.parentRunId === parentId : !run.parentRunId));
}

function TreeNode({
  run,
  runs,
  depth,
  onSelect,
}: {
  run: VMRun;
  runs: VMRun[];
  depth: number;
  onSelect?: (runId: string) => void;
}): JSX.Element {
  const kids = childrenOf(run.runId, runs);
  return (
    <li className="ml-3 border-l border-[var(--border-1)] pl-3">
      <button
        type="button"
        className="text-left text-xs w-full py-1 hover:text-[var(--primary)]"
        onClick={() => onSelect?.(run.runId)}
      >
        <span className="font-mono text-[var(--muted-foreground-2)]">{run.subagentPath ?? "root"}</span>
        {" · "}
        <span className={statusChipClass(run.status)}>{statusLabel(run.status)}</span>
        {run.subagentSandbox ? (
          <span className="text-[var(--muted-foreground-2)]"> ({run.subagentSandbox})</span>
        ) : null}
      </button>
      {kids.length > 0 ? (
        <ul className="mt-1 space-y-1">
          {kids.map((child) => (
            <TreeNode key={child.runId} run={child} runs={runs} depth={depth + 1} onSelect={onSelect} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function SubagentTree({
  runs,
  onSelectRun,
}: {
  runs: VMRun[];
  onSelectRun?: (runId: string) => void;
}): JSX.Element | null {
  const hasTree = runs.some((run) => run.parentRunId || run.subagentPath);
  if (!hasTree) return null;
  const roots = runs.filter((run) => !run.parentRunId);
  return (
    <section
      data-testid="subagent-tree"
      className="bg-[var(--card)] border border-[var(--border-1)] rounded-[var(--radius-button)] p-4"
      aria-label="Subagent tree"
    >
      <h3 className="text-sm font-semibold text-[var(--fg)] mb-2">Subagent tree</h3>
      <ul className="space-y-1">
        {roots.map((run) => (
          <TreeNode key={run.runId} run={run} runs={runs} depth={0} onSelect={onSelectRun} />
        ))}
      </ul>
    </section>
  );
}
