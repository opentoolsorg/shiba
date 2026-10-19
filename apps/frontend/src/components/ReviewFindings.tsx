import { useEffect, useState, type JSX } from "react";
import type { ReviewFinding, ReviewRound } from "@shiba/shared";

/** One row per finding from GET /pr/review. */
export function ReviewFindings({ threadId }: { threadId: string }): JSX.Element | null {
  const [round, setRound] = useState<ReviewRound | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/v1/threads/${encodeURIComponent(threadId)}/pr/review`)
      .then(async (response) => {
        if (!response.ok) return null;
        const body = await response.json() as { round?: ReviewRound | null };
        return body.round ?? null;
      })
      .then((next) => { if (!cancelled) setRound(next); })
      .catch(() => { if (!cancelled) setRound(null); });
    return () => { cancelled = true; };
  }, [threadId]);
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
          <li key={finding.id} data-finding-id={finding.id} className="text-xs text-[var(--fg)] flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider font-bold border border-[var(--border-1)] px-1.5 py-0.5 rounded-[var(--radius-button)]">{finding.severity}</span>
            <span className="font-mono text-[var(--muted-foreground-2)]">{finding.path}:{finding.line}</span>
            <span>{finding.title}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
