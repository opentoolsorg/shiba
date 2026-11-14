import { type JSX, type ReactNode } from "react";
import type { RetainedRun } from "../types";
import type { RunThreadTab } from "../run-thread-search";
import { DiffViewer } from "./DiffViewer";
import { RunDeliverables } from "./RunDeliverables";
import { RunLivePanel } from "./RunLivePanel";
import { extractCompletedDiff } from "../ui-helpers";

export interface RunProofSnapshot {
  screenshotUrl: string | null;
  browserE2eManifestUrl: string | null;
  previewUrl: string | null;
  testOutputTail: string | null;
  pullUrl: string | null;
}

const TABS: Array<{ id: RunThreadTab; label: string }> = [
  { id: "conversation", label: "Conversation" },
  { id: "timeline", label: "Timeline" },
  { id: "diff", label: "Diff" },
  { id: "proof", label: "Proof" },
];

export interface RunThreadPanelProps {
  run?: RetainedRun;
  tab: RunThreadTab;
  onTabChange: (tab: RunThreadTab) => void;
  sessionId?: string;
  proof?: RunProofSnapshot | null;
  conversation?: ReactNode;
  stopReason?: string | null;
}

export function RunThreadPanel(props: RunThreadPanelProps): JSX.Element {
  const { run, tab, onTabChange, sessionId, proof, conversation, stopReason } = props;
  const diff = run ? extractCompletedDiff(run) ?? run.diff : undefined;

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap gap-1 border-b border-[var(--border-1)] pb-2" role="tablist" aria-label="Run views">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`min-h-9 px-3 text-xs ${tab === item.id ? "border border-[var(--primary)] text-[var(--primary)]" : "border border-transparent text-[var(--muted-foreground-2)]"}`}
            onClick={() => onTabChange(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {stopReason ? <p className="text-xs text-[var(--warning-fg)]" role="status">Stopped: {stopReason}</p> : null}
      {tab === "conversation" ? conversation ?? <p className="text-sm text-[var(--muted-foreground-2)]">No conversation loaded.</p> : null}
      {tab === "timeline" && run && sessionId ? (
        <RunLivePanel runId={run.runId} sessionId={sessionId} />
      ) : tab === "timeline" ? (
        <p className="text-sm text-[var(--muted-foreground-2)]">Timeline streams when a run session is active.</p>
      ) : null}
      {tab === "diff" ? (
        diff ? <DiffViewer diff={diff} /> : <p className="text-sm text-[var(--muted-foreground-2)]">No diff is available yet.</p>
      ) : null}
      {tab === "proof" ? (
        <div className="flex flex-col gap-3 text-sm">
          {proof?.screenshotUrl ? (
            <a className="underline" href={proof.screenshotUrl} target="_blank" rel="noopener noreferrer">Open screenshot</a>
          ) : null}
          {proof?.previewUrl ? (
            <a className="underline" href={proof.previewUrl} target="_blank" rel="noopener noreferrer">Open preview</a>
          ) : null}
          {proof?.testOutputTail ? (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap border border-[var(--border-1)] p-2 text-xs">{proof.testOutputTail}</pre>
          ) : (
            <p className="text-[var(--muted-foreground-2)]">Test output will appear when the harness captures it.</p>
          )}
          {run ? (
            <RunDeliverables
              runId={run.runId}
              status={run.status}
              expected={run.expectedDeliverables}
              deliverables={run.deliverables}
              sessionId={sessionId}
            />
          ) : null}
          {proof?.pullUrl || run?.pullUrl ? (
            <a className="underline" href={proof?.pullUrl ?? run?.pullUrl ?? "#"} target="_blank" rel="noopener noreferrer">Open pull request</a>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}