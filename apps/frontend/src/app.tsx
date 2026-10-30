Warning: truncated output (original token count: 30682)
Total output lines: 2868

/**
 * Complete End-to-End Shiba Dashboard.
 * Approval-gated coding tasks delegated to isolated Cloudflare Sandbox containers running OpenCode.
 */
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useAgent, useAgentToolEvents } from "agents/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { expectedDeliverablesSchema, HARNESS_REASONING_EFFORTS, type ReasoningEffort } from "@shiba/shared";
import { normalizeRunStatus, type VMRun } from "./types";
import { ActivityView } from "./components/ActivityView";
import { ActivityReportView } from "./components/ActivityReportView";
import { SwarmDeskView } from "./components/SwarmDeskView";
import { AnalyticsView } from "./components/AnalyticsView";
import { AutomationsView } from "./components/AutomationsView";
import { AgentsView } from "./components/AgentsView";
import { ProvidersView } from "./components/ProvidersView";
import { SkillsView } from "./components/SkillsView";
import { CustomAgentsView, useCustomAgentOptions, type CustomAgentWire } from "./components/CustomAgentsView";
import { ThreadTitleEditor } from "./components/ThreadTitleEditor";
import { applyThreadRename, createAgentThread, loadThreadMessages, threadAgentId, useAgentThreadDefaults, type WebThread } from "./agent-threads";
import { formatSkillInstructions, taskWithSkillInstructions } from "./skill-prompt";
import { buildExecutionTargetFields } from "./execution-target-input";
import type { EmployeeTemplate } from "./employee-templates";
import { RemoteAccessView } from "./components/RemoteAccessView";
import { useSavedRepos, useSavedSkills, saveRepo, readDraft, writeDraft } from "./saved";
import { useSocketLiveness } from "./socket-liveness";
import {
  codingModelOptions,
  readyConnectionOptions,
  useAgentsDirectory,
  useModelConfig,
} from "./live-status";
import { DashboardView } from "./components/DashboardView";
import { OnboardingModal, detectSetupSteps } from "./components/OnboardingModal";
import { FirstRunWizard, ONBOARDING_STORAGE_KEY } from "./components/FirstRunWizard";
import { SessionsSidebar, type SessionItem } from "./components/SessionsSidebar";
import { StepTimeline } from "./components/StepTimeline";
import { DiffView } from "./components/DiffView";
import { ApprovalsView } from "./components/ApprovalsView";
import { InboxTab } from "./components/InboxTab";
import { IntegrationsView } from "./components/IntegrationsView";
import { MemoryTab } from "./components/MemoryTab";
import { SettingsModal } from "./components/SettingsModal";
import type { SettingsSectionId } from "./components/settings-sections";
import { TaskComposer } from "./components/TaskComposer";
import { PullRequestCard } from "./components/PullRequestCard";
import { ReviewFindings } from "./components/ReviewFindings";
import { RunUsageCard } from "./components/RunUsageSummary";
import { RunProgressCard } from "./components/RunProgressCard";
import { useDesktopStatus } from "./desktop-status";
import { useLocalRunTarget } from "./local-run-target";
import { toast } from "sonner";
import { BookOpen, FlaskConical, Sparkles, Zap } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { AppNavRail, APP_NAV_ITEMS, type AppNavView } from "./components/AppNavRail";
import { AuthScreen, SessionPending, SessionProblem } from "./components/AuthScreen";
import { ShibaMark } from "./components/ShibaMark";
import { authClient } from "./auth-client";
import { CommandMenu, type CommandItem } from "./components/ui/command-menu";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { useTheme } from "./components/ThemeProvider";
import { Tooltip } from "./components/Tooltip";
import { extractPendingApprovals, extractCompletedDiff, parseRepoName, readPromptParam, runsListUrl, statusChipClass, statusLabel } from "./ui-helpers";
import { createCompletionDrivenPoll, documentVisibilityPause } from "./polling";
import type { AgentPrincipal, RetainedRun, StoredApproval, ToolRunRecord } from "./types";

const ORCHESTRATOR_AGENT = "coding-orchestrator";

// Guard for single-key shortcuts: never fire while the user is typing.
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el?.closest?.("input, textarea, select, [contenteditable]"));
}

