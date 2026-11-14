import { type JSX, type ReactNode } from "react";
import type { RunThreadMessage } from "@shiba/shared";
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
  thread?: RunThreadMessage[];
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
      {tab === "timeline" && props.thread?.length ? (
        <ol className="flex flex-col gap-2 text-sm">
          {props.thread.map((message) => (
            <li key={message.id} className="border border-[var(--border-1)] px-3 py-2">
              <span className="font-mono text-[10px] uppercase text-[var(--muted-foreground-2)]">{message.kind}</span>
              <p className="mt-1 whitespace-pre-wrap">
                {"text" in message ? message.text : message.kind === "question" ? message.prompt : message.kind === "approval" ? "Approval" : ""}
              </p>
              {message.kind === "question" ? (
                <ul className="mt-2 list-disc pl-4">{message.options.map((option) => <li key={option}>{option}</li>)}</ul>
              ) : null}
              {message.kind === "approval" ? (
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(message.frozenPayload, null, 2)}</pre>
              ) : null}
              {message.kind === "denial" ? <p className="mt-1 text-xs">This denial is final.</p> : null}
            </li>
          ))}
        </ol>
      ) : null}
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