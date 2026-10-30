/**
 * MemoryTab — workspace-pane view of the agent's long-term memory: banked
 * facts and recorded sessions from the Memory DO (megaplan T8/T9 contract).
 * ?q= runs recall (ranked by score); an empty box lists facts plainly.
 * Forget is a two-step confirm — it deletes the fact for good.
 *
 * Visually harmonized with the warm paper / navy / serif + mono dashboard design.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { MemoryFact, MemorySession } from "../types";
import { formatTimeAgo } from "../ui-helpers";
import { MemorySourcesView } from "./MemorySourcesView";

const GHOST_BUTTON =
  "text-[11px] bg-transparent hover:bg-[var(--card)] border border-[var(--border-1)] hover:border-[var(--border-2)] text-[var(--muted-foreground-2)] hover:text-[var(--fg)] font-medium py-1 px-2.5 touch:min-h-11 rounded-[var(--radius-button)] transition-colors inline-flex items-center justify-center gap-1.5";
const ACCENT_BUTTON =
  "text-[11px] bg-[var(--primary-soft)] hover:bg-[var(--primary-soft)] border border-[var(--primary)]/20 text-[var(--primary)] font-medium py-1 px-2.5 touch:min-h-11 rounded-[var(--radius-button)] transition-colors inline-flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed";
const DANGER_BUTTON =
  "text-[11px] bg-[var(--destructive-soft)] hover:bg-[var(--destructive)]/20 border border-[var(--destructive)]/50 text-[var(--destructive)] font-medium py-1 px-2.5 touch:min-h-11 rounded-[var(--radius-button)] transition-colors inline-flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed";

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `Request failed: ${response.status}`);
  }
  return body;
}

/** Where a fact was learned from — the provenance style chip. */
export function sourceChipClass(source: string): string {
  switch (source) {
    case "run":
      return "text-[var(--primary)] border-[var(--primary)]/30 bg-[var(--primary-soft)]";
    case "email":
      return "text-[var(--warning-fg)] border-[color-mix(in_oklch,var(--warning)_40%,transparent)] bg-[var(--warning-subtle)]";
    default:
      return "text-[var(--muted-foreground-2)] border-[var(--border-1)] bg-[var(--card)]";
  }
}

/** Format semantic recall similarity score (0.00 - 1.00). */
export function formatRecallScore(score?: number): string {
  if (typeof score !== "number" || Number.isNaN(score)) return "";
  return score.toFixed(2);
}

/** Client-side filter helper by source (all, run, email, etc.) */
export function filterFactsBySource(facts: MemoryFact[], source: string): MemoryFact[] {
  if (!source || source === "all") return facts;
  return facts.filter((f) => f.source.toLowerCase() === source.toLowerCase());
}

/** Client-side filter helper by agent */
export function filterFactsByAgent(facts: MemoryFact[], agent: string): MemoryFact[] {
  if (!agent || agent === "all") return facts;
  return facts.filter((f) => f.agent === agent);
}

export type MemoryViewMode = "facts" | "sessions" | "sources";

export interface MemoryTabProps {
  /** Optional initial facts (useful for tests and seeded state) */
  initialFacts?: MemoryFact[];
  /** Optional initial sessions (useful for tests and seeded state) */
  initialSessions?: MemorySession[];
  /** Optional callback invoked when a fact is deleted */
  onForgetFact?: (factId: string) => void;
  /** Optional container class name */
  className?: string;
}

