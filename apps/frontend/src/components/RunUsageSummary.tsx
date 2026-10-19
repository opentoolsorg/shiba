/**
 * Harness-reported token/cost for one run — never fabricated when absent.
 */
import type { JSX } from "react";
import type { RetainedRun } from "../types";

function usdCost(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

function tokenCount(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function formatRunUsageLine(run: RetainedRun): string | null {
  const usage = run.usage;
  if (!usage) return null;
  const parts: string[] = [];
  if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
    parts.push(`${tokenCount(usage.inputTokens)} in / ${tokenCount(usage.outputTokens)} out`);
  }
  if (usage.costUsd !== undefined) {
    parts.push(usdCost(usage.costUsd));
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Latest run in the list that reported usage (for the task thread footer). */
export function RunUsageCard({ runs }: { runs: RetainedRun[] }): JSX.Element | null {
  const run = [...runs]
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
    .find((entry) => formatRunUsageLine(entry) !== null);
  const line = run ? formatRunUsageLine(run) : null;
  if (!line || !run) return null;
  return (
    <div
      data-testid="run-usage"
      className="rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] px-3 py-2 text-xs text-[var(--muted-foreground-2)]"
    >
      <span className="font-semibold text-[var(--fg)]">Run usage</span>
      <span className="mx-1.5 text-[var(--muted-foreground-3)]">·</span>
      <span className="font-mono text-[11px]">{line}</span>
      <span className="ml-2 font-mono text-[10px] text-[var(--muted-foreground-3)]">{run.runId.slice(0, 8)}</span>
    </div>
  );
}
