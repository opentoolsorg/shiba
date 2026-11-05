/**
 * MemoryTab — Durable agent memory view (banked facts, recorded sessions, workspace sources).
 * Renders inside MainCard with a 48px header row, breadcrumb navigation, and search/sync actions.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { Brain, ChevronRight, History, RefreshCw, Search, X } from "lucide-react";
import type { MemoryFact, MemorySession } from "../types";
import { formatTimeAgo } from "../ui-helpers";
import { MemorySourcesView } from "./MemorySourcesView";
import { EmptyState, type Scope } from "./ui/ContextPanel";

const FIELD =
  "w-full border border-[#e4e4e7] dark:border-zinc-800 bg-white dark:bg-zinc-800 rounded-lg px-2.5 py-1.5 text-xs text-[#0a0a0a] dark:text-zinc-100 placeholder:text-[#71717a] dark:placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-400 font-sans touch:min-h-11";
const BUTTON =
  "border border-[#e4e4e7] dark:border-zinc-800 bg-white dark:bg-zinc-800 px-3 py-1.5 text-xs font-medium text-[#0a0a0a] dark:text-zinc-100 rounded-lg hover:bg-[#f4f4f5] dark:hover:bg-zinc-700 disabled:opacity-50 transition-colors inline-flex items-center justify-center gap-1.5 touch:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]";
const PRIMARY =
  "bg-[#0a0a0a] dark:bg-zinc-100 text-white dark:text-zinc-900 px-3 py-1.5 text-xs font-medium rounded-lg hover:bg-zinc-800 dark:hover:bg-zinc-200 disabled:opacity-50 transition-colors shadow-xs inline-flex items-center justify-center gap-1.5 touch:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]";
const DANGER =
  "border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300 px-3 py-1.5 text-xs font-medium rounded-lg hover:bg-rose-100 dark:hover:bg-rose-900/60 disabled:opacity-50 transition-colors inline-flex items-center justify-center gap-1.5 touch:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]";

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `Request failed: ${response.status}`);
  }
  return body;
}

export function sourceChipClass(source: string): string {
  switch (source) {
    case "run":
      return "text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/50";
    case "email":
      return "text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/50";
    default:
      return "text-[#71717a] dark:text-zinc-400 border-[#e4e4e7] dark:border-zinc-800 bg-[#fafafa] dark:bg-zinc-800";
  }
}

export function formatRecallScore(score?: number): string {
  if (typeof score !== "number" || Number.isNaN(score)) return "";
  return score.toFixed(2);
}

export function filterFactsBySource(facts: MemoryFact[], source: string): MemoryFact[] {
  if (!source || source === "all") return facts;
  return facts.filter((f) => f.source.toLowerCase() === source.toLowerCase());
}

export function filterFactsByAgent(facts: MemoryFact[], agent: string): MemoryFact[] {
  if (!agent || agent === "all") return facts;
  return facts.filter((f) => f.agent === agent);
}

export type MemoryViewMode = "facts" | "sessions" | "sources";

export interface MemoryTabProps {
  initialViewMode?: MemoryViewMode;
  activeView?: MemoryViewMode;
  onSelectView?: (view: MemoryViewMode) => void;
  scope?: Scope;
  initialFacts?: MemoryFact[];
  initialSessions?: MemorySession[];
  onForgetFact?: (factId: string) => void;
  onCountsChange?: (counts: Partial<{ facts: number; sessions: number; sources: number }>) => void;
  className?: string;
}

export function MemoryTab(props: MemoryTabProps): JSX.Element {
  const {
    initialFacts,
    initialSessions,
    onForgetFact,
    activeView: externalView,
    onSelectView,
    scope = "personal",
    onCountsChange,
    className = "",
  } = props;

  const [facts, setFacts] = useState<MemoryFact[]>(initialFacts ?? []);
  const [sessions, setSessions] = useState<MemorySession[]>(initialSessions ?? []);
  const [query, setQuery] = useState("");
  const [searchActive, setSearchActive] = useState(false);
  const [showSearchInput, setShowSearchInput] = useState(false);
  const [lastRecallQuery, setLastRecallQuery] = useState("");
  const [loading, setLoading] = useState(initialFacts === undefined && initialSessions === undefined);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [confirmForget, setConfirmForget] = useState<string | null>(null);
  const [forgetBusy, setForgetBusy] = useState<string | null>(null);

  const [internalViewMode, setInternalViewMode] = useState<MemoryViewMode>(props.initialViewMode ?? "facts");
  const viewMode = externalView ?? internalViewMode;

  const handleSelectView = (view: MemoryViewMode) => {
    setInternalViewMode(view);
    onSelectView?.(view);
  };

  const [sourceFilter, setSourceFilter] = useState("all");
  const [agentFilter, setAgentFilter] = useState("all");

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
      const fList = Array.isArray(factsBody.facts) ? factsBody.facts : [];
      const sList = Array.isArray(sessionsBody.sessions) ? sessionsBody.sessions : [];
      setFacts(fList);
      totalFactsRef.current = fList.length;
      setSessions(sList);
      onCountsChange?.({ facts: fList.length, sessions: sList.length });
      setSearchActive(false);
      setLastRecallQuery("");
    } catch (err) {
      if (listRequestRef.current === request) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (listRequestRef.current === request) setLoading(false);
    }
  }, [onCountsChange]);

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
      handleSelectView("facts");
    } catch (err) {
      if (listRequestRef.current === request) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (listRequestRef.current === request) setSearching(false);
    }
  }, [query]);

  // Total stored facts (a recall search shows only hits, so facts.length is not the total).
  const totalFactsRef = useRef(initialFacts?.length ?? 0);

  const forgetFact = useCallback(
    async (factId: string) => {
      setForgetBusy(factId);
      setError(null);
      try {
        await apiJson(`/api/memory/facts/${encodeURIComponent(factId)}`, { method: "DELETE" });
        setFacts((prev) => prev.filter((fact) => fact.id !== factId));
        totalFactsRef.current = Math.max(0, totalFactsRef.current - 1);
        onCountsChange?.({ facts: totalFactsRef.current });
        setNotice("Fact forgotten from agent memory.");
        onForgetFact?.(factId);
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
    [onForgetFact, onCountsChange],
  );

  const availableAgents = useMemo(() => {
    const agents = new Set<string>();
    for (const f of facts) if (f.agent) agents.add(f.agent);
    for (const s of sessions) if (s.agent) agents.add(s.agent);
    return Array.from(agents).sort();
  }, [facts, sessions]);

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

  const visibleSessions = useMemo(() => {
    if (agentFilter === "all") return sessions;
    return sessions.filter((s) => s.agent === agentFilter);
  }, [sessions, agentFilter]);

  const scopeLabel = scope === "workspace" ? "Workspace" : "Personal";
  const viewTitle =
    viewMode === "facts"
      ? "Banked Facts"
      : viewMode === "sources"
      ? "Workspace Sources"
      : "Recorded Sessions";

  return (
    <div className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${className}`.trim()}>
      {/* 48px Header row: Breadcrumb + Actions */}
      <div className="h-12 border-b border-[#e4e4e7] dark:border-zinc-800 px-4 flex items-center justify-between shrink-0">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs font-mono text-[#71717a] dark:text-zinc-400">
          <span>{scopeLabel}</span>
          <span className="text-[#a1a1aa] dark:text-zinc-600">/</span>
          <span>Memory</span>
          <span className="text-[#a1a1aa] dark:text-zinc-600">/</span>
          <span className="text-[#0a0a0a] dark:text-zinc-100 font-medium">{viewTitle}</span>
        </nav>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setShowSearchInput((prev) => !prev)}
            aria-label="Toggle search input"
            className="p-1.5 text-[#71717a] dark:text-zinc-400 hover:text-[#0a0a0a] dark:hover:text-zinc-100 rounded-md hover:bg-[#f4f4f5] dark:hover:bg-zinc-800 transition-colors touch:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
          >
            <Search className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            aria-label="Reload memory"
            title="Reload memory facts and sessions"
            className="p-1.5 text-[#71717a] dark:text-zinc-400 hover:text-[#0a0a0a] dark:hover:text-zinc-100 rounded-md hover:bg-[#f4f4f5] dark:hover:bg-zinc-800 transition-colors disabled:opacity-50 touch:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
          >
            <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
        {/* Fallback segmented view switcher for standalone mode */}
        {!externalView ? (
          <nav aria-label="Memory sections" className="flex items-center gap-1 bg-[#f4f4f5] dark:bg-zinc-800/80 p-1 rounded-lg border border-[#e4e4e7] dark:border-zinc-800">
            <button
              type="button"
              onClick={() => handleSelectView("facts")}
              className={`flex-1 text-xs font-medium py-1 px-3 rounded-md transition-all  touch:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] ${
                viewMode === "facts"
                  ? "bg-white dark:bg-zinc-900 text-[#0a0a0a] dark:text-zinc-100 shadow-xs font-semibold"
                  : "text-[#71717a] dark:text-zinc-400 hover:text-[#0a0a0a] dark:hover:text-zinc-100"
              }`}
            >
              Banked Facts ({facts.length})
            </button>
            <button
              type="button"
              onClick={() => handleSelectView("sessions")}
              className={`flex-1 text-xs font-medium py-1 px-3 rounded-md transition-all  touch:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] ${
                viewMode === "sessions"
                  ? "bg-white dark:bg-zinc-900 text-[#0a0a0a] dark:text-zinc-100 shadow-xs font-semibold"
                  : "text-[#71717a] dark:text-zinc-400 hover:text-[#0a0a0a] dark:hover:text-zinc-100"
              }`}
            >
              Recorded Sessions ({sessions.length})
            </button>
            <button
              type="button"
              onClick={() => handleSelectView("sources")}
              className={`flex-1 text-xs font-medium py-1 px-3 rounded-md transition-all  touch:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] ${
                viewMode === "sources"
                  ? "bg-white dark:bg-zinc-900 text-[#0a0a0a] dark:text-zinc-100 shadow-xs font-semibold"
                  : "text-[#71717a] dark:text-zinc-400 hover:text-[#0a0a0a] dark:hover:text-zinc-100"
              }`}
            >
              Workspace Memory
            </button>
          </nav>
        ) : null}

        {/* Search / Recall Bar */}
        {showSearchInput || viewMode !== "sources" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void runRecall();
            }}
            className="flex flex-col gap-2.5 border border-[#e4e4e7] dark:border-zinc-800 rounded-xl bg-[#fafafa] dark:bg-zinc-900 p-3 shadow-xs"
          >
            <div className="flex items-center gap-2">
              <div className="relative flex-1 min-w-0">
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Recall a fact (e.g. preferences, stack, conventions)…"
                  className={FIELD}
                />
                {query.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    aria-label="Clear input text"
                    className="absolute inset-y-0 right-0 pr-2 flex items-center text-[#71717a] hover:text-[#0a0a0a] dark:text-zinc-400 dark:hover:text-zinc-100 touch:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
                  >
                    <X className="size-3.5" />
                  </button>
                ) : null}
              </div>
              <button type="submit" disabled={searching} className={PRIMARY}>
                {searching ? "Recalling…" : "Recall"}
              </button>
              {searchActive ? (
                <button
                  type="button"
                  onClick={() => {
                    setQuery("");
                    void load();
                  }}
                  className="text-xs text-[#71717a] hover:text-[#0a0a0a] dark:text-zinc-400 dark:hover:text-zinc-100 px-1 font-medium touch:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
                >
                  Clear
                </button>
              ) : null}
            </div>

            {viewMode === "facts" ? (
              <div className="flex items-center justify-between gap-2 flex-wrap text-xs text-[#71717a] dark:text-zinc-400">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="uppercase tracking-wider text-[10px] font-mono">Source:</span>
                  {(["all", "run", "email"] as const).map((src) => (
                    <button
                      key={src}
                      type="button"
                      onClick={() => setSourceFilter(src)}
                      className={`px-2 py-0.5 rounded-md border text-xs font-mono transition-colors  touch:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] ${
                        sourceFilter === src
                          ? "bg-white dark:bg-zinc-800 text-[#0a0a0a] dark:text-zinc-100 border-[#0a0a0a] dark:border-zinc-400 font-semibold shadow-xs"
                          : "bg-transparent border-transparent hover:border-[#e4e4e7] dark:hover:border-zinc-700 text-[#71717a] dark:text-zinc-400"
                      }`}
                    >
                      {src === "all" ? "All" : src.toUpperCase()}
                    </button>
                  ))}
                </div>

                {availableAgents.length > 1 ? (
                  <div className="flex items-center gap-1.5">
                    <span className="uppercase tracking-wider text-[10px] font-mono">Agent:</span>
                    <select
                      value={agentFilter}
                      onChange={(e) => setAgentFilter(e.target.value)}
                      className="text-xs font-mono bg-white dark:bg-zinc-800 border border-[#e4e4e7] dark:border-zinc-700 rounded-md px-2 py-0.5 text-[#0a0a0a] dark:text-zinc-100 focus:outline-none touch:min-h-11"
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
          </form>
        ) : null}

        {/* Notifications & Error Feedback */}
        {notice !== null ? (
          <div role="status" className="border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/60 p-3 rounded-xl text-xs text-emerald-800 dark:text-emerald-300 flex items-center justify-between gap-2">
            <span>{notice}</span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="text-emerald-800 dark:text-emerald-300 hover:underline font-semibold touch:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
            >
              Dismiss
            </button>
          </div>
        ) : null}

        {error !== null ? (
          <div role="alert" className="border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/60 p-3 rounded-xl text-xs text-rose-800 dark:text-rose-300 flex items-center justify-between gap-2">
            <span className="flex-1">{error}</span>
            <button
              type="button"
              onClick={() => void load()}
              className="text-rose-800 dark:text-rose-300 underline font-semibold touch:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
            >
              Retry
            </button>
          </div>
        ) : null}

        {/* Active Recall Banner */}
        {searchActive ? (
          <div className="flex items-center justify-between gap-2 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 rounded-xl px-3.5 py-2 text-xs text-blue-800 dark:text-blue-300">
            <span>
              Recall query: <strong>"{lastRecallQuery}"</strong> ({visibleFacts.length} match{visibleFacts.length === 1 ? "" : "es"})
            </span>
            <button
              type="button"
              onClick={() => {
                setQuery("");
                void load();
              }}
              className="font-mono underline text-xs font-medium touch:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
            >
              Reset
            </button>
          </div>
        ) : null}

        {/* Sources View */}
        {viewMode === "sources" ? <MemorySourcesView onCountsChange={onCountsChange} /> : null}

        {/* Facts View */}
        {viewMode === "facts" ? (
          <section aria-label="Banked Facts" className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase font-mono tracking-wider text-[#71717a] dark:text-zinc-400">
                {searchActive ? "Recall results" : "Banked Facts"}
              </h4>
              <span className="text-xs font-mono text-[#71717a] dark:text-zinc-400">
                {visibleFacts.length} {visibleFacts.length === 1 ? "fact" : "facts"}
              </span>
            </div>

            {loading ? (
              <div className="flex flex-col items-center justify-center py-10 border border-dashed border-[#e4e4e7] dark:border-zinc-800 rounded-xl text-xs text-[#71717a] dark:text-zinc-400">
                Loading memory…
              </div>
            ) : visibleFacts.length === 0 ? (
              <EmptyState
                icon={Brain}
                title={searchActive ? `Nothing recalled for "${lastRecallQuery}"` : "No banked facts yet"}
                description={
                  searchActive
                    ? "Try a different recall query or check your source filters."
                    : "Facts extracted during agent runs and sessions will appear here automatically."
                }
              />
            ) : (
              <ol className="flex flex-col gap-2.5">
                {visibleFacts.map((fact) => {
                  const isConfirming = confirmForget === fact.id;
                  const scoreText = formatRecallScore(fact.score);

                  return (
                    <li
                      key={fact.id}
                      className="border border-[#e4e4e7] dark:border-zinc-800 rounded-xl bg-white dark:bg-zinc-900 p-3.5 shadow-xs flex flex-col gap-2.5 transition-colors"
                    >
                      <pre className="font-sans text-xs text-[#0a0a0a] dark:text-zinc-200 whitespace-pre-wrap break-words leading-relaxed bg-[#fafafa] dark:bg-zinc-800/60 p-2.5 rounded-lg border border-[#e4e4e7] dark:border-zinc-800">
                        {fact.fact}
                      </pre>

                      <div className="flex items-center gap-2 flex-wrap pt-0.5">
                        <span
                          className={`text-[10px] font-bold font-mono uppercase tracking-wider border rounded-md px-2 py-0.5 ${sourceChipClass(
                            fact.source,
                          )}`}
                        >
                          {fact.source}
                        </span>

                        <span className="text-[10px] font-mono text-[#71717a] dark:text-zinc-400 bg-[#fafafa] dark:bg-zinc-800 border border-[#e4e4e7] dark:border-zinc-700 px-1.5 py-0.5 rounded-md">
                          @{fact.agent}
                        </span>

                        <time
                          dateTime={new Date(fact.created_at).toISOString()}
                          title={new Date(fact.created_at).toLocaleString()}
                          className="text-[10px] font-mono text-[#71717a] dark:text-zinc-400"
                        >
                          {formatTimeAgo(fact.created_at)}
                        </time>

                        {scoreText !== "" ? (
                          <span
                            className="text-[10px] font-mono text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-900 px-2 py-0.5 rounded-md font-semibold"
                            title={`Relevance score: ${scoreText}`}
                          >
                            Score {scoreText}
                          </span>
                        ) : null}

                        <span className="flex-1 min-w-[8px]" />

                        {!isConfirming ? (
                          <button
                            type="button"
                            className={BUTTON}
                            onClick={() => setConfirmForget(fact.id)}
                            aria-label={`Forget fact ${fact.id}`}
                          >
                            Forget
                          </button>
                        ) : null}
                      </div>

                      {/* Explicit Two-Step Confirmation Prompt */}
                      {isConfirming ? (
                        <div className="mt-1 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg p-2.5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between text-xs text-rose-800 dark:text-rose-300">
                          <span>Permanently forget this fact? This cannot be undone.</span>
                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              type="button"
                              className={DANGER}
                              disabled={forgetBusy === fact.id}
                              onClick={() => void forgetFact(fact.id)}
                            >
                              {forgetBusy === fact.id ? "Forgetting…" : "Confirm forget"}
                            </button>
                            <button
                              type="button"
                              className={BUTTON}
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

        {/* Sessions View */}
        {viewMode === "sessions" ? (
          <section aria-label="Recorded Sessions" className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase font-mono tracking-wider text-[#71717a] dark:text-zinc-400">
                Recorded Sessions
              </h4>
              <span className="text-xs font-mono text-[#71717a] dark:text-zinc-400">
                {visibleSessions.length} {visibleSessions.length === 1 ? "session" : "sessions"}
              </span>
            </div>

            {!loading && visibleSessions.length === 0 ? (
              <EmptyState
                icon={History}
                title="No sessions recorded yet"
                description={
                  agentFilter !== "all"
                    ? "No recorded sessions match the selected agent."
                    : "Interactive sessions will be summarized and banked here across turns."
                }
              />
            ) : (
              <ol className="flex flex-col gap-2">
                {visibleSessions.map((session) => {
                  const expanded = expandedSession === session.id;
                  return (
                    <li
                      key={session.id}
                      className={`border rounded-xl bg-white dark:bg-zinc-900 overflow-hidden transition-colors ${
                        expanded ? "border-[#0a0a0a] dark:border-zinc-500 shadow-xs" : "border-[#e4e4e7] dark:border-zinc-800 hover:border-zinc-400"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => setExpandedSession(expanded ? null : session.id)}
                        aria-expanded={expanded}
                        className="w-full text-left p-3 hover:bg-[#fafafa] dark:hover:bg-zinc-800/50 transition-colors flex items-center gap-2 touch:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
                      >
                        <ChevronRight
                          className={`size-4 text-[#71717a] dark:text-zinc-400 transition-transform shrink-0 ${
                            expanded ? "rotate-90" : ""
                          }`}
                        />
                        <span className="text-[10px] font-mono text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-900 px-1.5 py-0.5 rounded-md font-semibold">
                          @{session.agent}
                        </span>
                        <span className="font-mono text-xs text-[#0a0a0a] dark:text-zinc-100 truncate flex-1">
                          Session {session.id}
                        </span>
                        <time
                          dateTime={new Date(session.started_at).toISOString()}
                          title={new Date(session.started_at).toLocaleString()}
                          className="text-[10px] font-mono text-[#71717a] dark:text-zinc-400 shrink-0 ml-auto"
                        >
                          {formatTimeAgo(session.started_at)}
                        </time>
                      </button>
                      {expanded ? (
                        <div className="px-3 pb-3 pt-1 border-t border-[#e4e4e7] dark:border-zinc-800 flex flex-col gap-2">
                          <div className="flex items-center justify-between text-[10px] font-mono text-[#71717a] dark:text-zinc-400">
                            <span>Started: {new Date(session.started_at).toLocaleString()}</span>
                            <span>ID: {session.id}</span>
                          </div>
                          <pre className="font-sans text-xs text-[#0a0a0a] dark:text-zinc-200 bg-[#fafafa] dark:bg-zinc-800/60 p-2.5 rounded-lg border border-[#e4e4e7] dark:border-zinc-800 whitespace-pre-wrap break-words max-h-48 overflow-auto leading-relaxed">
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
    </div>
  );
}