function useRetainedRuns(
  refreshToken: number,
  sessionId: string,
  sessionApiAvailable: boolean,
  fullDetail: boolean,
  enabled: boolean,
): { runs: RetainedRun[]; error: string | null; detailReady: boolean; listSettled: boolean } {
  const [runs, setRuns] = useState<RetainedRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [listSettled, setListSettled] = useState(false);
  // True once a full-payload response has landed while fullDetail was on.
  // Detail surfaces (the diff inspector) gate on it so a summary list can
  // never render as "this run has no diff".
  const [detailReady, setDetailReady] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setListSettled(true);
      return;
    }
    let cancelled = false;
    if (!fullDetail) setDetailReady(false);
    let sessionScoped = sessionApiAvailable;
    let url = runsListUrl(sessionId, sessionScoped, fullDetail);
    const load = async () => {
      try {
        let response = await fetch(url);
        // Backends without session-scoped runs answer 404/405; fall back to the
        // unscoped list rather than leaving the registry empty. A 404 JSON
        // {error:"Session not found."} is different — the session itself is
        // gone, so an unscoped list would show another session's runs.
        if ((response.status === 404 || response.status === 405) && sessionScoped) {
          if (await isSessionNotFoundBody(response)) {
            if (!cancelled) {
              setRuns([]);
              setError(null);
              setDetailReady(fullDetail);
              setListSettled(true);
            }
            return;
          }
          sessionScoped = false;
          url = runsListUrl(sessionId, false, fullDetail);
          response = await fetch(url);
        }
        if (!response.ok) throw new Error(`Runs request failed: ${response.status}`);
        const body = (await response.json()) as { runs?: RetainedRun[] };
        if (!cancelled) {
          setRuns(Array.isArray(body.runs) ? body.runs : []);
          setError(null);
          setDetailReady(fullDetail);
          setListSettled(true);
        }
      } catch (fetchError: unknown) {
        if (!cancelled) {
          setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
          setListSettled(true);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshToken, sessionId, sessionApiAvailable, fullDetail, enabled]);

  return { runs, error, detailReady, listSettled };
}

/**
 * Live approval pointers from the orchestrator DO (`GET /api/approvals`).
 * These are the records Slack-card and queued-email approvals write —
 * separate from chat tool-part approvals, and the only surface where a
 * queued email send can be decided. Polls so cards disappear the moment
 * another surface (or a peer) resolves them.
 */
function useStoredApprovals(
  refreshToken: number,
  enabled: boolean,
): {
  approvals: StoredApproval[];
  decided: StoredApproval[];
  error: string | null;
} {
  const [approvals, setApprovals] = useState<StoredApproval[]>([]);
  const [decided, setDecided] = useState<StoredApproval[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // The poll drives DO writes on the backend — only run it while a
    // view that renders the data is up. Re-enabling loads immediately.
    if (!enabled) return;
    let cancelled = false;
    // A slow poll landing after a newer one must not repaint a resolved card.
    let sent = 0;
    let applied = 0;
    const load = () => {
      const seq = ++sent;
      return fetch("/api/approvals")
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`Approvals request failed: ${response.status}`);
          }
          const body = (await response.json()) as {
            approvals?: StoredApproval[];
            decided?: StoredApproval[];
          };
          if (!cancelled && seq > applied) {
            applied = seq;
            setApprovals(Array.isArray(body.approvals) ? body.approvals : []);
            setDecided(Array.isArray(body.decided) ? body.decided : []);
            setError(null);
          }
        })
        .catch((fetchError: unknown) => {
          if (!cancelled && seq > applied) {
            setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
          }
        });
    };
    // Completion-driven fallback (30s): DO state hints bump refreshToken for
    // real-time refreshes; this poll only catches other sessions' approvals.
    // The next tick arms after this load settles (single inflight), and a
    // hidden tab pauses instead of stacking polls.
    const poll = createCompletionDrivenPoll({
      intervalMs: 30_000,
      load,
      pause: documentVisibilityPause(),
    });
    return () => {
      cancelled = true;
      poll.stop();
    };
  }, [refreshToken, enabled]);

  return { approvals, decided, error };
}

// Registered MCP-token principals, polled on the same cadence as stored
// approvals. No error surface: a failed poll just keeps the last list —
// the sidebar Agents group is informational, not a decision surface.
function useAgentPrincipals(refreshToken: number, enabled: boolean): AgentPrincipal[] {
  const [principals, setPrincipals] = useState<AgentPrincipal[]>([]);

  useEffect(() => {
    // Same gating as the approvals poll — no view rendering this data,
    // no interval; re-entering a view refreshes immediately.
    if (!enabled) return;
    let cancelled = false;
    let sent = 0;
    let applied = 0;
    const load = () => {
      const seq = ++sent;
      return fetch("/api/agents")
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`Agents request failed: ${response.status}`);
          }
          const body = (await response.json()) as { principals?: AgentPrincipal[] };
          if (!cancelled && seq > applied) {
            applied = seq;
            setPrincipals(Array.isArray(body.principals) ? body.principals : []);
          }
        })
        .catch(() => {});
    };
    const poll = createCompletionDrivenPoll({
      intervalMs: 30_000,
      load,
      pause: documentVisibilityPause(),
    });
    return () => {
      cancelled = true;
      poll.stop();
    };
  }, [refreshToken, enabled]);

  return principals;
}

// A 404 is ambiguous: an older backend answers an unknown route with a bare
// (often non-JSON) 404, while the current Worker answers a real not-found
// with JSON {error:"Session not found."}. Only the JSON signal may be treated
// as a dead session — anything else is a safe "route unsupported" signal.
async function isSessionNotFoundBody(response: Response): Promise<boolean> {
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { error?: unknown } | null;
  return body?.error === "Session not found.";
}

