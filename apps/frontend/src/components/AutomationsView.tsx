import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Copy,
  PanelLeft,
  Plus,
  Search,
  Sparkles,
  Webhook,
  Zap,
} from "lucide-react";
import { LoadErrorState } from "./LoadErrorState";
import { useCustomAgentOptions } from "./CustomAgentsView";
import { ContextPanel, MainCard, PanelNavItem, type Scope } from "./ui/ContextPanel";

export interface AutomationRecord {
  id: string;
  prompt: string;
  repoUrl: string;
  enabled: boolean;
  runCount?: number;
  lastTriggeredAt?: number;
  lastSkip?: { at: number; reason: string };
  triggers: { kind: string }[];
  customAgentId?: string;
}

export const RECIPES = [
  {
    id: "pr-review",
    name: "Review opened pull requests",
    cadence: "GitHub event",
    description: "Check pull requests for bugs, regressions, and missing tests.",
    prompt:
      "Review the latest opened pull request in this repository. Check for correctness bugs, missing tests, and regressions. Fix any blocking issues you find and open a PR with the fixes.",
    triggers: [{ kind: "github", events: ["pull_request:opened"] }],
  },
  {
    id: "nightly-lint",
    name: "Nightly lint fixes",
    cadence: "0 3 * * *",
    description: "Fix lint violations each night and open a pull request.",
    prompt:
      "Run the repository's linter. Fix every violation it reports — formatting, unused imports, dead code. Open a PR with the clean tree.",
    triggers: [{ kind: "schedule", cron: "0 3 * * *" }],
  },
  {
    id: "weekly-deps",
    name: "Weekly dependency and secret scan",
    cadence: "0 9 * * 1",
    description: "Check for vulnerable dependencies and committed secrets.",
    prompt:
      "Audit dependencies for known vulnerabilities and committed secrets. Apply safe patch/minor bumps and remove any leaked credentials. Open a PR with the results.",
    triggers: [{ kind: "schedule", cron: "0 9 * * 1" }],
  },
  {
    id: "docs-sync",
    name: "Update documentation",
    cadence: "0 4 * * 6",
    description: "Update documentation to reflect the week's code changes.",
    prompt:
      "Compare the docs (README, JSDoc, API references) against the code changed in the last week. Update stale sections and open a PR.",
    triggers: [{ kind: "schedule", cron: "0 4 * * 6" }],
  },
  {
    id: "oncall-triage",
    name: "Slack incident triage",
    cadence: "Slack event",
    description: "Investigate incident reports from Slack, grouped by burst.",
    prompt:
      "An incident was reported in Slack. Investigate the repository for the likely cause, write a fix or mitigation, and open a PR. Include a root-cause note in the PR description.",
    triggers: [{ kind: "slack", textContains: ["incident", "error", "down"], burstWindowSeconds: 60 }],
  },
  {
    id: "manual-audit",
    name: "Repository audit",
    cadence: "Manual",
    description: "Queue an audit for approval when you need one.",
    prompt:
      "Audit this repository end to end: dead code, missing error handling, unsafe patterns, and inconsistent interfaces. Open a PR with the highest-impact fixes.",
    triggers: [{ kind: "manual" }],
  },
];

const STARTER_CHIPS = [
  { label: "Review pull requests", recipeId: "pr-review" },
  { label: "Nightly lint fixes", recipeId: "nightly-lint" },
  { label: "Dependency scan", recipeId: "weekly-deps" },
  { label: "Update documentation", recipeId: "docs-sync" },
];

export interface AutomationsPanelProps {
  scope: Scope;
  onScopeChange: (scope: Scope) => void;
  active: string;
  onSelect: (id: string) => void;
  automations?: AutomationRecord[];
  onNewAutomation?: () => void;
  className?: string;
}

/**
 * Secondary panel for Automations.
 */