export function MemoryTab(props: MemoryTabProps): JSX.Element {
  const { initialFacts, initialSessions, onForgetFact, className = "" } = props;
  const [facts, setFacts] = useState<MemoryFact[]>(initialFacts ?? []);
  const [sessions, setSessions] = useState<MemorySession[]>(initialSessions ?? []);
  const [query, setQuery] = useState("");
  const [searchActive, setSearchActive] = useState(false);
  const [lastRecallQuery, setLastRecallQuery] = useState("");
  const [loading, setLoading] = useState(initialFacts === undefined && initialSessions === undefined);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [confirmForget, setConfirmForget] = useState<string | null>(null);
  const [forgetBusy, setForgetBusy] = useState<string | null>(null);

  // View & filtering controls
  const [viewMode, setViewMode] = useState<MemoryViewMode>("facts");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [agentFilter, setAgentFilter] = useState("all");

  // A recall and a reload racing can resolve out of order; the token drops
  // whichever response isn't the latest request (same idiom as InboxTab).
  const listRequestRef = useRef(0);
  const noticeTimerRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    const request = ++listRequestRef.current;
    setLoading(true);
    setError(null);
    try {
      const [factsBody, sessionsBody] = await Promise.all([
        apiJson<{ facts?: MemoryFact[] }>("/api/memory/facts"),
        apiJson<{ sessions?: MemorySession[] }>("/api/memory/sessions"),
      ]);
      if (listRequestRef.current !== request) return;
      setFacts(Array.isArray(factsBody.facts) ? factsBody.facts : []);
      setSessions(Array.isArray(sessionsBody.sessions) ? sessionsBody.sessions : []);
      setSearchActive(false);
      setLastRecallQuery("");
    } catch (err) {
      if (listRequestRef.current === request) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (listRequestRef.current === request) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialFacts === undefined && initialSessions === undefined) {
      void load();
    }
  }, [load, initialFacts, initialSessions]);

  const runRecall = useCallback(async () => {
    const q = query.trim();
    if (q === "") return;
    const request = ++listRequestRef.current;
    setSearching(true);
    setError(null);
    try {
      const body = await apiJson<{ facts?: MemoryFact[] }>(
        `/api/memory/facts?q=${encodeURIComponent(q)}`,
      );
      if (listRequestRef.current !== request) return;
      setFacts(Array.isArray(body.facts) ? body.facts : []);
      setSearchActive(true);
      setLastRecallQuery(q);
      setViewMode("facts");
    } catch (err) {
      if (listRequestRef.current === request) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (listRequestRef.current === request) setSearching(false);
    }
  }, [query]);

  const forgetFact = useCallback(
    async (factId: string) => {
      setForgetBusy(factId);
      setError(null);
      try {
        await apiJson(`/api/memory/facts/${encodeURIComponent(factId)}`, { method: "DELETE" });
        setFacts((prev) => prev.filter((fact) => fact.id !== factId));
        setNotice("Fact forgotten from agent memory.");
        onForgetFact?.(factId);
        // A second delete restarts the notice countdown instead of the stale
        // timer clearing the new notice early.
        if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = window.setTimeout(() => {
          noticeTimerRef.current = null;
          setNotice(null);
        }, 4000);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setForgetBusy(null);
        setConfirmForget(null);
      }
    },
    [onForgetFact],
  );

  // Available unique agents for filtering
  const availableAgents = useMemo(() => {
    const agents = new Set<string>();
    for (const f of facts) if (f.agent) agents.add(f.agent);
    for (const s of sessions) if (s.agent) agents.add(s.agent);
    return Array.from(agents).sort();
  }, [facts, sessions]);

  // Filtered facts based on source and agent
  const visibleFacts = useMemo(() => {
    let list = facts;
    if (sourceFilter !== "all") {
      list = filterFactsBySource(list, sourceFilter);
    }
    if (agentFilter !== "all") {
      list = filterFactsByAgent(list, agentFilter);
    }
    return list;
  }, [facts, sourceFilter, agentFilter]);

  // Filtered sessions based on agent
  const visibleSessions = useMemo(() => {
    if (agentFilter === "all") return sessions;
    return sessions.filter((s) => s.agent === agentFilter);
  }, [sessions, agentFilter]);

  return (
    <div className={`flex flex-col gap-3.5 ${className}`}>
      {/* Header & Activity Summary (settings & privacy rationale) */}
      <header className="border border-[var(--border-1)] rounded-[var(--radius-button)] bg-[var(--card)] p-3.5 shadow-[var(--sh-card)]">
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <div>
            <h3 className="font-sans text-[17px] text-[var(--fg)] leading-tight">
              Durable Agent Memory
            </h3>
            <p className="text-[11px] text-[var(--muted-foreground-2)] mt-0.5">
              Facts & context persisted in the Memory DO across sessions.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className={GHOST_BUTTON}
            title="Reload memory facts and sessions"
            aria-label="Reload memory"
          >
            <svg aria-hidden="true" 
              className={`w-3.5 h-3.5 text-[var(--muted-foreground-2)] ${loading ? "animate-spin" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.8}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            <span className="hidden sm:inline">Sync</span>
          </button>
        </div>

        {/* Activity & stats summary */}
        <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-[var(--border-1)] text-[10px] font-mono text-[var(--muted-foreground-2)]">
          <span className="inline-flex items-center gap-1 bg-[var(--bg)] border border-[var(--border-1)] px-2 py-0.5 rounded-[var(--radius-button)]">
            <span className="font-bold text-[var(--primary)]">{facts.length}</span>
            <span>facts banked</span>
          </span>
          <span className="inline-flex items-center gap-1 bg-[var(--bg)] border border-[var(--border-1)] px-2 py-0.5 rounded-[var(--radius-button)]">
            <span className="font-bold text-[var(--fg)]">{sessions.length}</span>
            <span>sessions</span>
          </span>
          {searchActive ? (
            <span className="inline-flex items-center gap-1 bg-[var(--primary-soft)] text-[var(--primary)] border border-[var(--primary)]/20 px-2 py-0.5 rounded-[var(--radius-button)]">
              <span>Recall:</span>
              <span className="font-semibold truncate max-w-[120px]">"{lastRecallQuery}"</span>
            </span>
          ) : null}
        </div>
      </header>

      {/* Segmented View Mode Switcher */}
      <nav aria-label="Memory sections" className="flex items-center gap-1 bg-[var(--panel)] p-1 rounded-[var(--radius-button)] border border-[var(--border-1)]">
        <button
          type="button"
          onClick={() => setViewMode("facts")}
          className={`flex-1 text-[11px] font-medium py-1 px-3 rounded-[var(--radius-button)] transition-all touch:min-h-11 ${
            viewMode === "facts"
              ? "bg-[var(--card)] text-[var(--fg)] shadow-[var(--sh-card)] font-semibold"
              : "text-[var(--muted-foreground-2)] hover:text-[var(--fg)]"
          }`}
        >
          Banked Facts ({facts.length})
        </button>
        <button
          type="button"
          onClick={() => setViewMode("sessions")}
          className={`flex-1 text-[11px] font-medium py-1 px-3 rounded-[var(--radius-button)] transition-all touch:min-h-11 ${
            viewMode === "sessions"
              ? "bg-[var(--card)] text-[var(--fg)] shadow-[var(--sh-card)] font-semibold"
              : "text-[var(--muted-foreground-2)] hover:text-[var(--fg)]"
          }`}
        >
          Recorded Sessions ({sessions.length})
        </button>
        <button
          type="button"
          onClick={() => setViewMode("sources")}
          className={`flex-1 text-[11px] font-medium py-1 px-3 rounded-[var(--radius-button)] transition-all touch:min-h-11 ${
            viewMode === "sources"
              ? "bg-[var(--card)] text-[var(--fg)] shadow-[var(--sh-card)] font-semibold"
              : "text-[var(--muted-foreground-2)] hover:text-[var(--fg)]"
          }`}
        >
          Workspace Memory
        </button>
      </nav>

      {viewMode === "sources" ? <MemorySourcesView /> : null}

      {/* Recall / Search Form */}
      {viewMode !== "sources" ? <form
        onSubmit={(event) => {
          event.preventDefault();
          void runRecall();
        }}
        className="flex flex-col gap-2"
      >
        <div className="flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <div className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none text-[var(--muted-foreground-2)]">
              <svg aria-hidden="true"  className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Recall a fact (e.g. preferences, stack, conventions)…"
              className="w-full text-[11px] font-mono bg-[var(--card)] border border-[var(--border-1)] rounded-[var(--radius-button)] pl-8 pr-7 py-1.5 text-[var(--fg)] placeholder:text-[var(--muted-foreground-2)] focus:outline-none focus:border-[var(--primary)]/50 focus:ring-1 focus:ring-[var(--ring)] transition-colors"
            />
            {query.length > 0 ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear input text"
                className="absolute inset-y-0 right-0 pr-2 flex items-center text-[var(--muted-foreground-2)] hover:text-[var(--fg)]"
              >
                <svg aria-hidden="true"  className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            ) : null}
          </div>
          <button type="submit" disabled={searching} className={ACCENT_BUTTON}>
            {searching ? "Recalling…" : "Recall"}
          </button>
          {searchActive ? (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                void load();
              }}
              className="text-[11px] text-[var(--muted-foreground-2)] hover:text-[var(--fg)] px-1"
            >
              Clear
            </button>
          ) : null}
        </div>

        {/* Filters bar: Source & Agent */}
        {viewMode === "facts" ? (
          <div className="flex items-center justify-between gap-2 flex-wrap text-[10px] font-mono text-[var(--muted-foreground-2)]">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="uppercase tracking-wider text-[9px] text-[var(--muted-foreground-2)]">Source:</span>
              {(['all', 'run', 'email'] as const).map((src) => (
                <button
                  key={src}
                  type="button"
                  onClick={() => setSourceFilter(src)}
                  className={`px-2 py-0.5 rounded-[var(--radius-button)] border transition-colors ${
                    sourceFilter === src
                      ? "bg-[var(--card)] text-[var(--fg)] border-[var(--primary)]/40 font-semibold shadow-[var(--sh-card)]"
                      : "bg-transparent border-transparent hover:border-[var(--border-1)] text-[var(--muted-foreground-2)]"
                  }`}
                >
                  {src === "all" ? "All" : src.toUpperCase()}
                </button>
              ))}
            </div>

            {availableAgents.length > 1 ? (
              <div className="flex items-center gap-1">
                <span className="uppercase tracking-wider text-[9px] text-[var(--muted-foreground-2)]">Agent:</span>
                <select
                  value={agentFilter}
                  onChange={(e) => setAgentFilter(e.target.value)}
                  className="text-[10px] font-mono bg-[var(--card)] border border-[var(--border-1)] rounded-[var(--radius-button)] px-1.5 py-0.5 text-[var(--fg)] focus:outline-none focus:border-[var(--primary)]/50"
                >
                  <option value="all">All agents</option>
                  {availableAgents.map((ag) => (
                    <option key={ag} value={ag}>
                      @{ag}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </div>
        ) : null}
      </form> : null}

      {/* Notifications & Error Feedback */}
      {notice !== null ? (
        <div className="text-[11px] text-[var(--success)] bg-[color-mix(in_oklch,var(--success)_12%,transparent)] border border-[var(--success)]/20 rounded-[var(--radius-button)] px-2.5 py-2 flex items-center justify-between gap-2">
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="text-[var(--success)] hover:text-[var(--success)]/80 text-[10px] font-semibold"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {error !== null ? (
        <div className="text-[11px] text-[var(--destructive)] bg-[var(--destructive-soft)] border border-[var(--destructive)]/20 rounded-[var(--radius-button)] px-2.5 py-2 flex items-center justify-between gap-2">
          <span className="flex-1">{error}</span>
          <button
            type="button"
            onClick={() => void load()}
            className="text-[var(--destructive)] underline hover:no-underline font-semibold text-[10px]"
          >
            Retry
          </button>
        </div>
      ) : null}

      {/* Active Recall Banner */}
      {searchActive ? (
        <div className="flex items-center justify-between gap-2 bg-[var(--primary)]/5 border border-[var(--primary)]/15 rounded-[var(--radius-button)] px-3 py-2 text-[11px]">
          <div className="flex items-center gap-1.5 text-[var(--primary)]">
            <svg aria-hidden="true"  className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>
              Recall query: <strong className="font-mono font-semibold">"{lastRecallQuery}"</strong> ({visibleFacts.length} match{visibleFacts.length === 1 ? "" : "es"}, ranked by similarity)
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              setQuery("");
              void load();
            }}
            className="text-[10px] font-mono text-[var(--primary)] hover:underline font-semibold shrink-0"
          >
            Reset
          </button>
        </div>
      ) : null}

      {/* VIEW MODE 1: FACTS */}
      {viewMode === "facts" ? (
        <section aria-label="Banked Facts" className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h4 className="text-[10px] font-bold uppercase tracking-wider text-[var(--muted-foreground-2)]">
              {searchActive ? "Recall results" : "Facts"}
            </h4>
            <span className="text-[10px] font-mono text-[var(--muted-foreground-2)]">
              {visibleFacts.length} {visibleFacts.length === 1 ? "fact" : "facts"}
            </span>
          </div>

          {loading ? (
            <div className="flex flex-col items-center justify-center py-8 border border-dashed border-[var(--border-1)] rounded-[var(--radius-button)] bg-[var(--bg)] px-4 text-center">
              <p className="text-[var(--muted-foreground-2)] text-xs">Loading memory…</p>
            </div>
          ) : visibleFacts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 border border-dashed border-[var(--border-1)] rounded-[var(--radius-button)] bg-[var(--bg)] px-4 text-center">
              <p className="text-[var(--muted-foreground-2)] text-xs">
                {searchActive
                  ? `Nothing recalled for "${lastRecallQuery}".`
                  : sourceFilter !== "all" || agentFilter !== "all"
                  ? "No facts match current filters."
                  : "No facts banked yet."}
              </p>
            </div>
      ) : (
            <ol className="flex flex-col gap-2.5">
              {visibleFacts.map((fact) => {
                const isConfirming = confirmForget === fact.id;
                const scoreText = formatRecallScore(fact.score);

                return (
                  <li
                    key={fact.id}
                    className="border border-[var(--border-1)] hover:border-[var(--border-2)] rounded-[var(--radius-button)] bg-[var(--card)] p-3.5 shadow-[var(--sh-card)] transition-all flex flex-col gap-2"
                  >
                    <pre className="font-mono text-[11px] text-[var(--fg)] whitespace-pre-wrap break-words leading-relaxed bg-[var(--secondary)] p-2.5 rounded-[var(--radius-button)] border border-[var(--border-1)]">
                      {fact.fact}
                    </pre>

                    <div className="flex items-center gap-2 flex-wrap pt-1">
                      <span
                        className={`text-[10px] font-bold uppercase tracking-wider border rounded-[var(--radius-button)] px-2 py-0.5 ${sourceChipClass(
                          fact.source,
                        )}`}
                      >
                        {fact.source}
                      </span>

                      <span className="text-[10px] font-mono text-[var(--muted-foreground-2)] bg-[var(--bg)] border border-[var(--border-1)] px-1.5 py-0.5 rounded-[var(--radius-button)]">
                        @{fact.agent}
                      </span>

                      <time
                        dateTime={new Date(fact.created_at).toISOString()}
                        title={new Date(fact.created_at).toLocaleString()}
                        className="text-[10px] font-mono text-[var(--muted-foreground-2)]"
                      >
                        {formatTimeAgo(fact.created_at)}
                      </time>

                      {scoreText !== "" ? (
                        <span
                          className="text-[10px] font-mono text-[var(--primary)] bg-[var(--primary-soft)] border border-[var(--primary)]/20 px-2 py-0.5 rounded-[var(--radius-button)] font-semibold"
                          title={`Relevance score: ${scoreText}`}
                        >
                          Score {scoreText}
                        </span>
                      ) : null}

                      <span className="flex-1 min-w-[8px]" />

                      {!isConfirming ? (
                        <button
                          type="button"
                          className={GHOST_BUTTON}
                          onClick={() => setConfirmForget(fact.id)}
                          aria-label={`Forget fact ${fact.id}`}
                        >
                          <svg aria-hidden="true"  className="w-3 h-3 text-[var(--muted-foreground-2)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={1.8}
                              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                            />
                          </svg>
                          <span>Forget</span>
                        </button>
                      ) : null}
                    </div>

                    {/* Explicit Two-Step Confirmation Prompt */}
                    {isConfirming ? (
                      <div className="mt-1 bg-[var(--destructive)]/5 border border-[var(--destructive)]/25 rounded-[var(--radius-button)] p-2.5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex items-center gap-1.5 text-[11px] text-[var(--destructive)]">
                          <svg aria-hidden="true"  className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                            />
                          </svg>
                          <span>Permanently forget this fact? This cannot be undone.</span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            className={DANGER_BUTTON}
                            disabled={forgetBusy === fact.id}
                            onClick={() => void forgetFact(fact.id)}
                          >
                            {forgetBusy === fact.id ? "Forgetting…" : "Confirm forget"}
                          </button>
                          <button
                            type="button"
                            className={GHOST_BUTTON}
                            onClick={() => setConfirmForget(null)}
                          >
                            Keep
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      ) : null}

      {/* VIEW MODE 2: SESSIONS */}
      {viewMode === "sessions" ? (
        <section aria-label="Recorded Sessions" className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h4 className="text-[10px] font-bold uppercase tracking-wider text-[var(--muted-foreground-2)]">
              Recorded Sessions
            </h4>
            <span className="text-[10px] font-mono text-[var(--muted-foreground-2)]">
              {visibleSessions.length} {visibleSessions.length === 1 ? "session" : "sessions"}
            </span>
          </div>

          {!loading && visibleSessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-6 border border-dashed border-[var(--border-1)] rounded-[var(--radius-button)] bg-[var(--bg)] px-4 text-center">
              <p className="text-[var(--muted-foreground-2)] text-xs">
                {agentFilter !== "all"
                  ? "No sessions recorded for selected agent."
                  : "No sessions recorded yet."}
              </p>
            </div>
          ) : (
            <ol className="flex flex-col gap-2">
              {visibleSessions.map((session) => {
                const expanded = expandedSession === session.id;
                return (
                  <li
                    key={session.id}
                    className={`border rounded-[var(--radius-button)] bg-[var(--card)] overflow-hidden transition-colors ${
                      expanded ? "border-[var(--primary)]/50 shadow-[var(--sh-card)]" : "border-[var(--border-1)] hover:border-[var(--border-2)]"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setExpandedSession(expanded ? null : session.id)}
                      aria-expanded={expanded}
                      className="w-full text-left p-3 hover:bg-[var(--secondary)] transition-colors flex items-center gap-2 touch:min-h-11"
                    >
                      <svg aria-hidden="true" 
                        className={`w-3.5 h-3.5 text-[var(--muted-foreground-2)] transition-transform shrink-0 ${
                          expanded ? "rotate-90" : ""
                        }`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                      <span className="text-[10px] font-mono text-[var(--primary)] bg-[var(--primary-soft)] border border-[var(--primary)]/20 px-1.5 py-0.5 rounded-[var(--radius-button)] font-semibold">
                        @{session.agent}
                      </span>
                      <span className="font-mono text-[11px] text-[var(--fg)] truncate flex-1">
                        Session {session.id}
                      </span>
                      <time
                        dateTime={new Date(session.started_at).toISOString()}
                        title={new Date(session.started_at).toLocaleString()}
                        className="text-[10px] font-mono text-[var(--muted-foreground-2)] shrink-0 ml-auto"
                      >
                        {formatTimeAgo(session.started_at)}
                      </time>
                    </button>
                    {expanded ? (
                      <div className="px-3 pb-3 pt-1 border-t border-[var(--border-1)] flex flex-col gap-2">
                        <div className="flex items-center justify-between text-[10px] font-mono text-[var(--muted-foreground-2)]">
                          <span>Started: {new Date(session.started_at).toLocaleString()}</span>
                          <span>ID: {session.id}</span>
                        </div>
                        <pre className="font-mono text-[11px] text-[var(--fg)] bg-[var(--card)]/60 p-2.5 rounded-[var(--radius-button)] border border-[var(--border-1)] whitespace-pre-wrap break-words max-h-48 overflow-auto leading-relaxed">
                          {session.summary}
                        </pre>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      ) : null}
    </div>
  );
}