type IdentityIssue = "signin" | "unconfigured" | "unreachable" | "error";

/** Static dashboard tests set this. The browser never does, so first paint waits for /api/whoami. */
function testAgentName(): string | null {
  const name = (globalThis as { __shibaTestAgent?: unknown }).__shibaTestAgent;
  return typeof name === "string" && name !== "" ? name : null;
}
type AuthMode = "better-auth" | "access" | "none";
type IdentityResult =
  | { agent: string; auth?: AuthMode }
  | { issue: IdentityIssue; message: string; auth?: AuthMode };

async function fetchIdentity(): Promise<IdentityResult> {
  let res: Response;
  try {
    // manual: Cloudflare Access answers an expired session with a cross-origin
    // login redirect, which would otherwise surface as an opaque CORS failure.
    res = await fetch("/api/whoami", {
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    return { issue: "unreachable", message: "Network error reaching /api/whoami." };
  }
  if (res.type === "opaqueredirect") {
    return { issue: "signin", message: "Sign-in required.", auth: "access" };
  }
  if (res.status === 401) {
    const body = (await res
      .clone()
      .json()
      .catch(() => null)) as { code?: unknown } | null;
    if (body?.code === "access_not_configured") {
      return { issue: "unconfigured", message: "Cloudflare Access is not configured." };
    }
    return body?.code === "better_auth"
      ? { issue: "signin", message: "Sign-in required.", auth: "better-auth" }
      : { issue: "signin", message: "Sign-in required." };
  }
  // Non-JSON means something other than the Worker answered (static host, dev proxy).
  const body = (await res.json().catch(() => null)) as { agent?: unknown; auth?: unknown } | null;
  if (
    body === null ||
    res.status === 404 ||
    res.status === 502 ||
    res.status === 503 ||
    res.status === 504
  ) {
    return { issue: "unreachable", message: `GET /api/whoami returned ${res.status}.` };
  }
  if (!res.ok) return { issue: "error", message: `GET /api/whoami failed with ${res.status}.` };
  const auth: AuthMode | undefined =
    body.auth === "better-auth" || body.auth === "access" || body.auth === "none"
      ? body.auth
      : undefined;
  return typeof body.agent === "string" && body.agent !== ""
    ? { agent: body.agent, auth }
    : { issue: "error", message: "The server did not return an agent identity." };
}

// Live tool-run records carry the delegate call's input, not a typed payload.
function toolRunInput(run: ToolRunRecord): Record<string, unknown> {
  const preview = run.inputPreview;
  return typeof preview === "object" && preview !== null && !Array.isArray(preview)
    ? (preview as Record<string, unknown>)
    : {};
}

type MainView = AppNavView;

const VIEW_ALIASES: Record<string, AppNavView> = {
  "run-registry": "analytics",
  orchestrator: "activity",
  mailbox: "inbox",
};

// Each sidebar view owns a root path (/dashboard/, /skills/ …); legacy ?tab=/?view=/?run= still resolve.
function viewFromUrl(): AppNavView | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  if (params.get("run")) return "dashboard";
  const toView = (raw: string | null) => {
    const view = raw ? (VIEW_ALIASES[raw] ?? raw) : null;
    return APP_NAV_ITEMS.some((item) => item.id === view) ? (view as AppNavView) : null;
  };
  return (
    toView(window.location.pathname.split("/")[1] ?? null) ??
    toView(params.get("tab") || params.get("view"))
  );
}

function pathForView(view: MainView): string {
  return view === "tasks" ? "/" : `/${view}/`;
}

const SETUP_TOTAL_STEPS = 6;

const STARTER_TEMPLATES = [
  {
    icon: FlaskConical,
    label: "Fix Failing Tests",
    task: "Investigate test failures in the repository, fix the root cause, and verify all test suites pass with zero regressions.",
  },
  {
    icon: Zap,
    label: "Add Unit Tests",
    task: "Identify uncovered functions in the core modules and add thorough unit test coverage with edge case tests.",
  },
  {
    icon: Sparkles,
    label: "Refactor & Clean",
    task: "Refactor duplicate utility logic, remove unused imports and dead code, and ensure clean types across the codebase.",
  },
  {
    icon: BookOpen,
    label: "Documentation",
    task: "Review and update README and code comments to match recent API changes and architecture decisions.",
  },
];

export function App(): React.JSX.Element {
  const [repoUrl, setRepoUrl] = useState("");
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const savedRepos = useSavedRepos();
  const savedSkills = useSavedSkills();
  const [baseBranch, setBaseBranch] = useState("main");
  // T71 — deep-link ?prompt= prefills empty composer task on app load; replaceState strips it.
  const [task, setTask] = useState(() => {
    const draft = readDraft("default");
    if (typeof window === "undefined") return draft;
    const { prompt, nextSearch } = readPromptParam(window.location.search);
    if (prompt !== null) {
      const nextUrl = window.location.pathname + nextSearch + window.location.hash;
      window.history.replaceState(window.history.state, "", nextUrl);
      if (!draft.trim()) return prompt;
    }
    return draft;
  });
  const [publishPullRequest, setPublishPullRequest] = useState(false);
  const [reviewAfterPublish, setReviewAfterPublish] = useState(true);
  const [runSetup, setRunSetup] = useState(false);
  const [harness, setHarness] = useState("opencode");
  const [customAgentId, setCustomAgentId] = useState("");
  const [initialEmployeeTemplateId, setInitialEmployeeTemplateId] = useState<EmployeeTemplate["id"] | null>(null);
  const [codingModel, setCodingModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | "">("");
  const [envVars, setEnvVars] = useState<{ name: string; value: string }[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [showClearModal, setShowClearModal] = useState(false);
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const { resolvedTheme, setTheme } = useTheme();
  const theme = (resolvedTheme === "light" ? "light" : "dark") as "dark" | "light";
  const toggleTheme = () => setTheme(theme === "dark" ? "light" : "dark");

  useEffect(() => {
    document.title = "Shiba Dashboard · Self-Hosted AI Software Engineer";
  }, []);

  // Surface transient notices through the toast channel (aria-live inside sonner).
  useEffect(() => {
    if (notice) toast(notice);
  }, [notice]);
  const [showOnboardingModal, setShowOnboardingModal] = useState(false);
  const [mainView, setMainView] = useState<MainView>(() => {
    const view = viewFromUrl();
    return view && view !== "settings" ? view : "tasks";
  });
  // Settings is a Kosuke-style popup, not a full view — every nav path that
  // would land on "settings" opens the modal over the current view instead.
  const [settingsModalOpen, setSettingsModalOpen] = useState(() => viewFromUrl() === "settings");
  // Last section the user had open in the settings modal — reopening lands
  // where they left off; deep links (e.g. the wizard's Models step) override it.
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSectionId>("account");
  const openView = useCallback((view: AppNavView) => {
    // Settings is a popup, not a routable view — every nav path opens the modal.
    if (view === "settings") {
      setSettingsModalOpen(true);
      return;
    }
    setMainView(view);
  }, []);
  // Once visited, the mailbox stays mounted (hidden) — its local state
  // (search text, selected thread, drafts) survives nav switches.
  const [inboxMounted, setInboxMounted] = useState(mainView === "inbox");
  if (mainView === "inbox" && !inboxMounted) setInboxMounted(true);
  const [setupDone, setSetupDone] = useState<number | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("default");
  // Per-session composer draft: a scope change loads that scope's draft
  // instead of writing the old text into it; otherwise edits persist after 300 ms idle.
  const draftScope = useRef<string | null>("default");
  const pendingDraft = useRef<{ scope: string; text: string } | null>(null);
  const flushDraft = useCallback(() => {
    const pending = pendingDraft.current;
    pendingDraft.current = null;
    if (pending) writeDraft(pending.scope, pending.text);
  }, []);
  useEffect(() => {
    if (draftScope.current !== selectedSessionId) {
      flushDraft(); // the old scope's unwritten keystrokes land before switching
      draftScope.current = selectedSessionId;
      setTask(readDraft(selectedSessionId));
      return;
    }
    pendingDraft.current = { scope: selectedSessionId, text: task };
    // An emptied composer (submit or clear) flushes now; typing waits for 300 ms idle.
    if (!task.trim()) return flushDraft();
    const timer = window.setTimeout(flushDraft, 300);
    return () => window.clearTimeout(timer);
  }, [selectedSessionId, task, flushDraft]);
  // A failed submit restores its text only into the session it came from.
  const restoreDraft = useCallback((scope: string, text: string) => {
    if (draftScope.current === scope) setTask((current) => (current === "" ? text : current));
    else writeDraft(scope, text);
  }, []);
  // Local runs use the authenticated paired fleet in both web and desktop.
  const [runTarget, setRunTarget] = useState<"sandbox" | "local">("sandbox");
  const [executionTargetKind, setExecutionTargetKind] = useState<"repository" | "artifact-workspace">("repository");
  const [artifactWorkspaceName, setArtifactWorkspaceName] = useState("My workspace");
  const [artifactDeliverables, setArtifactDeliverables] = useState("deliverables/brief.md");
  const { status: desktopStatus } = useDesktopStatus();
  // Only these harnesses run locally; anything else would show as a
  // deployment pin the backend then refuses.
  useEffect(() => {
    if (executionTargetKind === "artifact-workspace" && runTarget === "local") setRunTarget("sandbox");
    if (runTarget === "local" && executionTargetKind === "repository" && !customAgentId && !["opencode", "claude-code", "codex"].includes(harness))
      setHarness("opencode");
  }, [runTarget, harness, customAgentId, executionTargetKind]);
  const [sessionApiAvailable, setSessionApiAvailable] = useState(false);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [webSessions, setWebSessions] = useState<WebThread[]>([]);
  // Persistent workspace panel removed from tasks view; functionality promoted to standalone views.
  const [mobileSessionsOpen, setMobileSessionsOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const mobileNavTriggerRef = useRef<HTMLButtonElement | null>(null);

  // Return focus to the hamburger after the sheet unmounts, so Esc/backdrop
  // closes don't strand keyboard users on a removed element. Skip the first
  // run — the sheet never opened — or the hamburger steals focus on load.
  const mobileNavWasOpen = useRef(false);
  useEffect(() => {
    if (mobileNavOpen) {
      mobileNavWasOpen.current = true;
    } else if (mobileNavWasOpen.current) {
      mobileNavTriggerRef.current?.focus();
    }
  }, [mobileNavOpen]);
  const [sessionsCollapsed, setSessionsCollapsed] = useState(() =>
    typeof window !== "undefined"
      ? localStorage.getItem("shiba:sidebar-collapsed") === "true"
      : false,
  );

  const toggleSessionsCollapsed = useCallback(() => {
    setSessionsCollapsed((current) => {
      const next = !current;
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem("shiba:sidebar-collapsed", String(next));
        } catch {
          // Ignore storage quota or access errors in private mode
        }
      }
      return next;
    });
  }, []);

  // The view itself is read in the useState initializers; only the run pick needs an effect.
  useEffect(() => {
    const runParam = new URLSearchParams(window.location.search).get("run");
    if (runParam) setSelectedRunId(runParam);
  }, []);

  // The f…18682 tokens truncated…an className="cursor-default">
                        <span className="text-[var(--muted-foreground-2)]">Approvals</span>{" "}
                        <span
                          className={
                            pendingApprovals.length + visibleStoredApprovals.length > 0
                              ? "font-bold text-[var(--warning-fg)]"
                              : "font-bold text-[var(--muted-foreground-2)]"
                          }
                        >
                          {pendingApprovals.length + visibleStoredApprovals.length}
                        </span>
                      </span>
                    </Tooltip>
                    <Tooltip content="Retained runs in this workspace" side="bottom">
                      <span className="cursor-default">
                        <span className="text-[var(--muted-foreground-2)]">Runs</span>{" "}
                        <span className="text-[var(--fg)] font-bold">{allRuns.length}</span>
                      </span>
                    </Tooltip>
                  </div>
                </div>

                {/* PENDING APPROVALS STRIP */}
                {pendingApprovals.length + visibleStoredApprovals.length > 0 ||
                approvalAnnouncement ? (
                  <div className="bg-[var(--card)] border-b border-[var(--border-1)] px-3 sm:px-5 xl:px-6 py-3 flex items-center justify-between gap-3 shadow-[var(--sh-card)] z-10 shrink-0">
                    <p
                      className="text-sm font-medium text-[var(--fg)]"
                      role="status"
                      aria-live="polite"
                    >
                      {pendingApprovals.length + visibleStoredApprovals.length > 0 ? (
                        <span className="flex items-center gap-2 text-[var(--warning-fg)]">
                          <span className="w-2.5 h-2.5 rounded-full bg-[var(--warning-fg)] animate-pulse" />
                          {pendingApprovals.length + visibleStoredApprovals.length} task
                          {pendingApprovals.length + visibleStoredApprovals.length === 1 ? "" : "s"}{" "}
                          waiting for your approval.
                        </span>
                      ) : (
                        <span className="text-[var(--success)] flex items-center gap-2">
                          <svg
                            aria-hidden="true"
                            className="w-4 h-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M5 13l4 4L19 7"
                            />
                          </svg>
                          {approvalAnnouncement}
                        </span>
                      )}
                    </p>
                    {visibleStoredApprovals.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => setMainView("approvals")}
                        className="shrink-0 text-xs font-semibold text-[var(--warning-fg)] border border-[color-mix(in_oklch,var(--warning-fg)_40%,transparent)] bg-[color-mix(in_oklch,var(--warning-fg)_10%,transparent)] hover:bg-[var(--warning-fg)]/15 rounded-[var(--radius-button)] px-3 py-1.5 touch:min-h-11 transition-colors"
                      >
                        Review
                      </button>
                    ) : null}
                  </div>
                ) : null}

                {/* NOTICES / ERRORS */}
                {notice || chat.error || runsError ? (
                  <div className="px-3 sm:px-5 xl:px-6 pt-3 flex flex-col gap-2 shrink-0">
                    {notice ? (
                      <div
                        role="status"
                        aria-live="polite"
                        className="text-xs text-[var(--muted-foreground-2)] bg-[var(--card)] p-3 rounded-[var(--radius-button)] border border-[var(--border-1)] flex items-start gap-2"
                      >
                        <svg
                          aria-hidden="true"
                          className="w-4 h-4 text-[var(--primary)] shrink-0 mt-0.5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                          />
                        </svg>
                        <div className="break-words">{notice}</div>
                      </div>
                    ) : null}
                    {chat.error ? (
                      <div
                        role="alert"
                        className="text-xs text-[var(--destructive)] bg-[var(--destructive-soft)] p-3 rounded-[var(--radius-button)] border border-[color-mix(in_oklch,var(--destructive)_30%,transparent)] flex items-start gap-2"
                      >
                        <svg
                          aria-hidden="true"
                          className="w-4 h-4 text-[var(--destructive)] shrink-0 mt-0.5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                          />
                        </svg>
                        <div className="break-words">Chat error: {chat.error.message}</div>
                      </div>
                    ) : null}
                    {runsError ? (
                      <div className="text-xs text-[var(--destructive)] bg-[var(--destructive-soft)] p-3 rounded-[var(--radius-button)] border border-[color-mix(in_oklch,var(--destructive)_30%,transparent)] flex items-start gap-2">
                        <svg
                          aria-hidden="true"
                          className="w-4 h-4 text-[var(--destructive)] shrink-0 mt-0.5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                          />
                        </svg>
                        <div className="break-words">Runs registry: {runsError}</div>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {/* TIMELINE (scrollable) — hidden on the empty-state hero */}
                <div
                  className={`flex-1 overflow-y-auto overscroll-contain px-3 sm:px-5 xl:px-8 py-5 ${threadHasWork ? "" : "hidden"}`}
                >
                  {chat.messages.length > 0 ? (
                    <StepTimeline
                      messages={chat.messages}
                      isStreaming={chat.isStreaming || chat.status === "streaming"}
                      pendingApprovals={pendingApprovals}
                      decisions={decisions}
                      onDecideApproval={decideApproval}
                      reviewAfterPublishById={reviewAfterPublishById}
                      starters={STARTER_TEMPLATES}
                      onStarter={(starterTask) => {
                        setTask(starterTask);
                        if (!repoUrl) setRepoUrl("https://github.com/cloudflare/ai-chat");
                      }}
                    />
                  ) : null}
                  {reviewThreadId ? (
                    <div className="mt-4 flex flex-col gap-3">
                      <RunProgressCard run={reviewRun} sessionId={selectedSessionId} />
                      <RunUsageCard runs={retainedRuns} />
                      <PullRequestCard
                        threadId={reviewThreadId}
                        sessionId={selectedSessionId}
                        fallbackPullUrl={reviewRun?.pullUrl}
                        publishRequested={reviewRun?.publishPullRequest === true}
                      />
                      <ReviewFindings
                        threadId={reviewThreadId}
                        sessionId={selectedSessionId}
                        reviewAfterPublish={reviewRun?.reviewAfterPublish === true}
                      />
                    </div>
                  ) : null}
                </div>

                {/* COMPOSER — hero when the session is empty, docked once the run is going */}
                <div
                  className={
                    chat.messages.length === 0 && !reviewThreadId
                      ? "flex-1 flex flex-col min-h-0"
                      : "border-t border-[var(--border-1)] bg-[var(--card)]/60 px-3 sm:px-5 xl:px-8 pt-3 sm:pt-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-[max(1rem,env(safe-area-inset-bottom))] shrink-0"
                  }
                >
                  <TaskComposer
                    repoUrl={repoUrl}
                    task={task}
                    baseBranch={baseBranch}
                    publishPullRequest={publishPullRequest}
                    reviewAfterPublish={reviewAfterPublish}
                    harness={harness}
                    busy={busy}
                    repoSuggestions={repoSuggestions}
                    skills={savedSkills}
                    selectedSkillIds={selectedSkillIds}
                    onToggleSkill={(id) =>
                      setSelectedSkillIds((current) =>
                        current.includes(id)
                          ? current.filter((entry) => entry !== id)
                          : [...current, id],
                      )
                    }
                    isSubmitting={isSubmitting}
                    clearing={clearing}
                    executionTargetKind={executionTargetKind}
                    onExecutionTargetKindChange={(value) => {
                      setExecutionTargetKind(value);
                      if (value === "artifact-workspace") {
                        setRunTarget("sandbox");
                        setPublishPullRequest(false);
                        setRunSetup(false);
                      }
                    }}
                    artifactWorkspaceName={artifactWorkspaceName}
                    onArtifactWorkspaceNameChange={setArtifactWorkspaceName}
                    artifactDeliverables={artifactDeliverables}
                    onArtifactDeliverablesChange={setArtifactDeliverables}
                    runTarget={runTarget}
                    onRunTargetChange={setRunTarget}
                    localRunAvailable={localRunAvailable}
                    localComputers={localComputers}
                    targetMachineId={selectedLocalMachineId}
                    onTargetMachineChange={selectLocalMachine}
                    localComputersLoading={localComputersLoading}
                    localComputersError={localComputersError}
                    onRefreshLocalComputers={refreshLocalComputers}
                    onRepoUrlChange={setRepoUrl}
                    onTaskChange={setTask}
                    onBaseBranchChange={setBaseBranch}
                    onPublishPullRequestChange={(value) => {
                      setPublishPullRequest(value);
                      if (value) setReviewAfterPublish(true);
                    }}
                    onReviewAfterPublishChange={setReviewAfterPublish}
                    runSetup={runSetup}
                    onRunSetupChange={setRunSetup}
                    onHarnessChange={setHarness}
                    customAgents={customAgentPickerOptions}
                    customAgentId={customAgentId}
                    customAgentsLoading={customAgentsLoading}
                    onCustomAgentChange={setCustomAgentId}
                    routing={{
                      codingModel,
                      connectionId,
                      onCodingModelChange: setCodingModel,
                      onConnectionChange: setConnectionId,
                      reasoningEffort,
                      onReasoningEffortChange: setReasoningEffort,
                      modelSuggestions: codingModelSuggestions,
                      connections: modelConnections,
                    }}
                    envVars={envVars}
                    onEnvVarsChange={setEnvVars}
                    variant={threadHasWork ? "docked" : "hero"}
                    onSubmit={submitTask}
                    onClear={() => setShowClearModal(true)}
                  />
                </div>
              </main>
            </div>
          ) : mainView === "activity" ? (
            // Remount on session switch so the previous session's spine never
            // renders as the new one's while its first fetch is in flight.
            <div className="flex-1 overflow-y-auto">
              <ActivityReportView
                key={selectedSessionId}
                sessionId={selectedSessionId}
                sessionApiAvailable={sessionApiAvailable}
              />
              <div className="flex h-[max(520px,70vh)] flex-col">
                <ActivityView
                  key={selectedSessionId}
                  sessionId={selectedSessionId}
                  sessionApiAvailable={sessionApiAvailable}
                />
              </div>
            </div>
          ) : mainView === "analytics" ? (
            <AnalyticsView
              runs={retainedRuns}
              error={runsError}
              sessionId={selectedSessionId}
              sessionApiAvailable={sessionApiAvailable}
              onNavigate={openView}
            />
          ) : mainView === "diff" ? (
            <DiffView
              runs={allRuns}
              sessionId={selectedSessionId}
              selectedRunId={
                selectedRunId ??
                (allRuns.some((run) => run.runId === selectedSessionId) ? selectedSessionId : null)
              }
              onSelectRun={(id) => setSelectedRunId(id)}
              loading={!runsDetailReady}
              error={runsError}
              liveHarness
            />
          ) : mainView === "approvals" ? (
            <ApprovalsView
              pendingApprovals={pendingApprovals}
              decisions={decisions}
              onDecideApproval={decideApproval}
              storedApprovals={visibleStoredApprovals}
              storedDecisions={storedDecisions}
              decidedStoredApprovals={decidedStoredApprovals}
              storedApprovalsError={storedApprovalsError}
              onDecideStoredApproval={decideStoredApproval}
              orchestratorName={orchestratorName}
              onRefresh={refreshRuns}
              reviewAfterPublishById={reviewAfterPublishById}
              liveHarness
            />
          ) : mainView === "memory" ? (
            <div className="flex-1 flex flex-col h-full overflow-hidden bg-[var(--bg)] text-[var(--fg)]">
              <div className="border-b border-[var(--border-1)] bg-[var(--panel)] px-4 lg:px-8 py-4 shrink-0 flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-base font-semibold text-[var(--fg)] flex items-center gap-2">
                    <span>Agent Memory</span>
                  </h2>
                  <p className="text-xs text-[var(--muted-foreground-2)]">
                    Vectorize long-term semantic memory, extracted facts, and session context.
                  </p>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-4 lg:p-8">
                <div className="max-w-6xl mx-auto">
                  <MemoryTab />
                </div>
              </div>
            </div>
          ) : mainView === "automations" ? (
            <AutomationsView />
          ) : mainView === "swarm" ? (
            <SwarmDeskView
              runs={retainedRuns}
              onResolve={async (runId) => {
                const params = new URLSearchParams();
                if (selectedSessionId) params.set("session", selectedSessionId);
                const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/archive?${params}`, { method: "POST" });
                if (!response.ok) {
                  const body = await response.json().catch(() => ({})) as { error?: string };
                  throw new Error(body.error ?? `Resolve failed (${response.status}).`);
                }
                refreshRuns();
              }}
              onApplyIntake={(prompt) => {
                setTask(prompt);
                setMainView("tasks");
                window.setTimeout(() => {
                  document.querySelector<HTMLTextAreaElement>('[data-testid="task-composer"] textarea')?.focus();
                }, 0);
              }}
              shareUrlFor={async (runId) => {
                const response = await fetch("/api/swarm/share", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ runId }),
                });
                const body = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
                if (!response.ok || typeof body.url !== "string") {
                  throw new Error(body.error ?? `Share failed (${response.status}).`);
                }
                return body.url;
              }}
            />
          ) : mainView === "providers" ? (
            <ProvidersView />
          ) : mainView === "skills" ? (
            <SkillsView />
          ) : mainView === "custom-agents" ? (
            <CustomAgentsView
              onStartThread={handleStartAgentThread}
              initialTemplateId={initialEmployeeTemplateId}
              onInitialTemplateApplied={() => setInitialEmployeeTemplateId(null)}
              connections={modelConnections}
              modelSuggestions={agentsDirectory.state.kind === "data" ? agentsDirectory.state.data.agents.map((agent) => agent.defaultModel).filter((model): model is string => typeof model === "string" && model.includes("/")) : []}
              threads={webSessions}
              threadsLoading={!sessionsLoaded}
              threadsUnavailable={sessionsLoaded && !sessionApiAvailable}
              onOpenThread={(id) => { void handleSelectSession(id); }}
            />
          ) : mainView === "agents" ? (
            <AgentsView />
          ) : mainView === "integrations" ? (
            <IntegrationsView onNavigate={openView} />
          ) : mainView === "remote" ? (
            <RemoteAccessView />
          ) : null}

          {/* SETTINGS — Kosuke-style popup over the current view */}
          {settingsModalOpen ? (
            <SettingsModal
              isOpen
              initialSection={settingsInitialSection}
              onSectionChange={setSettingsInitialSection}
              onClose={() => setSettingsModalOpen(false)}
              onFocusRestore={() => {
                if (window.matchMedia("(max-width: 1023px)").matches) {
                  mobileNavTriggerRef.current?.focus();
                }
              }}
              onOpenSessions={() => {
                setMainView("tasks");
                if (window.matchMedia("(min-width: 1024px)").matches) {
                  setSessionsCollapsed((collapsed) => {
                    if (collapsed) {
                      try {
                        localStorage.setItem("shiba:sidebar-collapsed", "false");
                      } catch {
                        // Ignore storage errors in private mode.
                      }
                    }
                    return false;
                  });
                } else {
                  setMobileSessionsOpen(true);
                }
              }}
              onNavigate={(view) => {
                setSettingsModalOpen(false);
                openView(view);
              }}
              onSignOut={authMode === "better-auth" ? handleSignOut : undefined}
            />
          ) : null}

          {/* CLEAR HISTORY CONFIRMATION MODAL */}
          {showClearModal ? (
            <div className="fixed inset-0 bg-[var(--overlay)] z-50 flex items-center justify-center p-4">
              <div className="bg-[var(--card)] border border-[var(--border-1)] rounded-[var(--radius-button)] max-w-md w-full p-6 shadow-[var(--sh-overlay)]">
                <h3 className="text-lg font-bold text-[var(--fg)] mb-2">
                  Clear Conversation & Runs?
                </h3>
                <p className="text-sm text-[var(--muted-foreground-2)] mb-5 leading-relaxed">
                  This will erase all active conversation history and delete retained run registry
                  records on the orchestrator. Active sandboxes will not be destroyed automatically.
                </p>
                <div className="flex items-center justify-end gap-3">
                  <button
                    type="button"
                    className="px-4 py-2 rounded-[var(--radius-button)] text-sm font-medium text-[var(--muted-foreground-2)] hover:text-[var(--fg)] bg-[var(--card)] border border-[var(--border-1)] transition-colors"
                    onClick={() => setShowClearModal(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="px-4 py-2 rounded-[var(--radius-button)] text-sm font-semibold text-white bg-[var(--destructive)] hover:bg-[var(--destructive)]/90 transition-colors shadow-[var(--sh-card)]"
                    onClick={confirmClearAll}
                  >
                    Yes, Clear History
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {/* ONBOARDING SETUP MODAL */}
          <FirstRunWizard
            open={showFirstRun}
            onClose={() => setShowFirstRun(false)}
            onNavigate={openView}
            onStartEmployeeSetup={(template) => {
              setInitialEmployeeTemplateId(template.id);
              setShowFirstRun(false);
              openView("custom-agents");
            }}
            onOpenModels={() => {
              setSettingsInitialSection("models");
              setSettingsModalOpen(true);
            }}
            onOpenChecklist={() => setShowOnboardingModal(true)}
          />

          <OnboardingModal
            isOpen={showOnboardingModal}
            onClose={() => setShowOnboardingModal(false)}
            onOpenInbox={() => setMainView("inbox")}
            onSelectStarterTask={(repo, t, h) => {
              setRepoUrl(repo);
              setTask(t);
              setHarness(h);
            }}
          />

          <ShortcutsDialog open={showShortcutsModal} onClose={() => setShowShortcutsModal(false)} />
          <CommandMenu
            open={commandMenuOpen}
            onClose={() => setCommandMenuOpen(false)}
            commands={commands}
          />
        </div>
      </div>
    </div>
  );
}