export function AutomationsPanel({
  scope,
  onScopeChange,
  active,
  onSelect,
  automations = [],
  onNewAutomation,
  className = "",
}: AutomationsPanelProps): JSX.Element {
  return (
    <ContextPanel
      title="Automations"
      scope={scope}
      onScopeChange={onScopeChange}
      className={className}
      actions={
        onNewAutomation ? (
          <button
            type="button"
            onClick={onNewAutomation}
            aria-label="New automation"
            className="flex size-7 items-center justify-center rounded-md text-[#71717a] hover:bg-[#f4f4f5] hover:text-[#0a0a0a] transition-colors dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            <Plus className="size-4" aria-hidden="true" />
          </button>
        ) : undefined
      }
    >
      <nav aria-label="Automations navigation" className="flex flex-col gap-0.5 pt-1">
        <PanelNavItem
          icon={Zap}
          label="All automations"
          active={active === "automations" || active === "all"}
          onClick={() => onSelect("automations")}
          trailing={
            automations.length > 0 ? (
              <span className="text-[11px] text-[#71717a] dark:text-zinc-400 font-mono">
                {automations.length}
              </span>
            ) : null
          }
        />
        <PanelNavItem
          icon={BookOpen}
          label="Recipes"
          active={active === "recipes"}
          onClick={() => onSelect("recipes")}
        />
        <PanelNavItem
          icon={Webhook}
          label="Triggers"
          active={active === "triggers"}
          onClick={() => onSelect("triggers")}
        />

        {automations.length > 0 ? (
          <div className="mt-3 border-t border-[#e4e4e7] pt-2 dark:border-zinc-800">
            <p className="px-2.5 py-1 text-[11px] font-medium uppercase tracking-wider text-[#71717a] dark:text-zinc-400">
              Deployed
            </p>
            <div className="flex flex-col gap-0.5">
              {automations.map((a) => (
                <PanelNavItem
                  key={a.id}
                  icon={Zap}
                  label={RECIPES.find((r) => r.id === a.id)?.name ?? a.id}
                  active={active === a.id}
                  onClick={() => onSelect(a.id)}
                  trailing={
                    <span
                      className={`size-1.5 rounded-full ${
                        a.enabled ? "bg-emerald-500" : "bg-zinc-400 dark:bg-zinc-600"
                      }`}
                    />
                  }
                />
              ))}
            </div>
          </div>
        ) : null}
      </nav>
    </ContextPanel>
  );
}

export interface AutomationsViewProps {
  scope?: Scope;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  selectedAutomationId?: string | null;
  onSelectAutomation?: (id: string) => void;
  className?: string;
}

