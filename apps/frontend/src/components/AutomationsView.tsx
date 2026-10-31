import { useCallback, useEffect, useState, type JSX } from "react";
import { ChevronDown, ChevronRight, Plus, Search, Zap } from "lucide-react";
import { LoadErrorState } from "./LoadErrorState";
import { useCustomAgentOptions } from "./CustomAgentsView";

interface AutomationRecord {
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

const RECIPES = [
  {
    id: "pr-review", name: "Review opened pull requests", cadence: "GitHub event",
    description: "Check pull requests for bugs, regressions, and missing tests.",
    prompt: "Review the latest opened pull request in this repository. Check for correctness bugs, missing tests, and regressions. Fix any blocking issues you find and open a PR with the fixes.",
    triggers: [{ kind: "github", events: ["pull_request:opened"] }],
  },
  {
    id: "nightly-lint", name: "Nightly lint fixes", cadence: "0 3 * * *",
    description: "Fix lint violations each night and open a pull request.",
    prompt: "Run the repository's linter. Fix every violation it reports — formatting, unused imports, dead code. Open a PR with the clean tree.",
    triggers: [{ kind: "schedule", cron: "0 3 * * *" }],
  },
  {
    id: "weekly-deps", name: "Weekly dependency and secret scan", cadence: "0 9 * * 1",
    description: "Check for vulnerable dependencies and committed secrets.",
    prompt: "Audit dependencies for known vulnerabilities and committed secrets. Apply safe patch/minor bumps and remove any leaked credentials. Open a PR with the results.",
    triggers: [{ kind: "schedule", cron: "0 9 * * 1" }],
  },
  {
    id: "docs-sync", name: "Update documentation", cadence: "0 4 * * 6",
    description: "Update documentation to reflect the week's code changes.",
    prompt: "Compare the docs (README, JSDoc, API references) against the code changed in the last week. Update stale sections and open a PR.",
    triggers: [{ kind: "schedule", cron: "0 4 * * 6" }],
  },
  {
    id: "oncall-triage", name: "Slack incident triage", cadence: "Slack event",
    description: "Investigate incident reports from Slack, grouped by burst.",
    prompt: "An incident was reported in Slack. Investigate the repository for the likely cause, write a fix or mitigation, and open a PR. Include a root-cause note in the PR description.",
    triggers: [{ kind: "slack", textContains: ["incident", "error", "down"], burstWindowSeconds: 60 }],
  },
  {
    id: "manual-audit", name: "Repository audit", cadence: "Manual",
    description: "Queue an audit for approval when you need one.",
    prompt: "Audit this repository end to end: dead code, missing error handling, unsafe patterns, and inconsistent interfaces. Open a PR with the highest-impact fixes.",
    triggers: [{ kind: "manual" }],
  },
];

const controlClass = "min-h-11 inline-flex items-center justify-center gap-2 rounded-[10px] border border-[var(--border-1)] bg-[var(--secondary)] px-3 text-xs font-medium text-[var(--fg)] hover:bg-[var(--secondary-hover)] disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]";
const inputClass = "min-h-11 min-w-0 rounded-[10px] border border-[var(--border-1)] bg-[var(--card)] px-3 text-sm text-[var(--fg)] placeholder:text-[var(--muted-foreground-1)] focus:outline focus:outline-2 focus:outline-[var(--ring)]";

export function AutomationsView(): JSX.Element {
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

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedEndpoint(label);
    } catch {
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
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: recipe.id, prompt: recipe.prompt, repoUrl: repoUrl.trim(), triggers: recipe.triggers, enabled: true, ...(customAgentId ? { customAgentId } : {}) }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) setNotice(body.error ?? `Could not create automation (${response.status}).`);
      else {
        setNotice(`Created "${recipe.name}".`);
        refresh();
      }
    } catch {
      setNotice("Could not create automation: the backend could not be reached.");
    } finally { setBusyId(null); }
  };

  const triggerNow = async (id: string) => {
    setBusyId(`run-${id}`);
    setNotice(null);
    try {
      const response = await fetch(`/api/automations/${encodeURIComponent(id)}/run`, { method: "POST" });
      const body = (await response.json().catch(() => ({}))) as { error?: string; fired?: number; skipped?: number };
      if (!response.ok) setNotice(body.error ?? `Could not queue run (${response.status}).`);
      else {
        setNotice(body.fired ? `Approval queued for "${id}".` : `Skipped "${id}". Check its last skip reason.`);
        refresh();
      }
    } catch { setNotice("Could not queue run: the backend could not be reached."); }
    finally { setBusyId(null); }
  };

  const matches = (value: string) => value.toLowerCase().includes(query.trim().toLowerCase());
  const filtered = automations?.filter((a) => matches(`${a.id} ${a.repoUrl} ${a.prompt} ${a.triggers.map((t) => t.kind).join(" ")}`)) ?? [];
  const recipes = RECIPES.filter((recipe) => matches(`${recipe.name} ${recipe.description} ${recipe.cadence}`));

  return (
    <div className="flex-1 flex flex-col h-full min-w-0 overflow-y-auto bg-[var(--bg)] text-[var(--fg)]">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-1)] px-4 sm:px-6 py-3">
        <h2 className="flex items-center gap-2 text-sm font-medium"><span className="text-[var(--muted-foreground-1)]">Workspace</span><ChevronRight aria-hidden="true" className="size-3.5 text-[var(--icon-muted)]" />Automations</h2>
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative flex items-center">
            <Search aria-hidden="true" className="absolute left-3 size-3.5 text-[var(--icon-muted)]" />
            <input aria-label="Search automations" placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} className={`${inputClass} pl-9 w-40`} />
          </label>
          <div className="flex items-center rounded-[10px] border border-[var(--border-1)] p-0.5" role="group" aria-label="Automation views">
            {(["automations", "recipes", "triggers"] as const).map((value) => <button key={value} type="button" aria-pressed={tab === value} onClick={() => setTab(value)} className={`min-h-11 rounded-lg px-3 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)] ${tab === value ? "bg-[var(--secondary)] text-[var(--fg)]" : "text-[var(--muted-foreground-1)] hover:bg-[var(--secondary)]"}`}>{value === "automations" ? "All" : value === "recipes" ? "Recipes" : "Triggers"}</button>)}
          </div>
          <button type="button" onClick={() => { setQuery(""); setTab("recipes"); }} className={controlClass}><Plus aria-hidden="true" className="size-3.5" />New automation</button>
        </div>
      </header>
      <div className="w-full max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        <p className="text-sm text-[var(--muted-foreground-1)]">Queue tasks from a schedule, GitHub, or Slack. Runs still need your approval.</p>
        {notice ? <p role="status" className="rounded-[10px] border border-[var(--border-1)] bg-[var(--secondary)] px-3 py-3 text-sm">{notice}</p> : null}
        {tab === "automations" ? (
          <section aria-label="Deployed automations">
            <div className="flex items-center justify-between gap-3 mb-3"><h3 className="text-sm font-medium">Your automations</h3><button type="button" onClick={refresh} className={controlClass}>Refresh</button></div>
            {loadError !== null ? <LoadErrorState message={loadError} onRetry={refresh} /> : automations === null ? <p role="status" className="py-12 text-center text-sm text-[var(--muted-foreground-1)]">Loading automations…</p> : filtered.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-16 text-[var(--muted-foreground-1)]"><Zap aria-hidden="true" className="size-6 text-[var(--icon-muted)]" /><p className="text-sm">{query.trim() ? "No automations match your search." : "No automations yet. Start with a recipe."}</p></div>
            ) : [true, false].map((enabled) => {
              const group = filtered.filter((a) => a.enabled === enabled);
              const key = enabled ? "enabled" : "disabled";
              return group.length ? <div key={key} className="border-b border-[var(--border-1)]">
                <button type="button" aria-expanded={!collapsed[key]} aria-controls={`automation-group-${key}`} onClick={() => setCollapsed((current) => ({ ...current, [key]: !current[key] }))} className="flex items-center gap-2 min-h-11 w-full text-left text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]">
                  {collapsed[key] ? <ChevronRight aria-hidden="true" className="size-3.5" /> : <ChevronDown aria-hidden="true" className="size-3.5" />}{enabled ? "Enabled" : "Disabled"}<span className="text-[var(--muted-foreground-1)]">{group.length}</span>
                </button>
                <div id={`automation-group-${key}`} hidden={collapsed[key]}>
                  {group.map((a) => <div key={a.id} className="min-h-11 flex flex-wrap sm:flex-nowrap items-center gap-3 border-t border-[var(--border-1)] py-2 px-2 hover:bg-[var(--secondary)]">
                    <Zap aria-hidden="true" className="size-3.5 shrink-0 text-[var(--icon-muted)]" />
                    <div className="min-w-0 flex-1"><p className="text-sm truncate">{RECIPES.find((recipe) => recipe.id === a.id)?.name ?? a.id}</p><p className="text-xs text-[var(--muted-foreground-1)] break-all">{a.repoUrl}{a.customAgentId ? ` · Bot: ${a.customAgentId}` : ""}{a.lastSkip ? ` · Last skip: ${a.lastSkip.reason}` : ""}</p></div>
                    <span className="text-xs text-[var(--muted-foreground-1)]">{a.triggers.map((t) => t.kind).join(" + ")} · {a.runCount ?? 0} runs</span>
                    {a.triggers.some((t) => t.kind === "manual") ? <button type="button" disabled={busyId !== null} onClick={() => void triggerNow(a.id)} className={controlClass}>{busyId === `run-${a.id}` ? "Queuing…" : "Run now"}</button> : null}
                  </div>)}
                </div>
              </div> : null;
            })}
          </section>
        ) : tab === "recipes" ? (
          <section aria-label="Automation recipes" className="space-y-5">
            <div><h3 className="text-sm font-medium">Start with a recipe</h3><p className="mt-1 text-xs text-[var(--muted-foreground-1)]">Choose a repository and an optional bot.</p></div>
            <div className="flex flex-wrap gap-2"><input type="url" aria-label="Repository URL" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/owner/repo" className={`${inputClass} flex-1 basis-64`} /><select aria-label="Bot for new automations" value={customAgentId} onChange={(e) => setCustomAgentId(e.target.value)} className={`${inputClass} max-w-full`}><option value="">No bot</option>{customAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.config.name}</option>)}</select></div>
            {loadError ? <LoadErrorState message={loadError} onRetry={refresh} /> : null}
            <div className="divide-y divide-[var(--border-1)] border-y border-[var(--border-1)]">
              {recipes.map((recipe) => {
                const deployed = automations?.some((a) => a.id === recipe.id) ?? false;
                return <div key={recipe.id} className="flex flex-wrap sm:flex-nowrap items-center gap-3 py-3">
                  <Zap aria-hidden="true" className="size-4 shrink-0 text-[var(--icon-muted)]" /><div className="flex-1 min-w-0"><h4 className="text-sm font-medium">{recipe.name}</h4><p className="mt-1 text-xs text-[var(--muted-foreground-1)]">{recipe.description}</p></div><span className="text-xs text-[var(--muted-foreground-1)] whitespace-nowrap">{recipe.cadence}</span>
                  <button type="button" disabled={busyId !== null || deployed || automations === null || loadError !== null} onClick={() => void deployRecipe(recipe)} className={controlClass}>{busyId === recipe.id ? "Creating…" : deployed ? "Created" : "Use recipe"}</button>
                </div>;
              })}
            </div>
            {recipes.length === 0 ? <p className="py-10 text-center text-sm text-[var(--muted-foreground-1)]">No recipes match your search.</p> : null}
          </section>
        ) : (
          <section aria-label="Inbound triggers" className="space-y-6">
            <div><h3 className="text-sm font-medium">Inbound triggers</h3><p className="mt-1 text-xs text-[var(--muted-foreground-1)]">Connect repository events and Slack messages to Shiba.</p></div>
            {[
              { name: "GitHub webhooks", description: "Receive repository events. Configure GITHUB_WEBHOOK_SECRET for HMAC-SHA256 signature verification.", endpoints: [["Webhook", "/api/github/webhook"]] },
              { name: "Slack", description: "Mention @shiba or use /shiba. Review approval requests in Slack.", endpoints: [["Commands", "/api/slack/command"], ["Events", "/api/slack/events"], ["Interactivity", "/api/slack/interact"]] },
            ].filter((item) => matches(`${item.name} ${item.description} ${item.endpoints.flat().join(" ")}`)).map((item) => <div key={item.name} className="rounded-xl border border-[var(--border-1)] p-4 space-y-3"><h4 className="text-sm font-medium">{item.name}</h4><p className="text-xs leading-relaxed text-[var(--muted-foreground-1)]">{item.description}</p>{item.endpoints.map(([label, endpoint]) => <div key={endpoint} className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-1)] pt-2"><div className="min-w-0 text-xs"><span className="text-[var(--muted-foreground-1)]">{label}</span><code className="block break-all mt-1">{endpoint}</code></div><button type="button" aria-label={`Copy ${label?.toLowerCase()} endpoint`} onClick={() => void copyToClipboard(endpoint!, endpoint!)} className={controlClass}>{copiedEndpoint === endpoint ? "Copied" : "Copy"}</button></div>)}</div>)}
            <p className="text-xs text-[var(--muted-foreground-1)]">Schedules and incoming events queue tasks for approval before a sandbox starts.</p>
          </section>
        )}
      </div>
    </div>
  );
}
