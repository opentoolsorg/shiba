import { useCallback, useEffect, useState, type JSX } from "react";
import type { FindingTriage, ReviewFinding, ReviewRound } from "@shiba/shared";

const TRIAGE_OPTIONS: FindingTriage[] = ["open", "resolved", "irrelevant"];

/** One row per finding from GET /pr/review; triage is persisted on the orchestrator DO. */
export function ReviewFindings({ threadId }: { threadId: string }): JSX.Element | null {
  const [round, setRound] = useState<ReviewRound | null>(null);
  const load = useCallback(() => {
    void fetch(`/api/v1/threads/${encodeURIComponent(threadId)}/pr/review`)
      .then(async (response) => {
        if (!response.ok) return null;
        const body = await response.json() as { round?: ReviewRound | null };
        return body.round ?? null;
      })
      .then((next) => { setRound(next); })
      .catch(() => { setRound(null); });
  }, [threadId]);
  useEffect(() => {
    load();
  }, [load]);
  const setTriage = (findingId: string, triage: FindingTriage) => {
    void fetch(
      `/api/v1/threads/${encodeURIComponent(threadId)}/pr/review/findings/${encodeURIComponent(findingId)}/triage`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ triage }) },
    )
      .then(async (response) => {
        if (!response.ok) return;
        const body = await response.json() as { round?: ReviewRound };
        if (body.round) setRound(body.round);
      })
      .catch(() => {});
  };
  if (!round) return null;
  const findings: ReviewFinding[] = round.findings ?? [];
  return (
    <section data-testid="review-findings" className="border border-[var(--border-1)] rounded-[var(--radius-button)] bg-[var(--card)] p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--fg)]">Review findings</h3>
        <span className="text-[10px] uppercase tracking-wider font-bold border border-[var(--border-1)] px-2 py-0.5 rounded-[var(--radius-button)]">{round.status}</span>
      </div>
      {round.summary ? <p className="text-xs text-[var(--muted-foreground-2)]">{round.summary}</p> : null}
      <ul className="flex flex-col gap-1.5">
        {findings.map((finding) => (
          <li key={finding.id} data-finding-id={finding.id} data-triage={finding.triage} className="text-xs text-[var(--fg)] flex flex-wrap items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider font-bold border border-[var(--border-1)] px-1.5 py-0.5 rounded-[var(--radius-button)]">{finding.severity}</span>
            <span className="font-mono text-[var(--muted-foreground-2)]">{finding.path}:{finding.line}</span>
            <span>{finding.title}</span>
            <label className="flex items-center gap-1 text-[10px] text-[var(--muted-foreground-2)]">
              Triage
              <select
                className="text-[10px] border border-[var(--border-1)] rounded px-1 py-0.5 bg-[var(--card)]"
                value={finding.triage}
                aria-label={`Triage for ${finding.title}`}
                onChange={(event) => setTriage(finding.id, event.target.value as FindingTriage)}
              >
                {TRIAGE_OPTIONS.map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}
