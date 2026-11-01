import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { LoaderCircle } from "lucide-react";
import { LoadErrorState } from "./LoadErrorState";
import { CardSkeleton } from "./surface";
import { threadApiPath } from "../thread-api";

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
  sessionId?: string;
  /** Registry pull URL when GitHub status is not ready yet. */
  fallbackPullUrl?: string;
  /** Run asked to publish a PR — show a waiting state instead of hiding the panel. */
  publishRequested?: boolean;
}

/** Reads GET /pr/status. Shows loading, waiting, error, and fallback link states. */
export function PullRequestCard({
  threadId,
  sessionId,
  fallbackPullUrl,
  publishRequested = false,
}: PullRequestCardProps): JSX.Element | null {
  const scope = JSON.stringify([sessionId ?? "default", threadId]);
  const activeScope = useRef<string | null>(scope);
  activeScope.current = scope;
  const dataScope = useRef(scope);
  const loadSequence = useRef(0);
  const mergeSequence = useRef(0);
  const [storedState, setFetchState] = useState<FetchState>({ kind: "loading" });
  const fetchState: FetchState = dataScope.current === scope ? storedState : { kind: "loading" };
  const [mergePending, setMergePending] = useState(false);

  const load = useCallback(() => {
    const request = ++loadSequence.current;
    dataScope.current = scope;
    setFetchState({ kind: "loading" });
    void fetch(threadApiPath(threadId, "/pr/status", sessionId))
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
        if (activeScope.current === scope && request === loadSequence.current) setFetchState(next);
      })
      .catch((error: unknown) => {
        if (activeScope.current !== scope || request !== loadSequence.current) return;
        setFetchState({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }, [threadId, sessionId, scope]);

  useEffect(() => {
    activeScope.current = scope;
    setMergePending(false);
    load();
    return () => {
      activeScope.current = null;
      loadSequence.current += 1;
      mergeSequence.current += 1;
    };
  }, [load, scope]);

  const requestMerge = () => {
    if (activeScope.current !== scope) return;
    const request = ++mergeSequence.current;
    setMergePending(true);
    void fetch(threadApiPath(threadId, "/pr/merge", sessionId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mergeMethod: "squash" }),
    }).then(async (response) => {
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Merge approval request failed (${response.status}).`);
      }
    }).catch((error: unknown) => {
      if (activeScope.current === scope && request === mergeSequence.current) {
        setFetchState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
    }).finally(() => {
      if (activeScope.current === scope && request === mergeSequence.current) setMergePending(false);
    });
  };

  const panelClass =
    "border border-[var(--border-1)] rounded-[10px] bg-[var(--bg)] p-4 flex flex-col gap-3";

  if (fetchState.kind === "loading") {
    return (
      <section data-testid="pr-card" data-state="loading" className={panelClass} aria-busy="true">
        <CardSkeleton label="Loading pull request status" />
      </section>
    );
  }

  if (fetchState.kind === "error") {
    return (
      <section data-testid="pr-card" data-state="error" className={panelClass}>
        <LoadErrorState message={`Pull request status: ${fetchState.message}`} onRetry={load} />
        {fallbackPullUrl ? (
          <a className="min-h-11 inline-flex items-center text-xs font-medium text-[var(--text-link)] underline break-all rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]" href={fallbackPullUrl}>
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
        <a className="min-h-11 inline-flex items-center text-sm font-medium text-[var(--fg)] underline underline-offset-4 break-words min-w-0 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]" href={url}>{title}</a>
        <span className="text-xs font-medium border border-[var(--border-1)] px-2 py-0.5 rounded-[var(--radius-button)] shrink-0">
          {status?.state ?? "linked"}
        </span>
      </div>
      {canMerge ? (
        <button
          type="button"
          data-testid="pr-merge-request"
          className="min-h-11 min-w-11 text-xs font-medium bg-[var(--secondary)] hover:bg-[var(--secondary-hover)] text-[var(--fg)] rounded-lg px-3 self-start disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
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
