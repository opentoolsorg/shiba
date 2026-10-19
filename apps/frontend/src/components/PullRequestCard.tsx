import { useEffect, useState, type JSX } from "react";

interface PullStatus {
  url?: string;
  state?: string;
  title?: string;
  checks?: Array<{ id: number; name: string; status: string; conclusion: string | null }>;
}

/** Reads GET /pr/status. Renders nothing until a pull request exists. */
export function PullRequestCard({ threadId }: { threadId: string }): JSX.Element | null {
  const [status, setStatus] = useState<PullStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/v1/threads/${encodeURIComponent(threadId)}/pr/status`)
      .then(async (response) => {
        if (!response.ok) return null;
        const body = await response.json() as { pullRequestStatus?: PullStatus };
        return body.pullRequestStatus ?? null;
      })
      .then((next) => { if (!cancelled) setStatus(next); })
      .catch(() => { if (!cancelled) setStatus(null); });
    return () => { cancelled = true; };
  }, [threadId]);
  if (!status?.url) return null;
  return (
    <section data-testid="pr-card" className="border border-[var(--border-1)] rounded-[var(--radius-button)] bg-[var(--card)] p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <a className="text-sm font-medium text-[var(--fg)] underline" href={status.url}>{status.title || status.url}</a>
        <span className="text-[10px] uppercase tracking-wider font-bold border border-[var(--border-1)] px-2 py-0.5 rounded-[var(--radius-button)]">{status.state ?? "unknown"}</span>
      </div>
      <ul className="text-[11px] font-mono text-[var(--muted-foreground-2)]">
        {(status.checks ?? []).length === 0 ? <li>No checks</li> : status.checks?.map((check) => (
          <li key={check.id}>{check.name}: {check.conclusion ?? check.status}</li>
        ))}
      </ul>
    </section>
  );
}
