import { useCallback, useEffect, useState, type JSX } from "react";
import { LoaderCircle } from "lucide-react";
import { LoadErrorState } from "./LoadErrorState";

interface PullStatus {
  url?: string;
  state?: string;
  title?: string;
  checks?: Array<{ id: number; name: string; status: string; conclusion: string | null }>;
}

type FetchState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; status: PullStatus | null; notFound: boolean };

export interface PullRequestCardProps {
  threadId: string;
  /** Registry pull URL when GitHub status is not ready yet. */
  fallbackPullUrl?: string;
  /** Run asked to publish a PR — show a waiting state instead of hiding the panel. */
  publishRequested?: boolean;
}

/** Reads GET /pr/status. Shows loading, waiting, error, and fallback link states. */
export function PullRequestCard({
  threadId,
  fallbackPullUrl,
  publishRequested = false,
}: PullRequestCardProps): JSX.Element | null {
  const [fetchState, setFetchState] = useState<FetchState>({ kind: "loading" });
  const [mergePending, setMergePending] = useState(false);

  const load = useCallback(() => {
    setFetchState({ kind: "loading" });
    void fetch(`/api/v1/threads/${encodeURIComponent(threadId)}/pr/status`)
      .then(async (response) => {
        if (response.status === 404) {
          return { kind: "ready" as const, status: null, notFound: true };
        }
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `PR status failed (${response.status})`);
        }
        const body = (await response.json()) as { pullRequestStatus?: PullStatus };
        return {
          kind: "ready" as const,
          status: body.pullRequestStatus ?? null,
          notFound: false,
        };
      })
      .then((next) => {
        setFetchState(next);
      })
      .catch((error: unknown) => {
        setFetchState({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }, [threadId]);

  useEffect(() => {
    load();
  }, [load]);

  const requestMerge = () => {
    setMergePending(true);
    void fetch(`/api/v1/threads/${encodeURIComponent(threadId)}/pr/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mergeMethod: "squash" }),
    }).finally(() => {
      setMergePending(false);
    });
  };

  const panelClass =
    "border border-[var(--border-1)] rounded-[var(--radius-button)] bg-[var(--card)] p-3 flex flex-col gap-2";

  if (fetchState.kind === "loading") {
    return (
      <section data-testid="pr-card" data-state="loading" className={panelClass}>
        <p className="text-xs text-[var(--muted-foreground-2)] flex items-center gap-2">
          <LoaderCircle className="w-3.5 h-3.5 animate-spin text-[var(--primary)]" aria-hidden="true" />
          Loading pull request status…
        </p>
      </section>
    );
  }

  if (fetchState.kind === "error") {
    return (
      <section data-testid="pr-card" data-state="error" className={panelClass}>
        <LoadErrorState message={`Pull request status: ${fetchState.message}`} onRetry={load} />
        {fallbackPullUrl ? (
          <a className="text-xs font-medium text-[var(--primary)] underline break-all" href={fallbackPullUrl}>
            Open pull request (from run record)
          </a>
        ) : null}
      </section>
    );
  }

  const status = fetchState.status;
  const url = status?.url ?? (fetchState.notFound ? fallbackPullUrl : undefined);

  if (!url) {
    if (!publishRequested && !fallbackPullUrl) return null;
    return (
      <section data-testid="pr-card" data-state="waiting" className={panelClass}>
        <h3 className="text-sm font-semibold text-[var(--fg)]">Pull request</h3>
        <p className="text-xs text-[var(--muted-foreground-2)] flex items-center gap-2">
          <LoaderCircle className="w-3.5 h-3.5 animate-spin text-[var(--primary)]" aria-hidden="true" />
          {publishRequested
            ? "Opening pull request after the coding run completes…"
            : "No pull request on this thread yet."}
        </p>
      </section>
    );
  }

  const canMerge = status?.state === "open";
  const title = status?.title || url;
  return (
    <section data-testid="pr-card" data-state="ready" className={panelClass}>
      <div className="flex items-center justify-between gap-2">
        <a className="text-sm font-medium text-[var(--fg)] underline break-all" href={url}>{title}</a>
        <span className="text-[10px] uppercase tracking-wider font-bold border border-[var(--border-1)] px-2 py-0.5 rounded-[var(--radius-button)] shrink-0">
          {status?.state ?? "linked"}
        </span>
      </div>
      {canMerge ? (
        <button
          type="button"
          data-testid="pr-merge-request"
          className="text-xs border border-[var(--border-1)] rounded-[var(--radius-button)] px-2 py-1 self-start"
          disabled={mergePending}
          onClick={requestMerge}
        >
          {mergePending ? "Requesting merge approval…" : "Request merge (approval-gated)"}
        </button>
      ) : null}
      {status?.checks ? (
        <ul className="text-[11px] font-mono text-[var(--muted-foreground-2)]">
          {status.checks.length === 0 ? <li>No checks reported</li> : status.checks.map((check) => (
            <li key={check.id}>{check.name}: {check.conclusion ?? check.status}</li>
          ))}
        </ul>
      ) : fetchState.notFound && fallbackPullUrl ? (
        <p className="text-[11px] text-[var(--muted-foreground-2)]">
          Live GitHub checks unavailable — link is from the run record.
        </p>
      ) : null}
    </section>
  );
}
