import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { LoaderCircle } from "lucide-react";
import type { FindingTriage, ReviewFinding, ReviewRound } from "@shiba/shared";
import { LoadErrorState } from "./LoadErrorState";
import { CardSkeleton } from "./surface";
import { threadApiPath } from "../thread-api";

const TRIAGE_OPTIONS: FindingTriage[] = ["open", "resolved", "irrelevant"];

type FetchState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; round: ReviewRound | null };

interface TriageUpdate {
  triage: FindingTriage;
  status: "pending" | "saved" | "failed";
}

interface FindingMutations {
  initial: FindingTriage;
  updates: TriageUpdate[];
}

export interface ReviewFindingsProps {
  threadId: string;
  sessionId?: string;
  /** Frozen at approval — controls empty copy when no round exists yet. */
  reviewAfterPublish?: boolean;
}

/** One row per finding from GET /pr/review; triage is persisted on the orchestrator DO. */
export function ReviewFindings({
  threadId,
  sessionId,
  reviewAfterPublish = false,
}: ReviewFindingsProps): JSX.Element | null {
  const scope = JSON.stringify([sessionId ?? "default", threadId]);
  const activeScope = useRef<string | null>(scope);
  activeScope.current = scope;
  const dataScope = useRef(scope);
  const loadSequence = useRef(0);
  const retrySequence = useRef(0);
  const findingMutations = useRef(new Map<string, FindingMutations>());
  const [storedState, setFetchState] = useState<FetchState>({ kind: "loading" });
  const fetchState: FetchState = dataScope.current === scope ? storedState : { kind: "loading" };
  const fetchStateRef = useRef(fetchState);
  fetchStateRef.current = fetchState;
  const [retryPending, setRetryPending] = useState(false);

  const load = useCallback(() => {
    const request = ++loadSequence.current;
    findingMutations.current.clear();
    dataScope.current = scope;
    setFetchState({ kind: "loading" });
    void fetch(threadApiPath(threadId, "/pr/review", sessionId))
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Review fetch failed (${response.status})`);
        }
        const body = (await response.json()) as { round?: ReviewRound | null };
        return { kind: "ready" as const, round: body.round ?? null };
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
    setRetryPending(false);
    load();
    return () => {
      activeScope.current = null;
      loadSequence.current += 1;
      retrySequence.current += 1;
      findingMutations.current.clear();
    };
  }, [load, scope]);

  const setTriage = (findingId: string, triage: FindingTriage) => {
    if (activeScope.current !== scope) return;
    const current = fetchStateRef.current;
    const finding = current.kind === "ready"
      ? current.round?.findings?.find((item) => item.id === findingId)
      : undefined;
    if (!finding) return;

    let mutations = findingMutations.current.get(findingId);
    if (!mutations) {
      mutations = { initial: finding.triage, updates: [] };
      findingMutations.current.set(findingId, mutations);
    }
    const pending = mutations;
    const update: TriageUpdate = { triage, status: "pending" };
    pending.updates.push(update);
    const isCurrent = () => activeScope.current === scope
      && findingMutations.current.get(findingId) === pending;
    const reconcile = () => {
      // Keep local intent order even when responses arrive out of order. Failed
      // updates fall back to the last successful or still-pending edit, never an
      // optimistic snapshot belonging to another finding.
      const value = pending.updates.reduce(
        (previous, item) => item.status === "failed" ? previous : item.triage,
        pending.initial,
      );
      setFetchState((state) => state.kind === "ready" && state.round ? {
        ...state,
        round: {
          ...state.round,
          findings: state.round.findings?.map((item) => item.id === findingId ? { ...item, triage: value } : item),
        },
      } : state);
      if (pending.updates.every((item) => item.status !== "pending")) {
        findingMutations.current.delete(findingId);
      }
    };
    reconcile();
    void fetch(
      threadApiPath(threadId, `/pr/review/findings/${encodeURIComponent(findingId)}/triage`, sessionId),
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ triage }) },
    )
      .then(async (response) => {
        if (!isCurrent()) return;
        if (!response.ok) {
          update.status = "failed";
        } else {
          const body = (await response.json()) as { round?: ReviewRound };
          if (!isCurrent()) return;
          update.status = "saved";
          // The returned round can predate other in-flight finding edits.
          update.triage = body.round?.findings?.find((item) => item.id === findingId)?.triage ?? triage;
        }
        reconcile();
      })
      .catch(() => {
        if (!isCurrent()) return;
        update.status = "failed";
        reconcile();
      });
  };

  const retryReview = () => {
    if (activeScope.current !== scope) return;
    const request = ++retrySequence.current;
    setRetryPending(true);
    void fetch(threadApiPath(threadId, "/pr/review/retry", sessionId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).then(async (response) => {
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Review retry failed (${response.status}).`);
      }
      if (activeScope.current === scope && request === retrySequence.current) load();
    }).catch((error: unknown) => {
      if (activeScope.current === scope && request === retrySequence.current) {
        setFetchState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
    })
      .finally(() => {
        if (activeScope.current === scope && request === retrySequence.current) setRetryPending(false);
      });
  };

  const panelClass =
    "border border-[var(--border-1)] rounded-[var(--radius-button)] bg-[var(--card)] p-3 flex flex-col gap-2";

  if (!reviewAfterPublish && fetchState.kind === "ready" && !fetchState.round) {
    return null;
  }

  if (fetchState.kind === "loading") {
    return (
      <section data-testid="review-findings" data-state="loading" className={panelClass} aria-busy="true">
        <CardSkeleton label="Loading review findings" />
      </section>
    );
  }

  if (fetchState.kind === "error") {
    return (
      <section data-testid="review-findings" data-state="error" className={panelClass}>
        <LoadErrorState message={`Review: ${fetchState.message}`} onRetry={load} />
      </section>
    );
  }

  const round = fetchState.round;
  if (!round) {
    return (
      <section data-testid="review-findings" data-state="waiting" className={panelClass}>
        <h3 className="text-sm font-semibold text-[var(--fg)]">Review findings</h3>
        <p className="text-xs text-[var(--muted-foreground-2)]">
          {reviewAfterPublish
            ? "Read-only review starts after the pull request opens. No round yet."
            : "No review round for this thread."}
        </p>
      </section>
    );
  }

  const findings: ReviewFinding[] = round.findings ?? [];
  const inFlight = round.status === "queued" || round.status === "running";

  return (
    <section data-testid="review-findings" data-state="ready" data-round-status={round.status} className={panelClass}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--fg)]">Review findings</h3>
        <span className="text-[10px] uppercase tracking-wider font-bold border border-[var(--border-1)] px-2 py-0.5 rounded-[var(--radius-button)]">
          {round.status}
        </span>
      </div>
      {inFlight ? (
        <p className="text-xs text-[var(--fg)] flex items-center gap-2">
          <LoaderCircle className="w-3.5 h-3.5 animate-spin text-[var(--primary)]" aria-hidden="true" />
          Reviewer run in progress…
        </p>
      ) : null}
      {round.status === "failed" ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-[var(--destructive)] break-words" role="alert">
            {round.error ?? "Review round failed."}
          </p>
          <button
            type="button"
            data-testid="review-retry"
            disabled={retryPending}
            onClick={retryReview}
            className="text-xs font-semibold text-[var(--primary)] border border-[var(--primary)]/40 bg-[var(--primary-soft)] rounded-[var(--radius-button)] px-3 py-1.5 self-start disabled:opacity-50"
          >
            {retryPending ? "Retrying…" : "Retry review"}
          </button>
        </div>
      ) : null}
      {round.summary ? <p className="text-xs text-[var(--muted-foreground-2)]">{round.summary}</p> : null}
      {findings.length === 0 && !inFlight && round.status !== "failed" ? (
        <p className="text-xs text-[var(--muted-foreground-2)]">No findings in this round.</p>
      ) : null}
      {findings.length > 0 ? (
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
      ) : null}
    </section>
  );
}
