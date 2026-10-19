import { useState, useMemo, type JSX } from "react";
import { Check, Copy, Download } from "lucide-react";
import { Tooltip } from "./Tooltip";

export interface DiffViewerProps {
  diff: string;
  runId?: string;
}

type LineKind = "file" | "hunk" | "add" | "del" | "context";

function classifyLine(line: string): LineKind {
  if (
    line.startsWith("diff --git") ||
    line.startsWith("+++") ||
    line.startsWith("---") ||
    line.startsWith("index ")
  ) {
    return "file";
  }
  if (line.startsWith("@@")) {
    return "hunk";
  }
  if (line.startsWith("+")) {
    return "add";
  }
  if (line.startsWith("-")) {
    return "del";
  }
  return "context";
}

const LINE_CLASSES: Record<LineKind, string> = {
  file: "font-bold text-[var(--fg)] bg-[var(--primary-soft)] border-y border-[var(--primary)]/10 py-1 px-2 rounded-[var(--radius-button)] block font-mono text-[11px]",
  hunk: "text-[var(--primary)] font-mono text-[11px] bg-[var(--primary)]/5 py-0.5 px-2 block my-0.5 rounded-[var(--radius-button)]",
  add: "text-[var(--success)] bg-[color-mix(in_oklch,var(--success)_12%,transparent)] block w-full px-2 -mx-2 border-l-2 border-[var(--success)]",
  del: "text-[var(--destructive)] bg-[var(--destructive-soft)] block w-full px-2 -mx-2 border-l-2 border-[var(--destructive)]",
  context: "text-[var(--muted-foreground-2)] block px-2",
};

export function DiffViewer({ diff, runId }: DiffViewerProps): JSX.Element {
  const [copied, setCopied] = useState(false);

  const stats = useMemo(() => {
    if (!diff) return { additions: 0, deletions: 0, files: 0 };
    const lines = diff.split("\n");
    let additions = 0;
    let deletions = 0;
    let files = 0;
    for (const line of lines) {
      if (line.startsWith("diff --git")) files++;
      else if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
    return { additions, deletions, files };
  }, [diff]);

  if (!diff) {
    return <p className="text-xs text-[var(--muted-foreground-2)] italic">No file changes produced</p>;
  }

  const lines = diff.split("\n");

  const copyDiff = async () => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(diff);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        // Fallback or ignore
      }
    }
  };

  const downloadPatch = () => {
    if (typeof document === "undefined") return;
    const blob = new Blob([diff], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `patch-${runId || "task"}.diff`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-2 w-full mt-2">
      {/* Diff Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-[var(--card)] border border-[var(--border-1)] rounded-[var(--radius-button)] shadow-[var(--sh-card)] text-xs">
        <div className="flex items-center gap-2 font-mono">
          <span className="text-[var(--muted-foreground-2)] font-medium">Unified Diff</span>
          {stats.files > 0 ? (
            <span className="bg-[var(--bg)] text-[var(--fg)] border border-[var(--border-1)] rounded-[var(--radius-button)] px-1.5 py-0.5 text-[11px]">
              {stats.files} file{stats.files === 1 ? "" : "s"}
            </span>
          ) : null}
          <span className="text-[var(--success)] font-semibold">+{stats.additions}</span>
          <span className="text-[var(--destructive)] font-semibold">-{stats.deletions}</span>
        </div>
        <div className="flex items-center gap-2">
          <Tooltip content={copied ? "Diff copied to clipboard!" : "Copy unified diff to clipboard"} side="top">
            <button
              type="button"
              onClick={copyDiff}
              className="text-[11px] font-sans px-2.5 py-1 rounded-[var(--radius-button)] bg-[var(--bg)] hover:bg-[var(--secondary)] text-[var(--fg)] border border-[var(--border-1)] transition-colors flex items-center gap-1.5"
            >
              {copied ? (
                <>
                  <Check aria-hidden="true" className="w-3.5 h-3.5 text-[var(--success)]" strokeWidth={2} />
                  <span className="text-[var(--success)] font-medium">Copied</span>
                </>
              ) : (
                <>
                  <Copy aria-hidden="true" className="w-3.5 h-3.5 text-[var(--muted-foreground-2)]" strokeWidth={2} />
                  <span>Copy diff</span>
                </>
              )}
            </button>
          </Tooltip>

          <Tooltip content="Download raw git patch file" side="top">
            <button
              type="button"
              onClick={downloadPatch}
              className="text-[11px] font-sans px-2.5 py-1 rounded-[var(--radius-button)] bg-[var(--bg)] hover:bg-[var(--secondary)] text-[var(--muted-foreground-2)] hover:text-[var(--fg)] border border-[var(--border-1)] transition-colors flex items-center gap-1"
            >
              <Download aria-hidden="true" className="w-3.5 h-3.5" strokeWidth={2} />
              <span>.diff</span>
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Code Block */}
      <pre
        className="font-mono text-xs leading-[1.45] bg-[var(--bg)] border border-t-0 border-[var(--border-1)] rounded-[var(--radius-button)] p-3.5 -mt-2 max-h-96 overflow-auto whitespace-pre block w-full"
        role="region"
        aria-label={runId ? `Diff for ${runId}` : "Unified diff"}
      >
        <code className="block w-full font-mono">
          {lines.map((line, index) => (
            <span key={index} className={LINE_CLASSES[classifyLine(line)]}>
              {line}
              {index < lines.length - 1 ? "\n" : ""}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

