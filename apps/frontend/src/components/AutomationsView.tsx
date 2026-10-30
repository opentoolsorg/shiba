import { useCallback, useEffect, useState, type JSX } from "react";
import { expectedDeliverablesSchema } from "@shiba/shared";
import { LoadErrorState } from "./LoadErrorState";
import { useCustomAgentOptions } from "./CustomAgentsView";
import { useSavedSkills, type SavedSkill } from "../saved";

interface AutomationRecord {
  id: string;
  prompt: string;
  repoUrl: string;
  executionTarget?: { kind: string; workspaceName?: string; expectedDeliverables?: string[] };
  enabled: boolean;
  runCount?: number;
  lastTriggeredAt?: number;
  lastSkip?: { at: number; reason: string };
  triggers: { kind: string; cron?: string; timezone?: string }[];
  customAgentId?: string;
  customAgentPin?: { version: number };
  skillPins?: { id: string; version: string; source: string; instructions: string; sha256: string; enabled: boolean }[];
  occurrences?: { id: string; scheduledAt: number; outcome: string; approvalId?: string; runId?: string }[];
}

async function pinSkill(skill: SavedSkill) {
  const instructions = [`Skill: ${skill.name}`, ...(skill.notes?.trim() ? [skill.notes.trim()] : [])].join("\n");
  const source = skill.repoUrl?.trim() || "Saved skills library";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(instructions));
  const contentVersion = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
  const version = contentVersion;
  const pinDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([skill.id, version, source, instructions])));
  const sha256 = [...new Uint8Array(pinDigest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { id: skill.id, version, source, instructions, sha256, enabled: true };
}

/** Factory-style recipe gallery: each card is one automation ready to deploy. */
const RECIPES: {
  id: string;
  name: string;
  description: string;
  cadence: string;
  prompt: string;
  triggers: Record<string, unknown>[];
}[] = [
  {
    id: "pr-review",
    name: "PR Review on Open",
    description: "Exhaustive review on every pull request — correctness, regressions, and test gaps, posted as a PR.",
    cadence: "GitHub event",
    prompt:
      "Review the latest opened pull request in this repository. Check for correctness bugs, missing tests, and regressions. Fix any blocking issues you find and open a PR with the fixes.",
    triggers: [{ kind: "github", events: ["pull_request:opened"] }],
  },
  {
    id: "nightly-lint",
    name: "Nightly Lint Autofix",
    description: "Fix lint violations across the codebase every night and open a PR with the results.",
    cadence: "0 3 * * *",
    prompt:
      "Run the repository's linter. Fix every violation it reports — formatting, unused imports, dead code. Open a PR with the clean tree.",
    triggers: [{ kind: "schedule", cron: "0 3 * * *" }],
  },
  {
    id: "weekly-deps",
    name: "Weekly Dependency + Secret Sweep",
    description: "Audit dependencies for CVEs, scan for committed secrets, and bump what's safe — one PR per week.",
    cadence: "0 9 * * 1",
    prompt:
      "Audit dependencies for known vulnerabilities and committed secrets. Apply safe patch/minor bumps and remove any leaked credentials. Open a PR with the results.",
    triggers: [{ kind: "schedule", cron: "0 9 * * 1" }],
  },
  {
    id: "docs-sync",
    name: "Docs Sync",
    description: "Keep READMEs, JSDoc, and API references in sync with the code that shipped this week.",
    cadence: "0 4 * * 6",
    prompt:
      "Compare the docs (README, JSDoc, API references) against the code changed in the last week. Update stale sections and open a PR.",
    triggers: [{ kind: "schedule", cron: "0 4 * * 6" }],
  },
  {
    id: "oncall-triage",
    name: "On-Call Slack Triage",
    description: "Slack messages mentioning 'incident' or 'error' trigger a triage run — one run per burst.",
    cadence: "Slack event",
    prompt:
      "An incident was reported in Slack. Investigate the repository for the likely cause, write a fix or mitigation, and open a PR. Include a root-cause note in the PR description.",
    triggers: [{ kind: "slack", textContains: ["incident", "error", "down"], burstWindowSeconds: 60 }],
  },
  {
    id: "manual-audit",
    name: "Manual Deep Audit",
    description: "A full-repo audit you fire by hand from this page — the /run endpoint queues it for approval.",
    cadence: "Manual",
    prompt:
      "Audit this repository end to end: dead code, missing error handling, unsafe patterns, and inconsistent interfaces. Open a PR with the highest-impact fixes.",
    triggers: [{ kind: "manual" }],
  },
];

export function AutomationsView(): JSX.Element {
  const [copiedEndpoint, setCopiedEndpoint] = useState<string | null>(null);
  const [automations, setAutomations] = useState<AutomationRecord[] | null>(null);
  const [repoUrl, setRepoUrl] = useState("");
  const [workspaceName, setWorkspaceName] = useState("My workspace");
  const [workspacePrompt, setWorkspacePrompt] = useState("");
  const [workspaceCron, setWorkspaceCron] = useState("0 9 * * 1-5");
  const [workspaceTimezone, setWorkspaceTimezone] = useState(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
  });
  const [workspaceDeliverables, setWorkspaceDeliverables] = useState("deliverables/brief.md");
  const [customAgentId, setCustomAgentId] = useState("");
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const { agents: customAgents } = useCustomAgentOptions();
  const savedSkills = useSavedSkills();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const copyToClipboard = (text: string, label: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedEndpoint(label);
    setTimeout(() => setCopiedEndpoint(null), 2000);
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
      setNotice("Enter a GitHub repo URL for the recipe target first.");
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
      if (!response.ok) {
        setNotice(body.error ?? `Deploy failed (${response.status}).`);
      } else {
        setNotice(`Deployed "${recipe.name}".`);
        refresh();
      }
    } catch {
      setNotice("Deploy failed: the backend could not be reached.");
    } finally {
      setBusyId(null);
    }
  };

  const triggerNow = async (id: string) => {
    setBusyId(`run-${id}`);
    setNotice(null);
    try {
      const response = await fetch(`/api/automations/${encodeURIComponent(id)}/run`, { method: "POST" });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        fired?: number;
        skipped?: number;
      };
      if (!response.ok) {
        setNotice(body.error ?? `Trigger failed (${response.status}).`);
      } else {
        setNotice(body.fired ? `Fired "${id}" — approval queued.` : `Skipped "${id}" — see lastSkip.`);
        refresh();
      }
    } catch {
      setNotice("Trigger failed: the backend could not be reached.");
    } finally {
      setBusyId(null);
    }
  };

  const createWorkspaceSchedule = async () => {
    const prompt = workspacePrompt.trim();
    const expectedDeliverables = expectedDeliverablesSchema.min(1).safeParse(
      workspaceDeliverables.split(/\r?\n/).map((path) => path.trim()).filter(Boolean),
    );
    if (!prompt) {
      setNotice("Describe what the scheduled task should prepare.");
      return;
    }
    if (!expectedDeliverables.success) {
      setNotice("Use 1–8 safe relative .md, .txt, .json, or .csv output paths.");
      return;
    }
    setBusyId("create-workspace-schedule");
    setNotice(null);
    try {
      const response = await fetch("/api/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          executionTarget: {
            kind: "artifact-workspace",
            workspaceName: workspaceName.trim() || "My workspace",
            expectedDeliverables: expectedDeliverables.data,
          },
          triggers: [{ kind: "schedule", cron: workspaceCron.trim(), timezone: workspaceTimezone.trim() }],
          enabled: true,
          ...(customAgentId ? { customAgentId } : {}),
          ...(selectedSkillIds.length ? { skillPins: await Promise.all(savedSkills.filter((skill) => selectedSkillIds.includes(skill.id)).map(pinSkill)) } : {}),
        }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string; automation?: { id?: string } };
      if (!response.ok) {
        setNotice(body.error ?? `Schedule could not be created (${response.status}).`);
      } else {
        setNotice(`Scheduled workspace draft created${body.automation?.id ? ` (${body.automation.id})` : ""}. Each run waits for approval.`);
        setWorkspacePrompt("");
        refresh();
      }
    } catch {
      setNotice("Schedule could not be created: the backend could not be reached.");
    } finally {
      setBusyId(null);
    }
  };

  const reviewAutomationPins = async (automation: AutomationRecord) => {
    setBusyId(`review-${automation.id}`);
    setNotice(null);
    try {
      const pins = await Promise.all((automation.skillPins ?? []).map(async (oldPin) => {
        const skill = savedSkills.find((item) => item.id === oldPin.id);
        return skill ? pinSkill(skill) : { ...oldPin, enabled: false };
      }));
      const response = await fetch(`/api/automations/${encodeURIComponent(automation.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(automation.customAgentId ? { customAgentId: automation.customAgentId, reviewCustomAgent: true } : {}),
          ...(automation.skillPins ? { skillPins: pins, reviewSkillPins: true } : {}),
        }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) setNotice(body.error ?? `Pin review failed (${response.status}).`);
      else { setNotice(`Reviewed the current employee and skill snapshots for "${automation.id}".`); refresh(); }
    } catch {
      setNotice("Pin review failed: the backend could not be reached.");
    } finally {
      setBusyId(null);
    }
  };

  const setAutomationEnabled = async (automation: AutomationRecord) => {
    setBusyId(`toggle-${automation.id}`);
    setNotice(null);
    try {
      const response = await fetch(`/api/automations/${encodeURIComponent(automation.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !automation.enabled }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) setNotice(body.error ?? `Automation update failed (${response.status}).`);
      else {
        setNotice(automation.enabled ? `Paused "${automation.id}".` : `Resumed "${automation.id}".`);
        refresh();
      }
    } catch {
      setNotice("Automation update failed: the backend could not be reached.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-y-auto bg-[var(--bg)] text-[var(--fg)] p-4 lg:p-8">
      <div className="max-w-5xl mx-auto w-full flex flex-col gap-6">
        {/* Header */}
        <div className="border-b border-[var(--border-1)] pb-4">
          <h2 className="text-base font-semibold text-[var(--fg)] flex items-center gap-2">
            <span>Automations & Inbound Triggers</span>
            <span className="text-xs font-mono px-2 py-0.5 rounded-[var(--radius-button)] bg-[var(--primary-soft)] border border-[var(--primary)]/30 text-[var(--primary)]">
              Autonomous
            </span>
          </h2>
          <p className="text-xs text-[var(--muted-foreground-2)]">
            Shiba triggers tasks automatically from GitHub webhooks, Slack channels, and scheduled cron ticks.
          </p>
        </div>

        {notice ? (
          <div className="text-xs font-mono text-[var(--warning-fg)] bg-[color-mix(in_oklch,var(--warning-fg)_10%,transparent)] border border-[color-mix(in_oklch,var(--warning-fg)_30%,transparent)] rounded-[var(--radius-button)] px-3 py-2">
            {notice}
          </div>
        ) : null}

        <section aria-labelledby="workspace-schedule-heading" className="border border-[var(--border-1)] rounded-[var(--radius-button)] bg-[var(--panel)] shadow-[var(--sh-card)] p-5 flex flex-col gap-3">
          <div>
            <h3 id="workspace-schedule-heading" className="text-sm font-semibold text-[var(--fg)]">Scheduled workspace drafts</h3>
            <p className="text-xs text-[var(--muted-foreground-2)] mt-1">
              Create requested files on a schedule without a GitHub repository. Each run consumes the automation's daily run budget and waits for human approval. Connected-app actions are unavailable.
            </p>
          </div>
          <label className="flex flex-col gap-1 text-[11px] text-[var(--muted-foreground-1)]">
            Workspace name
            <input aria-label="Workspace name" maxLength={100} value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} className="bg-[var(--card)] text-xs text-[var(--fg)] border border-[var(--border-1)] rounded-[var(--radius-button)] px-3 py-2" />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-[var(--muted-foreground-1)]">
            Task prompt
            <textarea aria-label="Scheduled workspace prompt" rows={3} value={workspacePrompt} onChange={(event) => setWorkspacePrompt(event.target.value)} placeholder="Prepare a weekly status brief from the approved workspace context…" className="bg-[var(--card)] text-xs text-[var(--fg)] border border-[var(--border-1)] rounded-[var(--radius-button)] px-3 py-2" />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-[var(--muted-foreground-1)]">
            Required output files (one safe relative path per line)
            <textarea aria-label="Scheduled workspace deliverables" rows={2} value={workspaceDeliverables} onChange={(event) => setWorkspaceDeliverables(event.target.value)} className="bg-[var(--card)] text-xs font-mono text-[var(--fg)] border border-[var(--border-1)] rounded-[var(--radius-button)] px-3 py-2" />
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-[11px] text-[var(--muted-foreground-1)]">
              Five-field cron (minimum 5-minute interval)
              <input aria-label="Workspace schedule cron" value={workspaceCron} onChange={(event) => setWorkspaceCron(event.target.value)} className="bg-[var(--card)] text-xs font-mono text-[var(--fg)] border border-[var(--border-1)] rounded-[var(--radius-button)] px-3 py-2" />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--muted-foreground-1)]">
              IANA timezone
              <input aria-label="Workspace schedule timezone" value={workspaceTimezone} onChange={(event) => setWorkspaceTimezone(event.target.value)} placeholder="America/Los_Angeles" className="bg-[var(--card)] text-xs font-mono text-[var(--fg)] border border-[var(--border-1)] rounded-[var(--radius-button)] px-3 py-2" />
            </label>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <select aria-label="Bot for scheduled workspace drafts" value={customAgentId} onChange={(event) => setCustomAgentId(event.target.value)} className="bg-[var(--card)] text-xs border border-[var(--border-1)] rounded-[var(--radius-button)] px-2 py-1.5 max-w-[260px]">
              <option value="">No bot</option>
              {customAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.config.name}</option>)}
            </select>
            {savedSkills.length ? (
              <fieldset className="flex flex-wrap gap-2 text-[10px] text-[var(--muted-foreground-1)]">
                <legend className="sr-only">Reviewed skill snapshots for scheduled drafts</legend>
                {savedSkills.map((skill) => (
                  <label key={skill.id} className="flex items-center gap-1">
                    <input type="checkbox" checked={selectedSkillIds.includes(skill.id)} onChange={(event) => setSelectedSkillIds((current) => event.target.checked ? [...current, skill.id] : current.filter((id) => id !== skill.id))} />
                    Pin {skill.name}
                  </label>
                ))}
              </fieldset>
            ) : null}
            <button type="button" disabled={busyId === "create-workspace-schedule"} onClick={() => void createWorkspaceSchedule()} className="text-xs font-semibold border border-[var(--primary)]/40 text-[var(--primary)] bg-[var(--primary-soft)] rounded-[var(--radius-button)] px-3 py-2 disabled:opacity-50">
              {busyId === "create-workspace-schedule" ? "Scheduling…" : "Create scheduled draft"}
            </button>
          </div>
        </section>

        {/* Recipe Gallery — deploy a standing agent in one click */}
        <div className="border border-[var(--border-1)] rounded-[var(--radius-button)] bg-[var(--panel)] shadow-[var(--sh-card)] p-5 flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-[var(--fg)]">Recipe Gallery</h3>
              <p className="text-xs text-[var(--muted-foreground-2)] mt-0.5">
                Each recipe starts a task on a trigger. Choose a repository and an optional bot.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                aria-label="Repository URL"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/owner/repo"
                className="bg-[var(--card)] text-xs font-mono text-[var(--fg)] border border-[var(--border-1)] rounded-[var(--radius-button)] px-3 py-1.5 w-72 transition-colors focus:outline-none focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--ring)] placeholder:text-[var(--muted-foreground-3)]"
              />
              <select
                aria-label="Bot for new automations"
                value={customAgentId}
                onChange={(e) => setCustomAgentId(e.target.value)}
                className="bg-[var(--card)] text-xs border border-[var(--border-1)] rounded-[var(--radius-button)] px-2 py-1.5 max-w-[200px]"
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
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {RECIPES.map((recipe) => {
              const deployed = automations?.some((a) => a.id === recipe.id) ?? false;
              return (
                <div
                  key={recipe.id}
                  className="bg-[var(--card)] p-4 rounded-[var(--radius-button)] border border-[var(--border-1)] hover:border-[var(--border-2)] flex flex-col gap-2 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-[var(--fg)]">{recipe.name}</span>
                    <span className="text-[10px] font-mono text-[var(--primary)] bg-[var(--primary-soft)] border border-[var(--primary)]/30 px-1.5 py-0.5 rounded-[var(--radius-button)] whitespace-nowrap">
                      {recipe.cadence}
                    </span>
                  </div>
                  <p className="text-[11px] text-[var(--muted-foreground-2)] leading-relaxed flex-1">{recipe.description}</p>
                  <button
                    type="button"
                    disabled={busyId === recipe.id || deployed}
                    onClick={() => void deployRecipe(recipe)}
                    className="text-xs font-semibold self-start border rounded-[var(--radius-button)] px-2.5 py-1 transition-colors disabled:opacity-50 text-[var(--primary)] border-[var(--primary)]/40 bg-[var(--primary-soft)] hover:bg-[var(--primary-soft-hover)] flex items-center gap-1.5"
                  >
                    {busyId === recipe.id ? (
                      <>
                        <span className="animate-spin inline-block w-3 h-3 border-2 border-[var(--primary)] border-t-transparent rounded-full" />
                        <span>Deploying…</span>
                      </>
                    ) : deployed ? (
                      "Deployed"
                    ) : (
                      "Deploy recipe"
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Live automations from the DO */}
        <div className="border border-[var(--border-1)] rounded-[var(--radius-button)] bg-[var(--panel)] shadow-[var(--sh-card)] p-5 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[var(--fg)]">Deployed Automations</h3>
            <button
              type="button"
              onClick={refresh}
              className="text-[11px] text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:border-[var(--border-2)] border border-[var(--border-1)] rounded-[var(--radius-button)] px-2 py-1 transition-colors"
            >
              Refresh
            </button>
          </div>
          {loadError !== null ? (
            <LoadErrorState message={loadError} onRetry={refresh} />
          ) : automations === null ? (
            <div className="flex items-center gap-2 text-xs text-[var(--muted-foreground-2)] font-mono py-2">
              <span className="animate-spin inline-block w-3 h-3 border-2 border-[var(--muted-foreground-2)] border-t-transparent rounded-full" />
              <span>Loading…</span>
            </div>
          ) : automations.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 border border-dashed border-[var(--border-1)] rounded-[var(--radius-button)] bg-[var(--bg)] text-center px-4">
              <p className="text-[var(--muted-foreground-2)] text-xs">None yet — deploy a recipe above or POST /api/automations.</p>
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-[var(--border-1)]">
              {automations.map((a) => (
                <div key={a.id} className="py-2.5 flex items-center justify-between gap-3 hover:bg-[var(--card)] -mx-2 px-2 rounded-[var(--radius-button)] transition-colors">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono font-semibold text-[var(--fg)] truncate">{a.id}</span>
                      <span
                        className={`text-[10px] font-mono px-1.5 py-0.5 rounded-[var(--radius-button)] border ${
                          a.enabled
                            ? "text-[var(--success)] border-[color-mix(in_oklch,var(--success)_30%,transparent)] bg-[color-mix(in_oklch,var(--success)_12%,transparent)]"
                            : "text-[var(--muted-foreground-2)] border-[var(--border-1)] bg-[var(--card)]"
                        }`}
                      >
                        {a.enabled ? "enabled" : "disabled"}
                      </span>
                      <span className="text-[10px] font-mono text-[var(--muted-foreground-2)]">
                        {a.triggers.map((t) => t.kind === "schedule"
                          ? `schedule ${t.cron ?? ""}${t.timezone ? ` · ${t.timezone}` : " · UTC"}`
                          : t.kind).join(" + ")}
                      </span>
                    </div>
                    <p className="text-[11px] text-[var(--muted-foreground-2)] truncate mt-0.5">
                      {a.executionTarget?.kind === "artifact-workspace"
                        ? `${a.executionTarget.workspaceName ?? "Workspace"} · ${a.executionTarget.expectedDeliverables?.length ?? 0} required files`
                        : a.repoUrl} · runs: {a.runCount ?? 0}
                      {a.customAgentId ? ` · bot: ${a.customAgentId}` : ""}
                      {a.customAgentPin ? ` v${a.customAgentPin.version}` : ""}
                      {a.skillPins?.length ? ` · ${a.skillPins.filter((pin) => pin.enabled).length}/${a.skillPins.length} skills pinned` : ""}
                      {a.lastSkip ? ` · last skip: ${a.lastSkip.reason}` : ""}
                    </p>
                    {a.occurrences?.slice(-2).map((occurrence) => (
                      <p key={occurrence.id} className="text-[10px] font-mono text-[var(--muted-foreground-2)] truncate">
                        {new Date(occurrence.scheduledAt).toLocaleString()} · {occurrence.outcome}{occurrence.approvalId ? ` · approval ${occurrence.approvalId}` : ""}{occurrence.runId ? ` · run ${occurrence.runId}` : ""}
                      </p>
                    ))}
                  </div>
                  {a.triggers.some((t) => t.kind === "manual") ? (
                    <button
                      type="button"
                      disabled={busyId === `run-${a.id}`}
                      onClick={() => void triggerNow(a.id)}
                      className="text-xs font-semibold border border-[var(--primary)]/40 text-[var(--primary)] bg-[var(--primary-soft)] hover:bg-[var(--primary-soft-hover)] rounded-[var(--radius-button)] px-2.5 py-1 shrink-0 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                    >
                      {busyId === `run-${a.id}` ? (
                        <>
                          <span className="animate-spin inline-block w-3 h-3 border-2 border-[var(--primary)] border-t-transparent rounded-full" />
                          <span>Firing…</span>
                        </>
                      ) : (
                        "Run now"
                      )}
                    </button>
                  ) : null}
                  <button type="button" disabled={busyId === `toggle-${a.id}`} onClick={() => void setAutomationEnabled(a)} className="text-xs border border-[var(--border-1)] rounded-[var(--radius-button)] px-2 py-1 shrink-0 disabled:opacity-50">
                    {busyId === `toggle-${a.id}` ? "Saving…" : a.enabled ? "Pause" : "Resume"}
                  </button>
                  {a.customAgentId || a.skillPins?.length ? (
                    <button type="button" disabled={busyId === `review-${a.id}`} onClick={() => void reviewAutomationPins(a)} className="text-xs border border-[var(--border-1)] rounded-[var(--radius-button)] px-2 py-1 shrink-0 disabled:opacity-50">
                      {busyId === `review-${a.id}` ? "Reviewing…" : "Review current pins"}
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Integration Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* GitHub Webhook */}
          <div className="border border-[var(--border-1)] rounded-[var(--radius-button)] bg-[var(--panel)] shadow-[var(--sh-card)] p-5 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-semibold text-sm text-[var(--fg)]">
                <svg aria-hidden="true"  className="w-5 h-5 text-[var(--primary)]" fill="currentColor" viewBox="0 0 24 24">
                  <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
                </svg>
                <span>GitHub Webhooks</span>
              </div>
              <span className="text-[10px] font-mono uppercase bg-[var(--success)]/15 text-[var(--success)] border border-[color-mix(in_oklch,var(--success)_30%,transparent)] px-2 py-0.5 rounded-[var(--radius-button)]">
                Signature Verified
              </span>
            </div>

            <p className="text-xs text-[var(--muted-foreground-2)] leading-relaxed">
              Receives repo events (issues, PRs, comments) and automatically dispatches coding jobs to sandboxes.
            </p>

            <div className="bg-[var(--card)] p-2.5 rounded-[var(--radius-button)] border border-[var(--border-1)] flex items-center justify-between text-xs font-mono">
              <span className="text-[var(--fg)] truncate">/api/github/webhook</span>
              <button
                type="button"
                onClick={() => copyToClipboard("/api/github/webhook", "github")}
                className="text-[var(--primary)] hover:text-[var(--primary)] text-[11px] shrink-0 ml-2 transition-colors"
              >
                {copiedEndpoint === "github" ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="text-[11px] font-mono text-[var(--muted-foreground-2)]">
              Secret: <span className="text-[var(--fg)]">GITHUB_WEBHOOK_SECRET</span> (HMAC-SHA256)
            </div>
          </div>

          {/* Slack Integration */}
          <div className="border border-[var(--border-1)] rounded-[var(--radius-button)] bg-[var(--panel)] shadow-[var(--sh-card)] p-5 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-semibold text-sm text-[var(--fg)]">
                <svg aria-hidden="true"  className="w-5 h-5 text-[var(--primary)]" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521A2.528 2.528 0 0 1 2.522 8.834a2.528 2.528 0 0 1-2.522 2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1 2.521-2.52 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
                </svg>
                <span>Slack Bot & Interactive Gates</span>
              </div>
              <span className="text-[10px] font-mono uppercase bg-[var(--primary-soft)] text-[var(--primary)] border border-[var(--primary)]/30 px-2 py-0.5 rounded-[var(--radius-button)]">
                Interactive
              </span>
            </div>

            <p className="text-xs text-[var(--muted-foreground-2)] leading-relaxed">
              Mention <code className="text-[var(--fg)]">@shiba</code> or run <code className="text-[var(--fg)]">/shiba</code>. Approvals are posted as interactive Slack Block Kit cards.
            </p>

            <div className="flex flex-col gap-1.5 text-xs font-mono">
              <div className="bg-[var(--card)] p-2 rounded-[var(--radius-button)] border border-[var(--border-1)] flex items-center justify-between">
                <span>Commands: /api/slack/command</span>
                <button type="button" onClick={() => copyToClipboard("/api/slack/command", "slack1")} className="text-[var(--primary)] hover:text-[var(--primary)] text-[11px] transition-colors">
                  {copiedEndpoint === "slack1" ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="bg-[var(--card)] p-2 rounded-[var(--radius-button)] border border-[var(--border-1)] flex items-center justify-between">
                <span>Events: /api/slack/events</span>
                <button type="button" onClick={() => copyToClipboard("/api/slack/events", "slack2")} className="text-[var(--primary)] hover:text-[var(--primary)] text-[11px] transition-colors">
                  {copiedEndpoint === "slack2" ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="bg-[var(--card)] p-2 rounded-[var(--radius-button)] border border-[var(--border-1)] flex items-center justify-between">
                <span>Interactivity: /api/slack/interact</span>
                <button type="button" onClick={() => copyToClipboard("/api/slack/interact", "slack3")} className="text-[var(--primary)] hover:text-[var(--primary)] text-[11px] transition-colors">
                  {copiedEndpoint === "slack3" ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Automations DO Engine */}
        <div className="border border-[var(--border-1)] rounded-[var(--radius-button)] bg-[var(--panel)] shadow-[var(--sh-card)] p-5 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[var(--fg)] flex items-center gap-2">
              <svg aria-hidden="true"  className="w-4 h-4 text-[var(--primary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>Automations Durable Object Engine</span>
            </h3>
            <span className="text-[11px] font-mono text-[var(--success)]">Active & Bound</span>
          </div>

          <p className="text-xs text-[var(--muted-foreground-2)] leading-relaxed">
            The Automations Durable Object maintains scheduled task timers, processes incoming event fan-outs, and triggers automated coding workflows with full telemetry and replay receipts.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 font-mono text-xs">
            <div className="bg-[var(--card)] p-3 rounded-[var(--radius-button)] border border-[var(--border-1)] flex flex-col gap-1">
              <span className="text-[var(--muted-foreground-2)] text-[11px]">Cron Scheduler</span>
              <span className="text-[var(--fg)] font-semibold">Hourly Health Tick</span>
            </div>
            <div className="bg-[var(--card)] p-3 rounded-[var(--radius-button)] border border-[var(--border-1)] flex flex-col gap-1">
              <span className="text-[var(--muted-foreground-2)] text-[11px]">Evaluation Model</span>
              <span className="text-[var(--fg)] font-semibold">TypeSafe System One / Llama</span>
            </div>
            <div className="bg-[var(--card)] p-3 rounded-[var(--radius-button)] border border-[var(--border-1)] flex flex-col gap-1">
              <span className="text-[var(--muted-foreground-2)] text-[11px]">Run Capacity</span>
              <span className="text-[var(--fg)] font-semibold">5 Concurrent Sandboxes</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