export function AutomationsView({
  scope = "personal",
  sidebarCollapsed = false,
  onToggleSidebar,
  selectedAutomationId = null,
  onSelectAutomation,
  className = "",
}: AutomationsViewProps): JSX.Element {
  const [copiedEndpoint, setCopiedEndpoint] = useState<string | null>(null);
  const [automations, setAutomations] = useState<AutomationRecord[] | null>(null);
  const [repoUrl, setRepoUrl] = useState("");
  const [customAgentId, setCustomAgentId] = useState("");
  const { agents: customAgents } = useCustomAgentOptions();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<"automations" | "recipes" | "triggers">("automations");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const copyTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    },
    [],
  );

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(null);
      setCopiedEndpoint(label);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopiedEndpoint(null), 2000);
    } catch {
      setCopiedEndpoint(null);
      setNotice("Could not copy the endpoint. Select and copy it instead.");
    }
  };

  const refresh = useCallback(() => {
    setLoadError(null);
    fetch("/api/automations")
      .then(async (r) => {
        if (!r.ok) throw new Error(`Automations could not be loaded (${r.status}).`);
        return (await r.json()) as { automations?: AutomationRecord[] };
      })
      .then((body) => setAutomations(body.automations ?? []))
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : "Automations could not be loaded.");
      });
  }, []);
  useEffect(refresh, [refresh]);

  const deployRecipe = async (recipe: (typeof RECIPES)[number]) => {
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+/.test(repoUrl.trim())) {
      setNotice("Enter a GitHub repository URL first.");
      return;
    }
    setBusyId(recipe.id);
    setNotice(null);
    try {
      const response = await fetch("/api/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: recipe.id,
          prompt: recipe.prompt,
          repoUrl: repoUrl.trim(),
          triggers: recipe.triggers,
          enabled: true,
          ...(customAgentId ? { customAgentId } : {}),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) setNotice(body.error ?? `Could not create automation (${response.status}).`);
      else {
        setNotice(`Created "${recipe.name}".`);
        refresh();
      }
    } catch {
      setNotice("Could not create automation: the backend could not be reached.");
    } finally {
      setBusyId(null);
    }
  };

  const triggerNow = async (id: string) => {
    setBusyId(`run-${id}`);
    setNotice(null);
    try {
      const response = await fetch(`/api/automations/${encodeURIComponent(id)}/run`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        fired?: number;
        skipped?: number;
      };
      if (!response.ok) setNotice(body.error ?? `Could not queue run (${response.status}).`);
      else {
        setNotice(
          body.fired ? `Approval queued for "${id}".` : `Skipped "${id}". Check its last skip reason.`,
        );
        refresh();
      }
    } catch {
      setNotice("Could not queue run: the backend could not be reached.");
    } finally {
      setBusyId(null);
    }
  };

  const setAutomationEnabled = async (id: string, enabled: boolean) => {
    setBusyId(`toggle-${id}`);
    setNotice(null);
    try {
      const response = await fetch(`/api/automations/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) setNotice(body.error ?? `Could not update automation (${response.status}).`);
      else refresh();
    } catch {
      setNotice("Could not update automation: the backend could not be reached.");
    } finally {
      setBusyId(null);
    }
  };

  const matches = (value: string) => value.toLowerCase().includes(query.trim().toLowerCase());
  const filtered =
    automations?.filter((a) =>
      matches(`${a.id} ${a.repoUrl} ${a.prompt} ${a.triggers.map((t) => t.kind).join(" ")}`),
    ) ?? [];
  const recipes = RECIPES.filter((recipe) =>
    matches(`${recipe.name} ${recipe.description} ${recipe.cadence}`),
  );

  const scopeLabel = scope === "workspace" ? "Workspace" : "Personal";
  const tabLabel = tab === "automations" ? "All" : tab === "recipes" ? "Recipes" : "Triggers";

  return (
    <MainCard className={className}>
      {/* 48px Header */}
      <header className="flex h-12 min-h-[48px] shrink-0 items-center justify-between border-b border-[#e4e4e7] px-4 select-none dark:border-zinc-800">
        <div className="flex items-center gap-2.5 min-w-0">
          {onToggleSidebar ? (
            <button
              type="button"
              onClick={onToggleSidebar}
              aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!sidebarCollapsed}
              className="flex size-7 items-center justify-center rounded-md text-[#71717a] hover:bg-[#f4f4f5] hover:text-[#0a0a0a] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              <PanelLeft className="size-4" strokeWidth={1.75} aria-hidden="true" />
            </button>
          ) : null}

          <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 min-w-0">
            <ol className="flex items-center gap-1.5 min-w-0">
              <li className="flex items-center gap-1.5 min-w-0">
                <span className="text-[14px] text-[#71717a] dark:text-zinc-400 truncate">{scopeLabel}</span>
              </li>
              <li className="flex items-center gap-1.5 min-w-0">
                <ChevronRight className="size-3.5 text-[#71717a] dark:text-zinc-500 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                <span className="text-[14px] text-[#71717a] dark:text-zinc-400 truncate">Automations</span>
              </li>
              <li className="flex items-center gap-1.5 min-w-0">
                <ChevronRight className="size-3.5 text-[#71717a] dark:text-zinc-500 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                <h1 className="text-[14px] font-medium text-[#0a0a0a] dark:text-zinc-100 truncate" aria-current="page">
                  {tabLabel}
                </h1>
              </li>
            </ol>
            {automations && automations.length > 0 ? (
              <span className="ml-2 rounded-full bg-[#f4f4f5] dark:bg-zinc-800 px-2 py-0.5 text-xs text-[#71717a] dark:text-zinc-400 tabular-nums">
                {automations.length}
              </span>
            ) : null}
          </nav>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <label className="relative flex items-center">
            <Search className="absolute left-2.5 size-3.5 text-[#71717a] dark:text-zinc-400 pointer-events-none" />
            <input
              type="text"
                            aria-label="Search automations"
              placeholder="Search automations…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-8 w-36 sm:w-48 rounded-lg border border-[#e4e4e7] bg-white pl-8 pr-2.5 text-xs text-[#0a0a0a] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
            />
          </label>

          <div
            className="flex items-center gap-0.5 rounded-lg bg-[#f4f4f5] p-0.5 dark:bg-zinc-800"
            role="group"
            aria-label="Automation views"
          >
            {(["automations", "recipes", "triggers"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={tab === value}
                onClick={() => setTab(value)}
                className={
                  "rounded px-2.5 py-1 text-xs capitalize transition-colors " +
                  (tab === value
                    ? "bg-white font-medium text-[#0a0a0a] shadow-[0_1px_2px_rgba(0,0,0,0.06)] dark:bg-zinc-900 dark:text-zinc-100"
                    : "text-[#71717a] hover:text-[#0a0a0a] dark:text-zinc-400 dark:hover:text-zinc-200")
                }
              >
                {value === "automations" ? "All" : value === "recipes" ? "Recipes" : "Triggers"}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => {
              setQuery("");
              setTab("recipes");
            }}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-[#e4e4e7] bg-white px-2.5 text-[13px] font-medium text-[#0a0a0a] transition-colors hover:bg-[#f4f4f5] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
          >
            <Plus className="size-3.5" aria-hidden="true" />
            New automation
          </button>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-4 lg:p-6 min-h-0 text-[#0a0a0a] dark:text-zinc-100">
        <div className="mx-auto flex max-w-5xl flex-col gap-6">
          {notice ? (
            <p
              role="status"
              className="rounded-xl border border-[#e4e4e7] bg-[#f4f4f5] dark:border-zinc-800 dark:bg-zinc-900 px-4 py-3 text-sm text-[#0a0a0a] dark:text-zinc-100"
            >
              {notice}
            </p>
          ) : null}

          {tab === "automations" ? (
            <section aria-label="Deployed automations" className="space-y-6">
              {/* Header Hero Area */}
              <div className="rounded-xl border border-[#e4e4e7] bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900/40 text-center">
                <h2 className="font-serif text-2xl font-normal text-[#0a0a0a] dark:text-zinc-100">
                  What are we automating today?
                </h2>
                <p className="mt-1.5 text-xs text-[#71717a] dark:text-zinc-400 max-w-md mx-auto">
                  Queue recurring tasks from a schedule, GitHub webhook, or Slack alert. All runs require your approval.
                </p>
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                  {STARTER_CHIPS.map((chip) => (
                    <button
                      key={chip.recipeId}
                      type="button"
                      onClick={() => {
                        const rec = RECIPES.find((r) => r.id === chip.recipeId);
                        if (rec) setQuery(rec.name);
                        setTab("recipes");
                      }}
                      className="rounded-full border border-[#e4e4e7] bg-white px-3 py-1 text-xs font-medium text-[#71717a] hover:border-zinc-400 hover:text-[#0a0a0a] transition-colors dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-zinc-100"
                    >
                      {chip.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-[#0a0a0a] dark:text-zinc-100">
                  Your automations
                </h3>
                <button
                  type="button"
                  onClick={refresh}
                  className="h-8 rounded-lg border border-[#e4e4e7] bg-white px-2.5 text-xs font-medium text-[#0a0a0a] hover:bg-[#f4f4f5] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
                >
                  Refresh
                </button>
              </div>

              {loadError !== null ? (
                <LoadErrorState message={loadError} onRetry={refresh} />
              ) : automations === null ? (
                <p role="status" className="py-12 text-center text-sm text-[#71717a] dark:text-zinc-400">
                  Loading automations…
                </p>
              ) : filtered.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-16 text-center text-[#71717a] dark:text-zinc-400 rounded-xl border border-dashed border-[#e4e4e7] dark:border-zinc-800 bg-white dark:bg-zinc-900/20">
                  <Zap aria-hidden="true" className="size-6 text-[#71717a] dark:text-zinc-400" />
                  <p className="text-sm">
                    {query.trim()
                      ? "No automations match your search."
                      : "No automations yet. Start with a recipe."}
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {[true, false].map((enabled) => {
                    const group = filtered.filter((a) => a.enabled === enabled);
                    const key = enabled ? "enabled" : "disabled";
                    if (!group.length) return null;

                    return (
                      <div
                        key={key}
                        className="rounded-xl border border-[#e4e4e7] bg-white dark:border-zinc-800 dark:bg-zinc-900/40 overflow-hidden"
                      >
                        <button
                          type="button"
                          aria-expanded={!collapsed[key]}
                          aria-controls={`automation-group-${key}`}
                          onClick={() =>
                            setCollapsed((current) => ({ ...current, [key]: !current[key] }))
                          }
                          className="flex min-h-11 w-full items-center justify-between px-4 text-left text-xs font-semibold text-[#0a0a0a] dark:text-zinc-100 hover:bg-[#f4f4f5] dark:hover:bg-zinc-800/50 transition-colors"
                        >
                          <div className="flex items-center gap-2">
                            {collapsed[key] ? (
                              <ChevronRight aria-hidden="true" className="size-3.5 text-[#71717a]" />
                            ) : (
                              <ChevronDown aria-hidden="true" className="size-3.5 text-[#71717a]" />
                            )}
                            <span>{enabled ? "Enabled" : "Disabled"}</span>
                            <span className="rounded-full bg-[#f4f4f5] dark:bg-zinc-800 px-2 py-0.5 text-[11px] text-[#71717a] dark:text-zinc-400 font-mono">
                              {group.length}
                            </span>
                          </div>
                        </button>

                        <div id={`automation-group-${key}`} hidden={collapsed[key]}>
                          <div className="divide-y divide-[#e4e4e7] border-t border-[#e4e4e7] dark:divide-zinc-800 dark:border-zinc-800">
                            {group.map((a) => (
                              <div
                                key={a.id}
                                className="flex flex-wrap sm:flex-nowrap items-center gap-3 py-3 px-4 hover:bg-[#f4f4f5] dark:hover:bg-zinc-800/40 transition-colors"
                              >
                                <Zap
                                  aria-hidden="true"
                                  className="size-4 shrink-0 text-[#71717a] dark:text-zinc-400"
                                />
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm font-medium text-[#0a0a0a] dark:text-zinc-100 truncate">
                                    {RECIPES.find((recipe) => recipe.id === a.id)?.name ?? a.id}
                                  </p>
                                  <p className="text-xs text-[#71717a] dark:text-zinc-400 break-all">
                                    {a.repoUrl}
                                    {a.customAgentId ? ` · Bot: ${a.customAgentId}` : ""}
                                    {a.lastSkip ? ` · Last skip: ${a.lastSkip.reason}` : ""}
                                  </p>
                                </div>
                                <span className="text-xs text-[#71717a] dark:text-zinc-400">
                                  {a.triggers.map((t) => t.kind).join(" + ")} · {a.runCount ?? 0} runs
                                </span>
                                <button
                                  type="button"
                                  aria-label={`${a.enabled ? "Disable" : "Enable"} ${a.id}`}
                                  disabled={busyId !== null}
                                  onClick={() => void setAutomationEnabled(a.id, !a.enabled)}
                                  className="h-8 rounded-lg border border-[#e4e4e7] bg-white px-2.5 text-xs font-medium text-[#0a0a0a] hover:bg-[#f4f4f5] disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
                                >
                                  {busyId === `toggle-${a.id}`
                                    ? "Updating…"
                                    : a.enabled
                                    ? "Disable"
                                    : "Enable"}
                                </button>
                                {a.triggers.some((t) => t.kind === "manual") ? (
                                  <button
                                    type="button"
                                    disabled={busyId !== null}
                                    onClick={() => void triggerNow(a.id)}
                                    className="h-8 rounded-lg border border-[#e4e4e7] bg-white px-2.5 text-xs font-medium text-[#0a0a0a] hover:bg-[#f4f4f5] disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
                                  >
                                    {busyId === `run-${a.id}` ? "Queuing…" : "Run now"}
                                  </button>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          ) : tab === "recipes" ? (
            <section aria-label="Automation recipes" className="space-y-6">
              <div className="rounded-xl border border-[#e4e4e7] bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900/40">
                <h3 className="text-base font-semibold text-[#0a0a0a] dark:text-zinc-100">
                  Start with a recipe
                </h3>
                <p className="mt-1 text-xs text-[#71717a] dark:text-zinc-400">
                  Choose a repository and an optional bot to handle the workload.
                </p>

                <div className="mt-4 flex flex-wrap gap-3">
                  <input
                    type="url"
                                        aria-label="Repository URL"
                    value={repoUrl}
                    onChange={(e) => setRepoUrl(e.target.value)}
                    placeholder="https://github.com/owner/repo"
                    className="h-9 min-w-0 flex-1 basis-64 rounded-lg border border-[#e4e4e7] bg-white px-3 text-xs text-[#0a0a0a] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
                  />
                  <select
                    aria-label="Bot for new automations"
                    value={customAgentId}
                    onChange={(e) => setCustomAgentId(e.target.value)}
                    className="h-9 rounded-lg border border-[#e4e4e7] bg-white px-3 text-xs text-[#0a0a0a] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 max-w-full"
                  >
                    <option value="">No bot</option>
                    {customAgents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.config.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {loadError ? <LoadErrorState message={loadError} onRetry={refresh} /> : null}

              <div className="rounded-xl border border-[#e4e4e7] bg-white dark:border-zinc-800 dark:bg-zinc-900/40 overflow-hidden divide-y divide-[#e4e4e7] dark:divide-zinc-800">
                {recipes.map((recipe) => {
                  const deployed = automations?.some((a) => a.id === recipe.id) ?? false;
                  return (
                    <div
                      key={recipe.id}
                      className="flex flex-wrap sm:flex-nowrap items-center gap-3 p-4 hover:bg-[#f4f4f5] dark:hover:bg-zinc-800/40 transition-colors"
                    >
                      <Zap aria-hidden="true" className="size-4 shrink-0 text-[#71717a]" />
                      <div className="flex-1 min-w-0">
                        <h4 className="text-sm font-medium text-[#0a0a0a] dark:text-zinc-100">
                          {recipe.name}
                        </h4>
                        <p className="mt-0.5 text-xs text-[#71717a] dark:text-zinc-400">
                          {recipe.description}
                        </p>
                      </div>
                      <span className="text-xs text-[#71717a] dark:text-zinc-400 whitespace-nowrap">
                        {recipe.cadence}
                      </span>
                      <button
                        type="button"
                        disabled={
                          busyId !== null || deployed || automations === null || loadError !== null
                        }
                        onClick={() => void deployRecipe(recipe)}
                        className="h-8 rounded-lg border border-[#e4e4e7] bg-white px-3 text-xs font-medium text-[#0a0a0a] hover:bg-[#f4f4f5] disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
                      >
                        {busyId === recipe.id ? "Creating…" : deployed ? "Created" : "Use recipe"}
                      </button>
                    </div>
                  );
                })}
              </div>

              {recipes.length === 0 ? (
                <p className="py-10 text-center text-sm text-[#71717a] dark:text-zinc-400">
                  No recipes match your search.
                </p>
              ) : null}
            </section>
          ) : (
            <section aria-label="Inbound triggers" className="space-y-6">
              <div>
                <h3 className="text-base font-semibold text-[#0a0a0a] dark:text-zinc-100">
                  Inbound triggers
                </h3>
                <p className="mt-1 text-xs text-[#71717a] dark:text-zinc-400">
                  Connect repository webhooks and Slack messages to trigger automated runs.
                </p>
              </div>

              {[
                {
                  name: "GitHub webhooks",
                  description:
                    "Receive repository events. Configure GITHUB_WEBHOOK_SECRET for HMAC-SHA256 signature verification.",
                  endpoints: [["Webhook", "/api/github/webhook"]],
                },
                {
                  name: "Slack",
                  description: "Mention @shiba or use /shiba. Review approval requests in Slack.",
                  endpoints: [
                    ["Commands", "/api/slack/command"],
                    ["Events", "/api/slack/events"],
                    ["Interactivity", "/api/slack/interact"],
                  ],
                },
              ]
                .filter((item) =>
                  matches(`${item.name} ${item.description} ${item.endpoints.flat().join(" ")}`),
                )
                .map((item) => (
                  <div
                    key={item.name}
                    className="rounded-xl border border-[#e4e4e7] bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900/40 space-y-4"
                  >
                    <div>
                      <h4 className="text-sm font-semibold text-[#0a0a0a] dark:text-zinc-100">
                        {item.name}
                      </h4>
                      <p className="text-xs leading-relaxed text-[#71717a] dark:text-zinc-400 mt-0.5">
                        {item.description}
                      </p>
                    </div>

                    <div className="divide-y divide-[#e4e4e7] border-t border-[#e4e4e7] dark:divide-zinc-800 dark:border-zinc-800 pt-2">
                      {item.endpoints.map(([label, endpoint]) => (
                        <div
                          key={endpoint}
                          className="flex flex-wrap items-center justify-between gap-2 py-2.5"
                        >
                          <div className="min-w-0 text-xs">
                            <span className="text-[#71717a] dark:text-zinc-400 font-medium">
                              {label}
                            </span>
                            <code className="block break-all mt-0.5 font-mono text-[11px] text-[#0a0a0a] dark:text-zinc-200">
                              {endpoint}
                            </code>
                          </div>
                          <button
                            type="button"
                            aria-label={`Copy ${label?.toLowerCase()} endpoint`}
                            onClick={() => void copyToClipboard(endpoint!, endpoint!)}
                            className="h-7 rounded-md border border-[#e4e4e7] bg-white px-2.5 text-xs font-medium text-[#0a0a0a] hover:bg-[#f4f4f5] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
                          >
                            {copiedEndpoint === endpoint ? "Copied" : "Copy"}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
            </section>
          )}
        </div>
      </div>
    </MainCard>
  );
}
