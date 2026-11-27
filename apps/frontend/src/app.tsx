import { RepeatRoutineDialog } from "./components/RoutinesView";
import { routineSourceFromRun, type RoutineSource } from "./routines";
import { AppShell, AppAreaSidebar } from "./layouts/AppShell";
import { pathForView, readNavigationView } from "./app-navigation";
import { connectedTaskDefault } from "./supported-task-routes";
import { parseWorkSearch, updateWorkSearch, type WorkSearchState } from "./work-search";
/**
 * Complete End-to-End Shiba Dashboard.
 * Approval-gated coding tasks delegated to isolated Cloudflare Sandbox containers running OpenCode.
 */
import { readRoomLink, useRoomLinkRoute } from "./room-links";
import { DEFAULT_THREAD_ID, readThreadLink, resolveLinkedThread, withThreadLink } from "./thread-links";
import { normalizeRepositoryInput, REPOSITORY_INPUT_ERROR } from "./repository-input";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useConversationRoomRealtime, type ConversationRoomMessage } from "./conversation-room-realtime";
import { useAgent, useAgentToolEvents } from "agents/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { startDashboardObservability } from "./observability";
import { HARNESS_REASONING_EFFORTS, MAX_RUN_ATTACHMENTS, MAX_RUN_ATTACHMENT_BYTES, MAX_RUN_ATTACHMENTS_TOTAL_BYTES, onboardingTaskText, deriveOnboardingStatus, type OnboardingStepStatus, type ReasoningEffort, type RunAttachment, type TeamOnboardingTask, type AcpProvidersSnapshot } from "@shiba/shared";
import { normalizeRunStatus, type VMRun } from "./types";
import { ActivityView } from "./components/ActivityView";
import { ActivityReportView } from "./components/ActivityReportView";
import { SwarmDeskView } from "./components/SwarmDeskView";
import { CollaborationView, type IncomingTaskDraft } from "./components/CollaborationView";
import { RoomExecutionPanel } from "./components/RoomExecutionPanel";
import { RoomApprovalReview } from "./components/RoomApprovalReview";
import { TeamWorkspaceView } from "./components/TeamWorkspaceView";
import { WorkspaceSwitcher } from "./components/WorkspaceSwitcher";
import { lastTeamWorkspace, rememberLastTeamWorkspace, useTeamWorkspaceDirectory } from "./team-workspaces-client";
import { useWorkTasks } from "./work-mutations";
import { useFirstRunSeed } from "./first-run-seed";
import { AnalyticsView } from "./components/AnalyticsView";
import { AutomationsView } from "./components/AutomationsView";
import { AgentsView } from "./components/AgentsView";
import { ProvidersView } from "./components/ProvidersView";
import { SkillsView } from "./components/SkillsView";
import { SpacesView } from "./components/SpacesView";
import { CustomAgentsView, useCustomAgentOptions, type CustomAgentWire } from "./components/CustomAgentsView";
import { EmployeeToolPolicyView } from "./components/EmployeeToolPolicyView";
import { AgentDetailsPanel, BotThreadlessState, EmployeeOnboarding, ONBOARDING_DISMISSED_KEY, createEmployeeAgent, employeeExamples } from "./components/AgentExperience";
import type { BotRunsScope } from "./components/bot/BotPanel";
import { ThreadTitleEditor } from "./components/ThreadTitleEditor";
import { applyThreadRename, createAgentThread, loadThreadMessages, threadAgentId, useAgentThreadDefaults, type WebThread } from "./agent-threads";
import { saveBotConfig, saveBotDeliverables, type BotConfigEdit } from "./bot-library";
import { useProjectContexts } from "./project-contexts";
import { buildExecutionTargetFields, hasComposerInput, parseArtifactDeliverables, type DashboardExecutionTargetFields } from "./execution-target-input";
import { appToolsWorkIssue, sendAppToolsWork } from "./app-tools-work";
import type { EmployeeTemplate } from "./employee-templates";
import { RemoteAccessView } from "./components/RemoteAccessView";
import { setSavedLibraryActor, useSavedRepos, useSavedSkills, saveRepo, composerDraftScope, readDraft, readDraftReference, writeDraft } from "./saved";
import { useSocketLiveness } from "./socket-liveness";
import {
  codingModelOptions,
  readyConnectionOptions,
  useAgentsDirectory,
  useModelConfig,
  type SetupStatus,
} from "./live-status";
import { chatLookupOptions, selectedChatLookups, type ChatLookupId } from "./chat-lookups";
import { DashboardView } from "./components/DashboardView";
import { WorkView, type WorkViewMode } from "./components/WorkView";
import type { OrganizationEmployee } from "./components/WorkOrganizationView";
import { employeeRole, employeeRoleLabel } from "./employee-templates";
import { TasksHomeView } from "./components/TasksHomeView";
import { OnboardingModal, detectSetupSteps } from "./components/OnboardingModal";
import { FirstRunWizard, type FirstRunProgressSnapshot, type FirstRunStepId } from "./components/FirstRunWizard";
import { OnboardingProgressClient, type FirstRunProgressUpdate } from "./onboarding-progress-client";
import { ConversationalOnboarding } from "./components/ConversationalOnboarding";
import { OnboardingJourney, type JourneyEmployee, type JourneyRun } from "./components/OnboardingJourney";
import { deriveJourney, shouldOpenJourney, type JourneyStepId } from "./onboarding-journey";
import { teamWorkspaceRequest } from "./team-workspaces-client";
import { OnboardingNudgeBanner } from "./components/OnboardingNudgeBanner";
import { OnboardingNudgePopup } from "./components/OnboardingNudgePopup";
import { TeamOnboardingDraft } from "./components/TeamOnboardingDraft";
import type { OnboardingDraftRef, SelectedOnboardingDraft } from "./onboarding-draft";
import { SessionsSidebar, type SessionItem } from "./components/SessionsSidebar";
import { ConversationWorkspaceHeading } from "./components/ConversationWorkspaceHeading";
import { ConversationRoomPresence, RemoteAgentStream } from "./components/ConversationRoomPresence";
import { ConversationModeSwitch } from "./components/ConversationModeSwitch";
import { AgentChatEmptyState } from "./components/AgentChatEmptyState";
import { ChatSuggestions, focusComposerDraft } from "./components/ChatSuggestions";
import { AgentChatHeader } from "./components/AgentChatHeader";
import { AgentComposerShell } from "./components/AgentComposerShell";
import type { ChatCreateChoice } from "./components/ChatMessageComposer";
import {
  readConversationMode,
  readRememberedSessionId,
  resolveRememberedSessionId,
  writeConversationMode,
  writeRememberedSessionId,
  type ConversationMode,
} from "./conversation-mode";
import { StepTimeline } from "./components/StepTimeline";
import { UiBlockQuestions } from "./components/UiBlockQuestions";
import { DiffView } from "./components/DiffView";
import { EmployeeWorkspace } from "./components/EmployeeWorkspace";
import { ChiefOfStaffView } from "./components/ChiefOfStaffView";
import { ApprovalsView } from "./components/ApprovalsView";
import { InboxTab } from "./components/InboxTab";
import { IntegrationsView } from "./components/IntegrationsView";
import { BrowserPanel } from "./components/BrowserPanel";
import { MemoryTab } from "./components/MemoryTab";
import { FilesView } from "./components/knowledge/FilesView";
import { NotesEditor } from "./components/knowledge/NotesEditor";
import { OutputsView } from "./components/knowledge/OutputsView";
import { ProjectsView } from "./components/knowledge/ProjectsView";
import { SettingsPage, SettingsPanel, normalizeSettingsSection } from "./components/SettingsPage";
import { MainCard, type Scope } from "./components/ui/ContextPanel";
import { AgentsPanel } from "./components/AgentsPanel";
import { ChatsPanel } from "./components/ChatsPanel";
import { ExtensionsPanel } from "./components/ExtensionsPanel";
import { MailboxPanel, type MailboxCounts, type MailboxPanelItem } from "./components/MailboxPanel";
import { MemoryPanel, type MemoryCounts } from "./components/MemoryPanel";
import { InsightsPanel } from "./components/InsightsPanel";
import { AutomationsPanel, type AutomationRecord } from "./components/AutomationsView";
import { TaskComposer } from "./components/TaskComposer";
import { TaskHistory, type TaskHistoryItem } from "./components/TaskHistory";
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
import { CommandPalette } from "./components/palette/CommandPalette";
import { SETTINGS_SECTION_LABELS } from "./components/settings-sections";
import { ShortcutsDialog, singleKeyShortcutsEnabled } from "./components/ShortcutsDialog";
import { useTheme } from "./components/ThemeProvider";
import { Tooltip } from "./components/Tooltip";
import { extractPendingApprovals, extractCompletedDiff, parseRepoName, readPromptParam, runsListUrl, statusChipClass, statusLabel } from "./ui-helpers";
import { createCompletionDrivenPoll, documentVisibilityPause } from "./polling";
import { useApprovalsState } from "./state/approvals";
import { useWorkspaceEvents } from "./state/workspace-events";
import type { AgentPrincipal, RetainedRun, StoredApproval, ToolRunRecord } from "./types";

function readNudgeFlag(owner: string, flag: "banner-dismissed" | "popup-shown"): boolean {
  try { return sessionStorage.getItem(`shiba:onboarding-nudge:${flag}:${owner}`) === "true"; }
  catch { return false; }
}
function rememberNudgeFlag(owner: string, flag: "banner-dismissed" | "popup-shown"): void {
  try { sessionStorage.setItem(`shiba:onboarding-nudge:${flag}:${owner}`, "true"); }
  catch { /* Keep this visit usable when browser storage is unavailable. */ }
}


const ORCHESTRATOR_AGENT = "coding-orchestrator";

// Guard for single-key shortcuts: never fire while the user is typing.
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el?.closest?.("input, textarea, select, [contenteditable]"));
}

function canInspectThreadRun(run: RetainedRun | undefined): boolean {
  return run !== undefined && !run.fromSharedStore && run.archivedAt === undefined;
}

function useRetainedRuns(
  refreshToken: number,
  sessionId: string,
  sessionApiAvailable: boolean,
  fullDetail: boolean,
  enabled: boolean,
): { runs: RetainedRun[]; error: string | null; detailReady: boolean; listSettled: boolean; runsSession: string | null } {
  const [runs, setRuns] = useState<RetainedRun[]>([]);
  // The session whose answer produced the rows on screen. Rows stay visible
  // while a new scope loads, so anything that builds a URL from a run must read
  // this rather than the newly selected session.
  const [runsSession, setRunsSession] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listSettled, setListSettled] = useState(false);
  // True once a full-payload response has landed while fullDetail was on.
  // Detail surfaces (the diff inspector) gate on it so a summary list can
  // never render as "this run has no diff".
  const [detailReady, setDetailReady] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setRuns([]); setError(null); setDetailReady(false);
      setRunsSession(null);
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
              setRunsSession(sessionId);
              setError(null);
              setDetailReady(fullDetail);
              setListSettled(true);
            }
            return;
          }
          // Only the scope still on screen may fall back to an unscoped read;
          // a stale 405 must not pull the default store into a newer selection.
          if (cancelled) return;
          sessionScoped = false;
          url = runsListUrl(sessionId, false, fullDetail);
          response = await fetch(url);
        }
        if (!response.ok) throw new Error(`Runs request failed: ${response.status}`);
        const body = (await response.json()) as { runs?: RetainedRun[] };
        if (!cancelled) {
          setRuns(Array.isArray(body.runs) ? body.runs : []);
          // An unscoped answer is the default session's own store.
          setRunsSession(sessionScoped ? sessionId : DEFAULT_THREAD_ID);
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

  return { runs: enabled ? runs : [], error: enabled ? error : null, detailReady: enabled && detailReady, listSettled, runsSession: enabled ? runsSession : null };
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
  | { agent: string; auth?: AuthMode; teamMember?: boolean }
  | { issue: IdentityIssue; message: string; auth?: AuthMode };

async function fetchIdentity(attempt = 0): Promise<IdentityResult> {
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
    if (attempt < 1) return fetchIdentity(attempt + 1);
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
  const body = (await res.json().catch(() => null)) as { agent?: unknown; auth?: unknown; teamMember?: unknown } | null;
  if (
    body === null ||
    res.status === 404 ||
    res.status === 502 ||
    res.status === 503 ||
    res.status === 504
  ) {
    if (attempt < 1) return fetchIdentity(attempt + 1);
    return { issue: "unreachable", message: `GET /api/whoami returned ${res.status}.` };
  }
  if (!res.ok) return { issue: "error", message: `GET /api/whoami failed with ${res.status}.` };
  const auth: AuthMode | undefined =
    body.auth === "better-auth" || body.auth === "access" || body.auth === "none"
      ? body.auth
      : undefined;
  return typeof body.agent === "string" && body.agent !== ""
    ? { agent: body.agent, auth, teamMember: body.teamMember === true }
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
const DEFAULT_VIEW: MainView = "tasks";
/**
 * A bare /settings/ lands on Overview; an explicit ?section= deep-link keeps its section.
 * normalizeSettingsSection validates the requested section against the settings nav.
 */
function settingsSectionFromSearch(search: string): string {
  return normalizeSettingsSection(new URLSearchParams(search).get("section") || "overview");
}
/** Views that render their own MainCard, so the shell must not add a second one. */
const SELF_CARDED_VIEWS: readonly string[] = ["dashboard", "activity", "analytics", "diff", "approvals", "automations", "providers", "spaces", "integrations"];
/** Views that work inside a team workspace; every other view is personal-only. */
const TEAM_WORKSPACE_VIEWS: readonly string[] = ["dashboard", "team", "work", "threads", "collaboration", "custom-agents", "skills", "providers", "integrations", "settings"];

// Room/run links retain precedence over a view selector, including legacy /app links.
function viewFromUrl(): AppNavView | null {
  if (typeof window === "undefined") return null;
  const search = window.location.search;
  const params = new URLSearchParams(search);
  if (readRoomLink(search) !== null || params.has("run") || readPromptParam(search).prompt !== null) return "threads";
  return readNavigationView(window.location.pathname, search);
}

// WorkView writes ?view=/?task= itself; app state only seeds from them and follows back/forward.
const WORK_VIEW_MODES: readonly WorkViewMode[] = ["list", "board", "timeline", "organization"];
function workViewFromUrl(): WorkViewMode {
  if (typeof window === "undefined") return "list";
  const view = new URLSearchParams(window.location.search).get("view");
  return WORK_VIEW_MODES.find((mode) => mode === view) ?? "list";
}

const SETUP_TOTAL_STEPS = 6;
const ANALYTICS_RUN_PARAM = "inspectRun";

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
  const [invitationToken, setInvitationToken] = useState(() => {
    if (typeof window === "undefined") return "";
    const params = new URLSearchParams(window.location.hash.slice(1));
    const token = params.get("invite") ?? "";
    return /^[a-f0-9]{64}$/.test(token) ? token : "";
  });
  useEffect(() => {
    if (new URLSearchParams(window.location.hash.slice(1)).has("invite")) {
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    }
  }, []);
  const [mainView, setMainView] = useState<MainView>(() => {
    const view = viewFromUrl();
    return view ?? DEFAULT_VIEW;
  });
  const currentNavigation = useRef({ view: mainView });
  if (currentNavigation.current.view !== mainView) currentNavigation.current = { view: mainView };
  const [repoUrl, setRepoUrl] = useState("");
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [baseBranch, setBaseBranch] = useState("main");
  // Read the prompt without consuming it during render: StrictMode and route
  // retries must see the same entry intent until the component commits.
  const [task, setTask] = useState(() => {
    if (typeof window === "undefined") return "";
    return readPromptParam(window.location.search).prompt ?? "";
  });
  useEffect(() => {
    const { prompt, nextSearch } = readPromptParam(window.location.search);
    if (prompt !== null) {
      const nextUrl = window.location.pathname + nextSearch + window.location.hash;
      window.history.replaceState(window.history.state, "", nextUrl);
    }
  }, []);
  const latestComposerTask = useRef(task);
  latestComposerTask.current = task;
  const [selectedOnboardingDraftRef, setSelectedOnboardingDraftRef] = useState<OnboardingDraftRef | null>(null);
  const latestSelectedDraftRef = useRef(selectedOnboardingDraftRef);
  latestSelectedDraftRef.current = selectedOnboardingDraftRef;
  const selectedOnboardingTaskText = useRef<string | null>(null);
  const initialComposerPrompt = useRef(task);
  const initialVideoHandoff = useRef(typeof window !== "undefined" && readPromptParam(window.location.search).createVideo === true);
  const [videoHandoffScope, setVideoHandoffScope] = useState<string | null>(null);
  const consumeVideoHandoff = useCallback(() => setVideoHandoffScope(null), []);
  const [pendingOnboardingDraft, setPendingOnboardingDraft] = useState<SelectedOnboardingDraft | null>(null);
  const [incomingSlackTask, setIncomingSlackTask] = useState<IncomingTaskDraft | null>(null);
  const [publishPullRequest, setPublishPullRequest] = useState(false);
  const [reviewAfterPublish, setReviewAfterPublish] = useState(true);
  const [runSetup, setRunSetup] = useState(false);
  const [computerDraftScope, setComputerDraftScope] = useState<string | null>(null);
  const [harness, setHarness] = useState("opencode");
  const taskRouteChosen = useRef(false);
  const [customAgentId, setCustomAgentId] = useState("");
  const [workspaceEmployee, setWorkspaceEmployee] = useState<CustomAgentWire | null>(null);
  const [agentDetailsOpen, setAgentDetailsOpen] = useState(() => typeof window !== "undefined" && window.innerWidth >= 1280);
  // A bot page can be open without its conversation: the bot has no thread yet,
  // or its thread did not answer. Both are their own states — the surface shows
  // the bot and one Start action, and the previous bot's thread chrome, composer
  // and draft stay off screen.
  const [botPage, setBotPage] = useState<"chat" | "pending" | "empty" | "unavailable">("chat");
  /** Why this bot page has no conversation, when the reason is more specific than "no thread". */
  const [botPageMessage, setBotPageMessage] = useState<string | null>(null);
  // Every selection takes a ticket; an answer that arrives after a newer
  // selection threw its ticket away is dropped.
  const sessionSelectionSeq = useRef(0);
  const [employeeOnboardingDismissed, setEmployeeOnboardingDismissed] = useState(() => {
    try { return localStorage.getItem(ONBOARDING_DISMISSED_KEY) === "true"; } catch { return false; }
  });
  const dismissEmployeeOnboarding = () => {
    try { localStorage.setItem(ONBOARDING_DISMISSED_KEY, "true"); } catch { /* The current session can still dismiss it. */ }
    setEmployeeOnboardingDismissed(true);
  };
  const [projectContextId, setProjectContextId] = useState("");
  const [initialEmployeeId, setInitialEmployeeId] = useState<string | null>(null);
  const [toolPolicyIntent, setToolPolicyIntent] = useState<{ scope: string; employeeId: string } | null>(null);
  const [initialEmployeeTemplateId, setInitialEmployeeTemplateId] = useState<EmployeeTemplate["id"] | null>(null);
  const [codingModel, setCodingModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | "">("");
  const [envVars, setEnvVars] = useState<{ name: string; value: string }[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [attachments, setAttachments] = useState<RunAttachment[]>([]);
  const [attachmentsUploading, setAttachmentsUploading] = useState(false);
  const attachmentsUploadingRef = useRef(false);
  const attachmentsRef = useRef<RunAttachment[]>([]);
  attachmentsRef.current = attachments;
  const [refreshToken, setRefreshToken] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [cancellingRunId, setCancellingRunId] = useState<string | null>(null);
  const cancellingRunRef = useRef<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [showClearModal, setShowClearModal] = useState(false);
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const { resolvedTheme, setTheme } = useTheme();
  const theme = (resolvedTheme === "light" ? "light" : "dark") as "dark" | "light";
  const toggleTheme = () => setTheme(theme === "dark" ? "light" : "dark");

  useEffect(() => {
    document.title = "Shiba · Hire AI employees you own";
  }, []);

  // Surface transient notices through the toast channel (aria-live inside sonner).
  useEffect(() => {
    if (notice) toast(notice);
  }, [notice]);
  const [showOnboardingModal, setShowOnboardingModal] = useState(false);
  const [memoryView, setMemoryView] = useState<"facts" | "sources" | "sessions">("facts");
  const [memoryCounts, setMemoryCounts] = useState<Partial<MemoryCounts>>({});
  const [mailboxFolder, setMailboxFolder] = useState("inbox");
  const [mailboxAddress, setMailboxAddress] = useState("");
  const [mailboxCounts, setMailboxCounts] = useState<Partial<MailboxCounts>>({});
  const [mailboxes, setMailboxes] = useState<MailboxPanelItem[]>([]);
  // Stable callbacks: inline ones retrigger the child loaders on every render (refetch loop).
  const handleMailboxesChange = useCallback((items: { label?: string | null }[]) => {
    setMailboxes((items as MailboxPanelItem[]).map((item) => ({ ...item, label: item.label ?? undefined })));
  }, []);
  const handleMemoryCountsChange = useCallback((counts: Partial<MemoryCounts>) => {
    setMemoryCounts((current) => (Object.entries(counts).every(([k, v]) => current[k as keyof MemoryCounts] === v) ? current : { ...current, ...counts }));
  }, []);
  const [selectedAutomationId, setSelectedAutomationId] = useState<string | null>(null);
  const [repeatSource, setRepeatSource] = useState<RoutineSource | null>(null);
  const [automationDraft, setAutomationDraft] = useState<{ prompt: string; repoUrl: string } | null>(null);
  const [automationList, setAutomationList] = useState<AutomationRecord[]>([]);
  // Settings is a full page; the section lives in ?section= and "Back to app" returns to the previous view.
  const [settingsSection, setSettingsSection] = useState<string>(() =>
    settingsSectionFromSearch(typeof window === "undefined" ? "" : window.location.search));
  const previousViewRef = useRef<MainView>(DEFAULT_VIEW);
  const clearRoomIntentRef = useRef<() => void>(() => {});
  const [analyticsRunId, setAnalyticsRunId] = useState<string | null>(() =>
    mainView === "analytics" && typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get(ANALYTICS_RUN_PARAM)
      : null,
  );
  const openView = useCallback((view: AppNavView) => {
    if (view !== "threads") clearRoomIntentRef.current();
    setShowFirstRun(false);
    setAnalyticsRunId(null);
    if (view === "custom-agents") setWorkspaceEmployee(null);
    if (view === "settings") previousViewRef.current = currentNavigation.current.view === "settings" ? previousViewRef.current : currentNavigation.current.view;
    setMainView(view);
  }, []);
  useEffect(() => { if (mainView !== "custom-agents") setWorkspaceEmployee(null); }, [mainView]);
  const closeSettings = useCallback(() => {
    setMainView((view) => (view === "settings" ? previousViewRef.current : view));
  }, []);
  // Once visited, the mailbox stays mounted (hidden) — its local state
  // (search text, selected thread, drafts) survives nav switches.
  const [inboxMounted, setInboxMounted] = useState(mainView === "inbox");
  if (mainView === "inbox" && !inboxMounted) setInboxMounted(true);
  const [setupDone, setSetupDone] = useState<number | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const openRunInAnalytics = useCallback((runId: string) => {
    openView("analytics");
    setSelectedRunId(runId);
    setAnalyticsRunId(runId);
  }, [openView]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("default");
  // A thread link is applied only once the registry confirms this viewer may open
  // it. Until then the composer stays shut: a draft restored into a socket that
  // still belongs to the default conversation would be filed in the wrong thread.
  const [pendingThreadLink, setPendingThreadLink] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const linked = readThreadLink(window.location.search);
    return linked && linked !== "invalid" && linked.threadId !== "default" ? linked.threadId : null;
  });
const [taskHistoryItems, setTaskHistoryItems] = useState<TaskHistoryItem[]>([]);
  const [taskHistoryError, setTaskHistoryError] = useState<string | null>(null);
  const [taskHistoryLoading, setTaskHistoryLoading] = useState(false);
  const [conversationMode, setConversationModeState] = useState<ConversationMode>(() => readConversationMode("default"));
  useEffect(() => {
    setConversationModeState(readConversationMode(selectedSessionId));
  }, [selectedSessionId]);
  const setConversationMode = useCallback((mode: ConversationMode) => {
    setConversationModeState(mode);
    writeConversationMode(selectedSessionId, mode);
  }, [selectedSessionId]);

  // Local runs use the authenticated paired fleet in both web and desktop.
  const [runTarget, setRunTarget] = useState<"sandbox" | "local">("sandbox");
  const [appToolsWork, setAppToolsWork] = useState(false);
  const [executionTargetKind, setExecutionTargetKind] = useState<"repository" | "artifact-workspace">("repository");
  const [artifactWorkspaceName, setArtifactWorkspaceName] = useState("My workspace");
  const [artifactDeliverables, setArtifactDeliverables] = useState("deliverables/brief.md");
  const { status: desktopStatus } = useDesktopStatus();
  // Only these harnesses run locally; anything else would show as a
  // deployment pin the backend then refuses.
  useEffect(() => {
    if (runTarget === "local" && executionTargetKind === "repository" && !customAgentId && !["opencode", "claude-code", "codex"].includes(harness))
      setHarness("opencode");
  }, [runTarget, harness, customAgentId, executionTargetKind]);
  const [sessionApiAvailable, setSessionApiAvailable] = useState(false);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  // Whose session list last settled: a ?prompt= handoff waits for this identity's.
  const [sessionsSettledFor, setSessionsSettledFor] = useState<string | null>(null);
  // The link is unconfirmed until the registry answers, so nothing may be sent yet.
  const threadLinkPending = pendingThreadLink !== null;
  const [webSessions, setWebSessions] = useState<WebThread[]>([]);
  // History navigation restores a thread from its link without a resume round trip.
  const webSessionsRef = useRef<WebThread[]>([]);
  webSessionsRef.current = webSessions;
  const selectedSessionIdRef = useRef<string>(selectedSessionId);
  selectedSessionIdRef.current = selectedSessionId;
  const [sessionRegistryOwner, setSessionRegistryOwner] = useState<string | null>(null);
  const [sessionRegistryAnswer, setSessionRegistryAnswer] = useState<{ actor: string | null; failed: boolean } | null>(null);

  // Uploads belong to one session; drop results that arrive after switching threads.
  const attachmentsGeneration = useRef(0);
  useEffect(() => {
    attachmentsGeneration.current += 1;
    attachmentsRef.current = [];
    setAttachments([]);
  }, [selectedSessionId]);

  const attachFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0 || attachmentsUploadingRef.current) return;
      const generation = attachmentsGeneration.current;
      attachmentsUploadingRef.current = true;
      setAttachmentsUploading(true);
      try {
        for (const file of files) {
          if (generation !== attachmentsGeneration.current) return;
          const current = attachmentsRef.current;
          if (current.length >= MAX_RUN_ATTACHMENTS) {
            setNotice(`A run takes at most ${MAX_RUN_ATTACHMENTS} attachments.`);
            continue;
          }
          if (file.size > MAX_RUN_ATTACHMENT_BYTES) {
            setNotice(`Attachment ${file.name} must be at most ${MAX_RUN_ATTACHMENT_BYTES} bytes.`);
            continue;
          }
          if (current.reduce((sum, a) => sum + a.size, 0) + file.size > MAX_RUN_ATTACHMENTS_TOTAL_BYTES) {
            setNotice(`Attachments must total at most ${MAX_RUN_ATTACHMENTS_TOTAL_BYTES} bytes.`);
            continue;
          }
          const uploadUrl = sessionApiAvailable
            ? `/api/runs/attachments?name=${encodeURIComponent(file.name)}&session=${encodeURIComponent(selectedSessionId)}`
            : `/api/runs/attachments?name=${encodeURIComponent(file.name)}`;
          try {
            const res = await fetch(uploadUrl, {
              method: "POST",
              headers: { "content-type": "application/octet-stream" },
              body: file,
            });
            const data = (await res.json().catch(() => ({}))) as Partial<RunAttachment> & { error?: string };
            if (generation !== attachmentsGeneration.current) return;
            if (!res.ok || !data.name || !data.sha256 || typeof data.size !== "number") {
              setNotice(data.error ?? `Failed to upload ${file.name} (${res.status}).`);
              continue;
            }
            if (attachmentsRef.current.some((a) => a.name === data.name)) {
              setNotice(`Two attachments are named ${data.name}.`);
              continue;
            }
            const next = [...attachmentsRef.current, { name: data.name, sha256: data.sha256, size: data.size }];
            attachmentsRef.current = next;
            setAttachments(next);
          } catch (error) {
            if (generation !== attachmentsGeneration.current) return;
            setNotice(`Failed to upload ${file.name}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      } finally {
        attachmentsUploadingRef.current = false;
        setAttachmentsUploading(false);
      }
    },
    [selectedSessionId, sessionApiAvailable],
  );

  const removeAttachment = useCallback((name: string) => {
    const next = attachmentsRef.current.filter((a) => a.name !== name);
    attachmentsRef.current = next;
    setAttachments(next);
  }, []);
  // Persistent workspace panel removed from the thread view; functionality promoted to standalone views.
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
  const [globalSessionsCollapsed, setGlobalSessionsCollapsed] = useState(() =>
    typeof window !== "undefined"
      ? localStorage.getItem("shiba:sidebar-collapsed") === "true"
      : false,
  );
  const [personalThreadsCollapsed, setPersonalThreadsCollapsed] = useState(() =>
    typeof window !== "undefined"
      ? localStorage.getItem("shiba:personal-threads-sidebar-collapsed") === "true"
      : false,
  );
  const [workPanelCollapsed, setWorkPanelCollapsed] = useState(() =>
    typeof window !== "undefined"
      ? localStorage.getItem("shiba:work-panel-collapsed") === "true"
      : false,
  );
  const [workViewMode, setWorkViewMode] = useState<WorkViewMode>(workViewFromUrl);
  const [workInspectionRequest, setWorkInspectionRequest] = useState<WorkSearchState>();
  useEffect(() => {
    if (mainView !== "work") setWorkInspectionRequest(undefined);
  }, [mainView]);

  const toggleWorkPanelCollapsed = useCallback(() => {
    setWorkPanelCollapsed((current) => {
      const next = !current;
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem("shiba:work-panel-collapsed", String(next));
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

  // The first sync rewrites a legacy /app/ URL in place (query kept for any reader); later view changes are history steps.
  const router = useRouter();
  const workSearchReplace = useRef(false);
  // Back/Forward inside Work restores a selector without changing any loaded data.
  const [workLocationTick, setWorkLocationTick] = useState(0);
  // What the server answered for decisions taken here, so a receipt never claims more than it recorded.
  const [storedDecisionReceipts, setStoredDecisionReceipts] = useState<Record<string, { kind?: string; result: string }>>({});
  const applyWorkSelection = useCallback((state: WorkSearchState, mode: "push" | "replace") => {
    const search = new URLSearchParams(window.location.search);
    search.delete("run");
    search.delete("prompt");
    const query = updateWorkSearch(search, state).toString();
    // The receipt belongs in the URL before the route changes: a route remount
    // restores the same inspector instead of depending on transient React state.
    const target = `${pathForView("work")}?${query}${window.location.hash}`;
    // A replace (bridge or fallback) lands through Work's own URL writer, so the
    // address never names an inspector the screen has not switched to yet.
    if (mode === "replace") workSearchReplace.current = true;
    else if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== target) router.history.push(target);
    setWorkViewMode(state.view);
    setWorkInspectionRequest(state);
  }, [router]);
  const writeWorkSearch = useCallback((state: WorkSearchState, restore: boolean) => {
    const query = updateWorkSearch(new URLSearchParams(window.location.search), state).toString();
    // TanStack may still be flushing a handoff from Threads;
    // Work search always belongs to the canonical Work path.
    const target = `${pathForView("work")}${query ? `?${query}` : ""}${window.location.hash}`;
    if (target === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
    const replace = restore || workSearchReplace.current;
    workSearchReplace.current = false;
    if (replace) router.history.replace(target);
    else router.history.push(target);
  }, [router]);
  const inspectWork = useCallback((task: string, taskKind: "approval" | "run", tab: "approval" | "steps") => {
    applyWorkSelection({ view: "board", task, taskKind, tab }, "push");
    setMainView("work");
  }, [applyWorkSelection]);

  const submitFailed = useRef(false);
  const submitInFlight = useRef(false);
  // Same request body => same commandId, so a retried POST dedupes server-side.
  const runCommand = useRef<{ key: string; id: string; executionTarget: DashboardExecutionTargetFields["executionTarget"] } | null>(null);
  const clearInFlight = useRef(false);
  const [decisions, setDecisions] = useState<Record<string, boolean>>({});
  const [approvalAnnouncement, setApprovalAnnouncement] = useState("");

  // /api/runs routes by Access identity; the chat socket must use the same
  // DO name or the dashboard would read one identity's runs and chat to another.
  const [orchestratorName, setOrchestratorName] = useState<string | null>(testAgentName);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [identityIssue, setIdentityIssue] = useState<IdentityIssue | null>(null);
  // Which auth lane proved (or refused) the identity — drives the login
  // surface (better-auth form vs Access reload) and the sign-out control.
  const [authMode, setAuthMode] = useState<AuthMode | null>(null);
  const [restrictedTeamMember, setRestrictedTeamMember] = useState(false);
  // Bumping this re-runs the whoami check (retry timer, "Retry now", wake-up).
  const [identityAttempt, setIdentityAttempt] = useState(0);
  const identityFailures = useRef(0);
  const verifiedAccount = useRef<string | null>(null);
  const retryIdentity = useCallback(() => setIdentityAttempt((n) => n + 1), []);
  const signedIn = orchestratorName !== null && identityIssue === null;
  useEffect(() => {
    if (signedIn) return startDashboardObservability();
  }, [signedIn]);
  const teamIdentityAvailable = signedIn && /^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/.test(orchestratorName ?? "");
  const teamDirectory = useTeamWorkspaceDirectory({ actorId: teamIdentityAvailable ? orchestratorName?.trim().toLowerCase() ?? null : null, enabled: teamIdentityAvailable });
  const roomRoute = useRoomLinkRoute(teamIdentityAvailable ? orchestratorName?.trim().toLowerCase() ?? null : null, teamDirectory);
  useEffect(() => {
    clearRoomIntentRef.current = roomRoute.clearIntent;
  }, [roomRoute.clearIntent]);
  const workspaceAuthorityReady = roomRoute.ready && (!teamIdentityAvailable || teamDirectory.verified);
  const teamWorkspaceId = teamDirectory.selectedWorkspaceId;
  const toolPolicyScope = JSON.stringify([orchestratorName, teamWorkspaceId]);
  useEffect(() => {
    setToolPolicyIntent((intent) => mainView === "employee-tools" && intent?.scope === toolPolicyScope ? intent : null);
  }, [mainView, toolPolicyScope]);
  const openEmployeeToolPolicy = (employeeId?: string) => {
    setToolPolicyIntent(employeeId ? { scope: toolPolicyScope, employeeId } : null);
    openView("employee-tools");
  };
  const personalThreads = mainView === "threads" && !teamWorkspaceId;
  const sessionsCollapsed = personalThreads ? personalThreadsCollapsed : globalSessionsCollapsed;
  const toggleSessionsCollapsed = useCallback(() => {
    const setCollapsed = personalThreads ? setPersonalThreadsCollapsed : setGlobalSessionsCollapsed;
    setCollapsed((current) => {
      const next = !current;
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem(personalThreads ? "shiba:personal-threads-sidebar-collapsed" : "shiba:sidebar-collapsed", String(next));
        } catch {
          // Ignore storage quota or access errors in private mode
        }
      }
      return next;
    });
  }, [personalThreads]);
  // The rail toggle and the keyboard shortcut collapse whichever sidebar the current view shows.
  const toggleActiveSidebar = mainView === "work" ? toggleWorkPanelCollapsed : toggleSessionsCollapsed;
  const urlSynced = useRef(false);
  const syncedView = useRef<MainView | null>(null);
  const historyTraversal = useRef(false);
  // Only a navigation the person asked for adds a history step. Restoring a
  // remembered thread, falling back from a dead link and pruning a deleted one
  // replace the entry, so the first Back press goes somewhere real.
  const threadUrlMode = useRef<"push" | "replace">("replace");
  const pushThreadUrl = useCallback(() => { threadUrlMode.current = "push"; }, []);

  useEffect(() => {
    const first = !urlSynced.current;
    const viewChanged = syncedView.current !== mainView;
    // A traversal restored this address itself; rewriting or pushing over it
    // would spend the Forward entry on a duplicate.
    const traversing = historyTraversal.current;
    historyTraversal.current = false;
    syncedView.current = mainView;
    const base = pathForView(mainView);
    if (mainView === "settings") {
      const params = new URLSearchParams(first ? window.location.search : "");
      params.set("section", settingsSection);
      const target = `${base}?${params.toString()}${first ? window.location.hash : ""}`;
      if (window.location.pathname + window.location.search + window.location.hash === target) { urlSynced.current = true; return; }
      if (first || window.location.pathname === base) router.history.replace(target);
      else router.history.push(target);
      urlSynced.current = true;
      return;
    }
    if (mainView === "threads") {
      // A shared room — and a team workspace, where every thread is a room —
      // carries its own link; a private session id never goes in that address.
      const shared = Boolean(teamWorkspaceId) || readRoomLink(window.location.search) !== null;
      // An unconfirmed private link keeps the address it arrived with; rewriting
      // it now would drop the selector the reader just followed. A shared
      // destination has nothing to confirm and drops the stray selector at once.
      if (threadLinkPending && !shared) { urlSynced.current = true; return; }
      // A resume from Chat must keep the previous entry intact for Back.
      if (botPage === "pending" && !shared && !viewChanged) return;
      // Query state belongs to the view that set it, so a view change starts
      // clean — except when the browser itself restored the query.
      const kept = traversing || first || !viewChanged ? window.location.search : "";
      // A bot page with no thread has no conversation to point at, so it keeps no
      // session selector in the address.
      const query = withThreadLink(kept, shared || botPage !== "chat" ? null : selectedSessionId);
      const path = query ? `${base}?${query}` : base;
      const push = !traversing && ((viewChanged && !first) || threadUrlMode.current === "push");
      threadUrlMode.current = "replace";
      urlSynced.current = true;
      if (window.location.pathname + window.location.search === path) return;
      if (push) router.history.push(path);
      else router.history.replace(path + window.location.hash);
      return;
    }
    if (mainView === "analytics") {
      urlSynced.current = true;
      if (traversing) return;
      const keep = first || !viewChanged;
      const params = new URLSearchParams(keep ? window.location.search : "");
      if (analyticsRunId) params.set(ANALYTICS_RUN_PARAM, analyticsRunId);
      else params.delete(ANALYTICS_RUN_PARAM);
      const query = params.toString();
      const target = `${base}${query ? `?${query}` : ""}${keep ? window.location.hash : ""}`;
      if (window.location.pathname + window.location.search + window.location.hash === target) return;
      if (first) router.history.replace(target);
      else router.history.push(target);
      return;
    }
    urlSynced.current = true;
    if (window.location.pathname === base) return;
    if (first) router.history.replace(base + window.location.search + window.location.hash);
    else router.history.push(base);
  }, [mainView, settingsSection, selectedSessionId, analyticsRunId, botPage, teamWorkspaceId, threadLinkPending, router]);

  useEffect(() => {
    const onPop = () => {
      historyTraversal.current = true;
      setWorkLocationTick((tick) => tick + 1);
      const view = viewFromUrl();
      setWorkViewMode(workViewFromUrl());
      setAnalyticsRunId(view === "analytics" ? new URLSearchParams(window.location.search).get(ANALYTICS_RUN_PARAM) : null);
      setMainView(view ?? DEFAULT_VIEW);
      if (view === "analytics") return;
      if (view === "settings") setSettingsSection(settingsSectionFromSearch(window.location.search));
      if (readRoomLink(window.location.search) !== null) return;
      const linked = readThreadLink(window.location.search);
      // A dead link — deleted, or never ours to open — restores the default
      // session and says why, instead of stranding Back/Forward on a thread
      // this viewer cannot see. Replacing the entry keeps Forward intact.
      const unavailable = linked === "invalid" || (linked !== null && linked.threadId !== DEFAULT_THREAD_ID &&
        !webSessionsRef.current.some((session) => session.id === linked.threadId));
      if (unavailable) {
        setSelectedSessionId(DEFAULT_THREAD_ID);
        writeRememberedSessionId(DEFAULT_THREAD_ID);
        setSelectedRunId(null);
        setNotice("That thread isn't available to you. It may belong to another workspace or have been deleted.");
        const query = withThreadLink(window.location.search, null);
        const path = `${pathForView("threads")}${query ? `?${query}` : ""}`;
        if (window.location.pathname + window.location.search !== path) router.history.replace(path + window.location.hash);
        return;
      }
      // A selector-less /threads/ is the default session, not "keep whatever is open".
      const target = linked?.threadId ?? (view === "threads" ? "default" : null);
      if (!target || target === selectedSessionIdRef.current) return;
      setSelectedSessionId(target);
      writeRememberedSessionId(target);
      setSelectedRunId(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [router]);
  useEffect(() => {
    // The personal task queue must never execute in a team workspace.
    if (teamWorkspaceId && mainView === "tasks") setMainView("work");
  }, [teamWorkspaceId, mainView]);
  // Entering Settings inside a team workspace lands on its only team section, not a personal-only notice.
  useEffect(() => {
    if (mainView === "settings" && teamWorkspaceId) setSettingsSection("team");
  }, [mainView, teamWorkspaceId]);
  // The directory forgets its selection when switching to Personal; keep the last team separately for the Workspace tab.
  useEffect(() => {
    if (teamWorkspaceId && orchestratorName) rememberLastTeamWorkspace(orchestratorName.trim().toLowerCase(), teamWorkspaceId);
  }, [teamWorkspaceId, orchestratorName]);
  const teamWorkspace = teamDirectory.workspaces.find(item => item.workspaceId === teamWorkspaceId);
  useEffect(() => {
    setMailboxCounts({});
    setMailboxes([]);
    setMemoryCounts({});
  }, [orchestratorName]);
  const currentSlackTask = incomingSlackTask?.workspaceId === teamWorkspaceId && incomingSlackTask.actorId === orchestratorName?.trim().toLowerCase() ? incomingSlackTask : null;
  useEffect(() => setIncomingSlackTask(null), [teamWorkspaceId, orchestratorName]);
  const privateDataEnabled = signedIn && workspaceAuthorityReady && !teamDirectory.error && !teamWorkspaceId && !restrictedTeamMember;
  const scope: Scope = teamWorkspaceId ? "workspace" : "personal";
  const handleScopeChange = (next: Scope) => {
    if (teamDirectory.loading) return;
    roomRoute.clear();
    if (next === "personal") { flushDraft(); teamDirectory.selectWorkspace(""); return; }
    const rememberedId = orchestratorName ? lastTeamWorkspace(orchestratorName.trim().toLowerCase()) : "";
    const remembered = rememberedId ? teamDirectory.workspaces.find((item) => item.workspaceId === rememberedId) : undefined;
    const target = remembered ?? (teamDirectory.workspaces.length === 1 ? teamDirectory.workspaces[0] : undefined);
    if (target) { flushDraft(); teamDirectory.selectWorkspace(target.workspaceId); } else openView("team");
  };
  setSavedLibraryActor(privateDataEnabled ? orchestratorName : null);
  const savedRepos = useSavedRepos(privateDataEnabled ? orchestratorName : null);
  const savedSkills = useSavedSkills(privateDataEnabled ? orchestratorName : null);
  const selectableSkills = privateDataEnabled ? savedSkills.skills.filter((skill) => skill.status === "active") : [];
  const visibleWebSessions = privateDataEnabled && sessionRegistryOwner === orchestratorName ? webSessions : [];
  const activeSurfaceKey = JSON.stringify([signedIn ? orchestratorName : null, teamWorkspaceId, privateDataEnabled]);
  const activeSurfaceScopeRef = useRef({ key: activeSurfaceKey });
  if (activeSurfaceScopeRef.current.key !== activeSurfaceKey) activeSurfaceScopeRef.current = { key: activeSurfaceKey };
  const slackTaskSurface = activeSurfaceScopeRef.current;
  const adoptSlackTask = (text: string) => {
    if (activeSurfaceScopeRef.current !== slackTaskSurface || !signedIn || !teamWorkspaceId || !orchestratorName || typeof text !== "string" || !text.trim()) return;
    setIncomingSlackTask({ id: crypto.randomUUID(), workspaceId: teamWorkspaceId, actorId: orchestratorName.trim().toLowerCase(), text });
    setMainView("threads");
    setConversationMode("work");
  };
  const openSlackHandoff = (roomId: string, handoffId: string) => {
    if (activeSurfaceScopeRef.current !== slackTaskSurface || !signedIn || !teamWorkspaceId || !orchestratorName ||
      !/^room_[a-f0-9]{24}$/.test(roomId) || !/^scx_[a-f0-9]{32}$/.test(handoffId)) return;
    roomRoute.clear(); setIncomingSlackTask(null); setSharedRoomId(roomId); setSharedHandoffId(handoffId); setSharedEmployeeId(undefined);
    setShowFirstRun(false); setMainView("threads"); setConversationMode("work");
  };
  const stageTeamSetupTask = (draft: TeamOnboardingTask) => {
    if (activeSurfaceScopeRef.current !== slackTaskSurface || !signedIn || !teamWorkspaceId || !orchestratorName ||
      draft.workspaceId !== teamWorkspaceId || draft.actorId !== orchestratorName.trim().toLowerCase() || draft.expiresAt <= Date.now()) return;
    setIncomingSlackTask({ id: crypto.randomUUID(), workspaceId: draft.workspaceId, actorId: draft.actorId, text: draft.text,
      source: "team-onboarding", draftTaskId: draft.draftTaskId, draftTaskVersion: draft.draftTaskVersion, progressRevision: draft.progressRevision, expiresAt: draft.expiresAt });
    setSharedHandoffId(undefined); setSharedEmployeeId(undefined);
    setShowFirstRun(false); setMainView("threads"); setConversationMode("work");
  };
  const sharedRoomScope = JSON.stringify([orchestratorName, teamWorkspaceId]);
  const [sharedRoom, setSharedRoom] = useState<{ id: string; scope: string }>();
  const sharedRoomId = sharedRoom?.scope === sharedRoomScope ? sharedRoom.id : undefined;
  const [roomMention, setRoomMention] = useState<{ id: string; roomId: string; agentId: string; scope: string }>();
  const incomingRoomMention = roomMention?.scope === sharedRoomScope ? roomMention : undefined;
  const setSharedRoomId = useCallback((id: string | undefined) => {
    setSharedRoom((current) => {
      if (!id) return undefined;
      return current?.id === id && current.scope === sharedRoomScope ? current : { id, scope: sharedRoomScope };
    });
  }, [sharedRoomScope]);
  const [sharedHandoffId, setSharedHandoffId] = useState<string | undefined>();
  const [sharedEmployeeId, setSharedEmployeeId] = useState<string | undefined>();
  const sharedWork = useWorkTasks(signedIn ? orchestratorName : null, teamWorkspaceId, signedIn && (mainView === "work" || mainView === "dashboard" || mainView === "custom-agents"));
  useEffect(() => { setSharedHandoffId(undefined); setSharedEmployeeId(undefined); }, [teamWorkspaceId, orchestratorName]);
  const projectContexts = useProjectContexts(privateDataEnabled ? orchestratorName : null);
  useEffect(() => setProjectContextId(""), [signedIn, orchestratorName]);
  // Per-session composer draft: a scope change loads that scope's draft
  // instead of writing the old text into it; otherwise edits persist after 300 ms idle.
  const composerScope = privateDataEnabled && orchestratorName ? composerDraftScope(orchestratorName, selectedSessionId) : null;
  const useCloudComputer = runTarget === "sandbox" && computerDraftScope !== null && computerDraftScope === composerScope;
  useEffect(() => {
    setWorkInspectionRequest(undefined);
  }, [orchestratorName, teamWorkspaceId, selectedSessionId]);
  const quickDraft = useRef<{ scope: string; text: string } | null>(null);
  const draftScope = useRef<string | null>(null);
  const [restoredComposerScope, setRestoredComposerScope] = useState<string | null>(null);
  const composerVisible = composerScope !== null && restoredComposerScope === composerScope;
  const pendingDraft = useRef<{ ownerId: string; scope: string; text: string; onboardingDraft: OnboardingDraftRef | null } | null>(null);
  const flushDraft = useCallback(() => {
    const pending = pendingDraft.current;
    pendingDraft.current = null;
    if (pending) writeDraft(pending.scope, pending.text, pending.onboardingDraft, pending.ownerId);
  }, []);
  useEffect(() => {
    // A ?prompt= handoff waits for the session list: a remembered or linked
    // thread decides which composer it lands in.
    if (composerScope && initialComposerPrompt.current && sessionsSettledFor !== orchestratorName) return;
    if (draftScope.current !== composerScope) {
      flushDraft(); // the old scope's unwritten keystrokes land before switching
      const handoff = composerScope ? initialComposerPrompt.current : "";
      const keepCurrentTask = !handoff && draftScope.current === null && composerScope !== null && task !== "";
      draftScope.current = composerScope;
      setRestoredComposerScope(composerScope);
      const quick = quickDraft.current?.scope === composerScope ? quickDraft.current : null;
      const saved = composerScope ? readDraft(composerScope) : "";
      // The handoff joins an unsent draft below it instead of replacing it.
      const withHandoff = saved.trim() && saved !== handoff ? `${saved}\n\n${handoff}` : handoff;
      const restored = quick ? quick.text : handoff ? withHandoff : keepCurrentTask ? task : saved;
      quickDraft.current = null;
      if (composerScope) {
        if (handoff && !quick && initialVideoHandoff.current) {
          setVideoHandoffScope(composerScope);
          setConversationMode("chat");
        }
        initialComposerPrompt.current = "";
        initialVideoHandoff.current = false;
      }
      selectedOnboardingTaskText.current = restored;
      setTask(restored);
      if (composerScope && handoff) writeDraft(composerScope, restored, null, orchestratorName ?? "");
      setSelectedOnboardingDraftRef(composerScope && !keepCurrentTask && !handoff ? readDraftReference(composerScope) : null);
      return;
    }
    if (!composerScope) return;
    if (quickDraft.current?.scope === composerScope && quickDraft.current.text === task) quickDraft.current = null;
    const linked = task === selectedOnboardingTaskText.current ? selectedOnboardingDraftRef : null;
    if (selectedOnboardingDraftRef && !linked) setSelectedOnboardingDraftRef(null);
    pendingDraft.current = { ownerId: orchestratorName ?? "", scope: composerScope, text: task, onboardingDraft: linked };
    // An emptied composer (submit or clear) flushes now; typing waits for 300 ms idle.
    if (!task.trim()) return flushDraft();
    const timer = window.setTimeout(flushDraft, 300);
    return () => window.clearTimeout(timer);
  }, [composerScope, sessionsSettledFor, task, selectedOnboardingDraftRef, flushDraft, setConversationMode]);
  // A failed submit restores its text only into the session it came from.
  const restoreDraft = useCallback((scope: string, text: string, reference?: OnboardingDraftRef | null) => {
    if (draftScope.current === scope) {
      if (latestComposerTask.current !== "" && latestComposerTask.current !== text) return;
      const selected = latestSelectedDraftRef.current;
      if (selected && (selected.draftTaskId !== reference?.draftTaskId || selected.version !== reference?.version)) return;
      selectedOnboardingTaskText.current = text;
      setSelectedOnboardingDraftRef(reference ?? null);
      setTask((current) => (current === "" ? text : current));
    } else if (!readDraft(scope)) writeDraft(scope, text, reference);
  }, []);
  const {
    agents: customAgentRecords,
    refresh: refreshCustomAgents,
    applyAgent: applyCustomAgentRecord,
    loading: customAgentsLoading,
    error: customAgentsError,
  } = useCustomAgentOptions(signedIn && workspaceAuthorityReady && !teamDirectory.error, teamWorkspaceId || undefined, orchestratorName ?? undefined);
  const firstRunSeed = useFirstRunSeed({ actorId: orchestratorName, enabled: signedIn && workspaceAuthorityReady && !teamDirectory.error && !restrictedTeamMember });
  // The seed may add a workspace and starter agents; reload both lists so they appear without a page refresh.
  const handledSeed = useRef<object | null>(null);
  useEffect(() => {
    const seeded = firstRunSeed.result;
    if (!seeded || handledSeed.current === seeded) return;
    handledSeed.current = seeded;
    if (seeded.createdWorkspace) void teamDirectory.refresh();
    if (seeded.createdAgents.length > 0) refreshCustomAgents();
  }, [firstRunSeed.result, teamDirectory.refresh, refreshCustomAgents]);
  const customAgentPickerOptions = useMemo(
    () =>
      customAgentRecords.map((agent) => ({
        id: agent.id,
        name: agent.config.name,
        slug: agent.slug,
        emoji: agent.config.emoji,
        mascotPreset: agent.config.mascotPreset,
        avatar: agent.config.avatar,
        look: agent.config.look,
        roleTemplateId: agent.config.roleTemplateId,
        expectedDeliverables: agent.config.expectedDeliverables,
      })),
    [customAgentRecords],
  );
  const workEmployees: OrganizationEmployee[] = useMemo(
    () =>
      customAgentRecords.map((record) => ({
        id: record.id,
        name: record.config.name,
        role: employeeRoleLabel(employeeRole(record.slug, record.config.roleTemplateId)) || "Employee",
        emoji: record.config.emoji,
        slug: record.slug,
        config: record.config,
      })),
    [customAgentRecords],
  );
  useEffect(() => { setWorkspaceEmployee(null); }, [teamWorkspaceId]);
  const {
    localRunAvailable,
    targetMachineId: selectedLocalMachineId,
    computers: localComputers,
    paired: pairedLocalComputers,
    loading: localComputersLoading,
    error: localComputersError,
    selectMachine: selectLocalMachine,
    refresh: refreshLocalComputers,
  } = useLocalRunTarget({
    harness: customAgentId ? customAgentRecords.find((profile) => profile.id === customAgentId)?.config.harness ?? "" : harness,
    desktopStatus,
    enabled: privateDataEnabled,
    identityKey: orchestratorName ?? "",
  });
  const [launchBlocked, setLaunchBlocked] = useState(false);
  const [toolSetup, setToolSetup] = useState<SetupStatus["toolSetup"] | null>(null);
  const [chatLookupIds, setChatLookupIds] = useState<ChatLookupId[]>([]);
  useEffect(() => {
    setChatLookupIds((current) => current.includes("browser") ? current.filter((id) => id !== "browser") : current);
  }, [orchestratorName, selectedSessionId]);
  const chatLookups = useMemo(() => chatLookupOptions(toolSetup ?? null, chatLookupIds), [toolSetup, chatLookupIds]);
  // The lookup toggles must not change the submit callback's identity after mount:
  // StrictMode render retries restore the composer draft against it.
  const chatLookupsRef = useRef(chatLookups);
  chatLookupsRef.current = chatLookups;
  // Deployment-reported provider readiness for the guided journey. These are the
  // same reads the composer gates a launch on; no key or token value lands here.
  const [providerReadiness, setProviderReadiness] = useState<{
    ready: boolean;
    pending: boolean;
    /** The read failed; the guide offers a retry instead of claiming "not connected". */
    error: boolean;
    label: string | null;
    findings: { severity: string; message: string; fix?: string }[];
  }>({ ready: false, pending: true, error: false, label: null, findings: [] });
  // Bumped when something outside this render can change readiness: a provider
  // screen mutation, the guide reopening, or the window regaining focus.
  const [providerReadinessRevision, setProviderReadinessRevision] = useState(0);
  const refreshProviderReadiness = useCallback(() => setProviderReadinessRevision((value) => value + 1), []);
  // Which guided-journey stage the person is looking at; null follows the
  // derived resume point, so a satisfied stage is never re-asked.
  const [journeyStage, setJourneyStage] = useState<JourneyStepId | null>(null);
  useEffect(() => {
    if (!privateDataEnabled) {
      setLaunchBlocked(false);
      return;
    }
    let cancelled = false;
    const read = (path: string) =>
      fetch(path, { credentials: "same-origin", cache: "no-store" }).then((response) => {
        if (!response.ok) throw new Error(`${path} answered ${response.status}`);
        return response.json() as Promise<unknown>;
      });
    void Promise.all([read("/api/setup/status"), read("/api/providers")])
      .then(([setup, providers]) => {
        if (cancelled) return;
        setToolSetup((setup as SetupStatus | null)?.toolSetup ?? null);
        const gateway = Boolean(
          setup && typeof setup === "object" && (setup as { gateway?: { token?: boolean } }).gateway?.token,
        );
        const list =
          providers && typeof providers === "object"
            ? (providers as { providers?: { label?: string; connection?: { phase?: string } }[] }).providers
            : undefined;
        const connected = Array.isArray(list) && list.some((provider) => provider.connection?.phase === "connected");
        setLaunchBlocked(!gateway && !connected);
        const connectedProvider = Array.isArray(list)
          ? list.find((provider) => provider.connection?.phase === "connected")
          : undefined;
        const findings =
          setup && typeof setup === "object"
            ? ((setup as { doctor?: { findings?: { severity: string; message: string; fix?: string }[] } }).doctor?.findings ?? [])
                .filter((finding) => finding.severity !== "ok")
            : [];
        setProviderReadiness({
          ready: gateway || Boolean(connectedProvider),
          pending: false,
          error: false,
          label: connectedProvider?.label ?? (gateway ? "this deployment's gateway" : null),
          findings,
        });
        const personalDefault = connectedTaskDefault(providers as AcpProvidersSnapshot | null);
        if (!taskRouteChosen.current) {
          setHarness(personalDefault?.harness ?? "opencode");
          setCodingModel(personalDefault?.defaultModel ?? "");
        }
      })
      .catch(() => {
        // A failed read says so; it never passes for "no provider configured" and
        // never silently keeps an older answer as if it were current.
        if (!cancelled) {
          setProviderReadiness((previous) => ({ ...previous, pending: false, error: true }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [privateDataEnabled, providerReadinessRevision]);
  // Readiness can change in another tab or in a provider flow this view does not
  // own, so a returning window re-asks instead of trusting the first answer.
  useEffect(() => {
    if (!privateDataEnabled) return;
    const recheck = () => {
      if (document.visibilityState === "visible") refreshProviderReadiness();
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [privateDataEnabled, refreshProviderReadiness]);
  // Header setup pill: count deployment-proven steps only after whoami.
  useEffect(() => {
    if (showOnboardingModal || !privateDataEnabled) return;
    let cancelled = false;
    detectSetupSteps()
      .then((found) => {
        if (!cancelled) setSetupDone(found.size);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [showOnboardingModal, privateDataEnabled]);
  // First-run progress belongs to the authenticated account; activation also
  // requires an explicitly approved artifact, not just setup dismissal/run completion.
  const [showFirstRun, setShowFirstRun] = useState(false);
  // Completed work this account already has outside onboarding means it is not a
  // first-run account. The runs read settles after the progress read, so the
  // answer is remembered and applied when it lands.
  const returningWorkRef = useRef(false);
  // Only a guide that opened itself is closed by a later runs read; a guide the
  // person opened from the rail or the account menu is theirs to keep open.
  const journeyAutoOpened = useRef(false);
  const [showLegacyFirstRun, setShowLegacyFirstRun] = useState(false);
  const [storedFirstRunProgress, setFirstRunProgress] = useState<FirstRunProgressSnapshot | null>(null);
  const [firstRunProgressOwner, setFirstRunProgressOwner] = useState<string | null>(null);
  const firstRunProgress = firstRunProgressOwner === orchestratorName ? storedFirstRunProgress : null;
  const [nudgeSession, setNudgeSession] = useState<{ owner: string; bannerDismissed: boolean; popupPending: boolean; popupOpen: boolean } | null>(null);
  const nudgeScope = useRef("");
  nudgeScope.current = JSON.stringify([orchestratorName, teamWorkspaceId, privateDataEnabled]);
  const nudgeStatus = firstRunProgress ? deriveOnboardingStatus(firstRunProgress) : null;
  const nudgeVisible = authMode === "better-auth" && privateDataEnabled && identityIssue !== "signin" &&
    !!orchestratorName && nudgeSession?.owner === orchestratorName && !!nudgeStatus && !nudgeStatus.complete &&
    !teamWorkspaceId && !showFirstRun && !showLegacyFirstRun && !showOnboardingModal;
  useEffect(() => {
    if (!nudgeVisible || !nudgeSession?.popupPending) return;
    rememberNudgeFlag(nudgeSession.owner, "popup-shown");
    setNudgeSession((session) => session ? { ...session, popupPending: false, popupOpen: true } : session);
  }, [nudgeVisible, nudgeSession]);
  const closeNudgePopup = () => setNudgeSession((session) => session ? { ...session, popupOpen: false } : session);
  const dismissNudgeBanner = () => {
    if (!orchestratorName) return;
    rememberNudgeFlag(orchestratorName, "banner-dismissed");
    setNudgeSession((session) => session ? { ...session, bannerDismissed: true } : session);
  };
  const firstRunProgressClient = useRef<OnboardingProgressClient | null>(null);
  if (!firstRunProgressClient.current) {
    firstRunProgressClient.current = new OnboardingProgressClient((input, init) => fetch(input, init), setFirstRunProgress);
  }
  const refreshFirstRunProgress = useCallback(async (): Promise<void> => {
    await firstRunProgressClient.current?.read();
  }, []);
  const updateFirstRunProgress = useCallback((body: FirstRunProgressUpdate): Promise<void> => {
    return firstRunProgressClient.current?.update(body) ?? Promise.reject(new Error("Onboarding progress client is unavailable."));
  }, []);
  const resumeFirstRunProgress = useCallback(() => updateFirstRunProgress({ action: "resume" }), [updateFirstRunProgress]);
  const saveFirstRunStep = useCallback((currentStep: FirstRunStepId) => updateFirstRunProgress({ action: "step", currentStep }), [updateFirstRunProgress]);
  const dismissFirstRunProgress = useCallback((currentStep: FirstRunStepId) => updateFirstRunProgress({ action: "dismiss", currentStep }), [updateFirstRunProgress]);
  const dismissOutcomeSetup = useCallback(() => updateFirstRunProgress({ action: "dismiss" }), [updateFirstRunProgress]);
  const openFirstRun = useCallback(() => {
    journeyAutoOpened.current = false;
    refreshProviderReadiness();
    setMainView("threads");
    setJourneyStage(null);
    if (authMode === "better-auth") setShowFirstRun(true);
    else setShowLegacyFirstRun(true);
  }, [authMode, refreshProviderReadiness]);
  const canonicalOnboardingDraft = firstRunProgress?.draftTask;
  const preparedOnboardingSelection: SelectedOnboardingDraft | null = firstRunProgress?.draftTaskId && canonicalOnboardingDraft?.preparedAt
    ? { draftTaskId: firstRunProgress.draftTaskId, version: canonicalOnboardingDraft.version, draftTask: canonicalOnboardingDraft } : null;
  const activeOnboardingRef = selectedOnboardingDraftRef && task === selectedOnboardingTaskText.current &&
    firstRunProgress?.draftTaskId === selectedOnboardingDraftRef.draftTaskId && canonicalOnboardingDraft?.version === selectedOnboardingDraftRef.version && canonicalOnboardingDraft.preparedAt
    ? selectedOnboardingDraftRef : null;
  const onboardingExecutionIssue = selectedOnboardingDraftRef && !activeOnboardingRef
    ? "The linked first task draft is unavailable or changed. Review and select its saved version, or remove the link before sending."
    : activeOnboardingRef && canonicalOnboardingDraft
    ? !canonicalOnboardingDraft.employeeId
      ? "Configure an employee, then choose it in the saved setup draft before starting this goal."
      : canonicalOnboardingDraft.employeeId !== customAgentId
        ? "Launch the employee selected in this goal before starting work."
        : customAgentRecords.find((profile) => profile.id === customAgentId)?.version !== canonicalOnboardingDraft.employeeVersion
          ? "The employee changed. Review its saved version in setup before starting this goal."
          : null
    : null;
  const applyOnboardingDraft = useCallback((selection: SelectedOnboardingDraft, replace = false) => {
    if (firstRunProgress?.draftTaskId !== selection.draftTaskId || firstRunProgress.draftTask?.version !== selection.version || !firstRunProgress.draftTask.preparedAt) {
      setNotice("The first task draft changed. Review its saved version before using it.");
      openFirstRun();
      return;
    }
    if (!composerScope) { setNotice("Sign in before selecting a task draft."); return; }
    const text = onboardingTaskText(firstRunProgress.draftTask);
    if (!replace && task.trim() && task !== text) {
      setPendingOnboardingDraft(selection); setShowFirstRun(false); setMainView("threads"); setConversationMode("work"); return;
    }
    const reference = { draftTaskId: selection.draftTaskId, version: selection.version };
    selectedOnboardingTaskText.current = text;
    setSelectedOnboardingDraftRef(reference);
    setTask(text);
    writeDraft(composerScope, text, reference);
    setPendingOnboardingDraft(null);
    setShowFirstRun(false);
    setMainView("threads");
    setConversationMode("work");
  }, [firstRunProgress, task, composerScope, openFirstRun, setConversationMode]);
  const resumeNudgeStep = async (step: OnboardingStepStatus): Promise<void> => {
    closeNudgePopup();
    const scope = nudgeScope.current;
    const navigation = currentNavigation.current;
    const stillCurrent = () => scope === nudgeScope.current && navigation === currentNavigation.current;
    const target = step.target;
    try {
      if (target.kind === "setup") {
        if (firstRunProgress?.draftTask?.currentStep !== target.outcomeStep) {
          await updateFirstRunProgress({ action: "save-draft", draftTask: { currentStep: target.outcomeStep } });
        }
        if (stillCurrent()) {
          // Open the guided flow on the stage that owns the answered step, not
          // on whatever the derived resume point would be.
          openFirstRun();
          setJourneyStage("task");
        }
      } else if (target.view === "custom-agents") {
        setInitialEmployeeTemplateId(firstRunProgress?.draftTask?.employeeTemplateId ?? null);
        openView("custom-agents");
      } else if ((target.view === "threads" || target.view === "work") && preparedOnboardingSelection) {
        applyOnboardingDraft(preparedOnboardingSelection);
      } else {
        openView(target.view);
      }
    } catch {
      if (stillCurrent()) setNotice("Setup could not be opened. Please try again.");
    }
  };
  useEffect(() => {
    if (authMode !== "better-auth" || !privateDataEnabled || orchestratorName === null) {
      firstRunProgressClient.current?.reset();
      setFirstRunProgressOwner(null);
      setNudgeSession(null);
      setShowFirstRun(false);
      return;
    }
    firstRunProgressClient.current?.reset();
    setFirstRunProgressOwner(orchestratorName);
    setNudgeSession({ owner: orchestratorName, bannerDismissed: readNudgeFlag(orchestratorName, "banner-dismissed"), popupPending: false, popupOpen: false });
    const navigation = currentNavigation.current;
    let cancelled = false;
    void firstRunProgressClient.current!.read().then((progress) => {
      if (!cancelled && progress) {
        // A prepared draft does not end the flow: the journey resumes at approval
        // and result. Only a recorded deliverable review or an explicit dismissal
        // stops it opening, and so does a completed run this account already has
        // outside onboarding — that check needs the runs read, which may land later.
        const show = progress.activatedAt === null && progress.dismissedAt === null && !returningWorkRef.current;
        const autoOpened = show && navigation === currentNavigation.current && navigation.view === "threads";
        setNudgeSession((session) => session?.owner === orchestratorName ? {
          ...session, popupPending: !autoOpened && !readNudgeFlag(orchestratorName, "popup-shown"),
        } : session);
        if (navigation === currentNavigation.current && navigation.view === "threads") {
          journeyAutoOpened.current = show;
          setShowFirstRun(show);
        }
      }
    }).catch(() => {
      if (!cancelled) {
        setFirstRunProgress(null);
        if (navigation === currentNavigation.current && navigation.view === "threads") {
          setShowFirstRun(true);
        }
      }
    });
    return () => { cancelled = true; };
  }, [authMode, orchestratorName, privateDataEnabled]);

  // Better-auth lane sign-out: clears the session cookie, then re-runs
  // whoami — the 401 that follows lands on AuthScreen again.
  const handleSignOut = useCallback(async () => {
    closeSettings();
    flushDraft();
    await authClient.signOut().catch(() => {});
    firstRunProgressClient.current?.reset();
    setTask(""); setSelectedOnboardingDraftRef(null); setPendingOnboardingDraft(null);
    setComputerDraftScope(null);
    setAutomationDraft(null);
    setWebSessions([]); setSessionRegistryOwner(null);
    setOrchestratorName(null);
    setAuthMode(null);
    setIdentityIssue("signin");
    retryIdentity();
  }, [retryIdentity, flushDraft]);
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    void fetchIdentity().then((result) => {
      if (cancelled) return;
      if ("agent" in result) {
        const account = result.agent.trim().toLowerCase();
        if (verifiedAccount.current !== null && verifiedAccount.current !== account) {
          // SDK chat and private third-party widgets own independent caches.
          // A new document clears all of them before another account can render.
          flushDraft();
          setSavedLibraryActor(null);
          setOrchestratorName(null);
          setIdentityIssue(null);
          setAuthMode(null);
          window.location.reload();
          return;
        }
        verifiedAccount.current = account;
        identityFailures.current = 0;
        setOrchestratorName(result.agent);
        setAuthMode(result.auth ?? null);
        setRestrictedTeamMember(result.teamMember === true);
        if (result.teamMember && !viewFromUrl()) setMainView("team");
        setIdentityError(null);
        setIdentityIssue(null);
        return;
      }
      setIdentityError(result.message);
      setIdentityIssue(result.issue);
      if (result.auth) setAuthMode(result.auth);
      if (result.issue === "signin" || result.issue === "unconfigured") return;
      const delay = Math.min(30_000, 1_000 * 2 ** identityFailures.current);
      identityFailures.current += 1;
      timer = window.setTimeout(() => setIdentityAttempt((n) => n + 1), delay);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [identityAttempt]);

  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  const refreshRuns = useCallback(() => setRefreshToken((token) => token + 1), []);
  // DO state broadcasts hint that runs/approvals changed: trailing 150 ms debounce,
  // at most one refetch per second, and a steady burst still fires within ~1 s.
  const invalidateTimer = useRef<number | undefined>(undefined);
  const invalidateSince = useRef<number | undefined>(undefined);
  const lastInvalidateRefresh = useRef(0);
  const invalidateSoon = useCallback(() => {
    const now = Date.now();
    invalidateSince.current ??= now;
    window.clearTimeout(invalidateTimer.current);
    const due = Math.max(lastInvalidateRefresh.current + 1000, Math.min(now + 150, invalidateSince.current + 1000));
    invalidateTimer.current = window.setTimeout(() => {
      invalidateTimer.current = undefined;
      invalidateSince.current = undefined;
      lastInvalidateRefresh.current = Date.now();
      refreshRuns();
    }, due - now);
  }, [refreshRuns]);
  useEffect(() => () => window.clearTimeout(invalidateTimer.current), []);

  const activeWebSession = visibleWebSessions.find((session) => session.id === selectedSessionId);
  const sessionCustomAgentId = threadAgentId(activeWebSession);
  useEffect(() => {
    // A bot page owns its bot. Pruning a dead thread resets the session to the
    // default one, and restoring the selected conversation's bot there would put
    // Shiba's name and Start action on the recovery surface of the bot the reader
    // actually opened.
    if (botPage !== "chat") return;
    // Also restore when the registry arrives after mount, not only on sidebar clicks.
    setCustomAgentId(sessionCustomAgentId);
  }, [selectedSessionId, sessionCustomAgentId, botPage]);
  const builtinTaskDefaults = useRef<{ harness: string; codingModel: string; connectionId: string; repoUrl: string; runTarget: "sandbox" | "local" } | null>(null);
  const applyThreadProfile = useCallback((profile: CustomAgentWire) => {
    taskRouteChosen.current = true;
    setHarness(profile.config.harness);
    setCodingModel(profile.config.codingModel ?? "");
    setConnectionId(profile.config.connectionId ?? "");
    setRepoUrl(profile.config.defaultRepoUrl ?? "");
    setPublishPullRequest(false);
    setRunTarget("sandbox");
  }, []);
  useAgentThreadDefaults(selectedSessionId, sessionCustomAgentId, customAgentRecords, applyThreadProfile);
  const chatAgentName = activeWebSession?.agentName ?? orchestratorName;
  const chatAgentNameRef = useRef(chatAgentName);
  chatAgentNameRef.current = chatAgentName;
  const agent = useAgent({
    agent: ORCHESTRATOR_AGENT,
    // Until /api/whoami resolves, don't connect at all — the Worker 403s any
    // name that isn't the caller's identity, so a placeholder DO name just
    // produces a 403 burst on every load.
    name: chatAgentName ?? "identity-pending",
    enabled: privateDataEnabled,
    onStateUpdate: invalidateSoon,
    minReconnectionDelay: 1000,
    maxReconnectionDelay: 30_000,
  });
  useSocketLiveness(agent, privateDataEnabled, invalidateSoon);
  const chat = useAgentChat({
    agent,
    // Skip the /get-messages prefetch while the DO name is the pending
    // placeholder — it 403s by design. The socket object lags one render
    // behind a thread switch (it swaps in an effect), so gate on the active
    // base or named-session agent and discard responses from a previous thread.
    getInitialMessages: ({ name, url }) => !privateDataEnabled ? Promise.resolve([]) : loadThreadMessages(name, url, chatAgentNameRef),
    onError: () => {
      submitFailed.current = true;
    },
  });
  const receiveRoomMessage = useCallback((message: ConversationRoomMessage) => {
    chat.setMessages((current) => current.some((item) => item.id === message.messageId)
      ? current
      : [...current, {
          id: message.messageId,
          role: "user",
          metadata: { shibaRoomViewerId: message.viewerId, shibaPeerChat: true },
          parts: [{ type: "text", text: message.text }],
        }]);
  }, [chat.setMessages]);
  const conversationRealtime = useConversationRoomRealtime({
    sessionId: selectedSessionId,
    enabled: privateDataEnabled && mainView === "work",
    typingText: task,
    messages: chat.messages,
    onMessage: receiveRoomMessage,
  });
  const {
    viewerId: realtimeViewerId,
    status: realtimeStatus,
    viewers: realtimeViewers,
    remoteStream: realtimeRemoteStream,
    startStream: startRealtimeStream,
    finishStream: finishRealtimeStream,
  } = conversationRealtime;
  const { runsById } = useAgentToolEvents({ agent });
  const appToolsContext = useMemo(() => ({
    sessionId: selectedSessionId,
    session: activeWebSession,
    sessionAvailable: sessionApiAvailable && sessionsLoaded && sessionRegistryOwner === orchestratorName,
    employeeId: customAgentId,
    profile: customAgentRecords.find((profile) => profile.id === customAgentId),
    profilesUnavailable: customAgentsLoading || Boolean(customAgentsError),
    socketName: agent.name,
    connected: orchestratorName !== null && agent.identified && !agent.connectionError && agent.readyState === 1,
    hasPreparedContext: Boolean(activeOnboardingRef && !onboardingExecutionIssue),
  }), [selectedSessionId, activeWebSession, sessionApiAvailable, sessionsLoaded, sessionRegistryOwner, orchestratorName, customAgentId, customAgentRecords, customAgentsLoading, customAgentsError, agent.name, agent.identified, agent.connectionError, agent.readyState, activeOnboardingRef, onboardingExecutionIssue]);

  useEffect(() => {
    if (!privateDataEnabled) {
      setSessionsLoaded(true);
      setSessionRegistryAnswer(null);
      return;
    }
    setSessionsLoaded(false);
    let cancelled = false;
    let answer: { actor: string | null; failed: boolean } | null = null;
    fetch("/api/sessions", { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => {
        // Older backends have no sessions API: stay on the implicit default
        // session and use unscoped run routes instead of erroring.
        if (response.status === 404 || response.status === 405) {
          answer = { actor: orchestratorName, failed: false };
          if (!cancelled) setSessionApiAvailable(false);
          return;
        }
        // A signed-out page must not toast a 401. whoami owns the sign-in screen.
        if (response.status === 401) return;
        if (!response.ok) throw new Error(`Sessions request failed: ${response.status}`);
        const body = (await response.json()) as {
          sessions?: WebThread[];
        };
        answer = { actor: orchestratorName, failed: false };
        if (!cancelled) {
          setSessionRegistryOwner(orchestratorName);
          setSessionApiAvailable(true);
          const nextSessions = Array.isArray(body.sessions) ? body.sessions : [];
          setWebSessions(nextSessions);
          // A link outranks the remembered thread, and only a listed thread opens.
          const linked = readThreadLink(window.location.search);
          const linkedId = linked && linked !== "invalid" ? linked.threadId : null;
          const restoredSessionId = linkedId
            ? resolveLinkedThread(linkedId, nextSessions)
            : resolveRememberedSessionId(readRememberedSessionId(), nextSessions);
          setSelectedSessionId(restoredSessionId);
          setPendingThreadLink(null);
          writeRememberedSessionId(restoredSessionId);
          if (linkedId && restoredSessionId !== linkedId) {
            setNotice("That thread isn't available to you. It may belong to another workspace or have been deleted.");
          }
          // The mount-time fetch can run pre-auth (e.g. AuthScreen up); once a
          // later attempt succeeds, drop the failure it toasted.
          setNotice((n) => (n?.startsWith("Sessions request failed") ? null : n));
        }
      })
      .catch((error: unknown) => {
        answer = { actor: orchestratorName, failed: true };
        if (!cancelled) setNotice(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) {
          setSessionsLoaded(true);
          setSessionsSettledFor(orchestratorName);
          setSessionRegistryAnswer(answer);
          setPendingThreadLink(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [privateDataEnabled, orchestratorName]);
  // Inspectors need the retained details; other surfaces use the summary projection.
  const { runs: fetchedRuns, error: runsError, detailReady: runsDetailReady, listSettled, runsSession } =
    useRetainedRuns(
      refreshToken,
      selectedSessionId,
      sessionApiAvailable,
      mainView === "diff" || mainView === "work",
      privateDataEnabled,
    );
  // Rows outlive the session they were read from, so every consumer reads this
  // one gated list: while another session's answer is pending, a run from the
  // previous session is not on screen to be linked, reviewed or measured.
  const runsStale = runsSession !== null && runsSession !== selectedSessionId;
  const retainedRuns = runsStale ? [] : fetchedRuns;
  const legacyWorkSettled = listSettled && retainedRuns.some((candidate) => !candidate.draftTaskId && candidate.status === "completed");
  returningWorkRef.current = returningWorkRef.current || legacyWorkSettled;
  // A late runs read closes a guide that opened itself, never one the person
  // opened or navigated in.
  useEffect(() => {
    if (!listSettled) return;
    const opens = shouldOpenJourney({
      activated: firstRunProgress?.activatedAt != null,
      dismissed: firstRunProgress?.dismissedAt != null,
      hasSettledRun: legacyWorkSettled,
    });
    if (opens) return;
    if (!journeyAutoOpened.current) return;
    journeyAutoOpened.current = false;
    setShowFirstRun(false);
  }, [listSettled, legacyWorkSettled, firstRunProgress?.activatedAt, firstRunProgress?.dismissedAt]);
  useEffect(() => {
    if (!privateDataEnabled) {
      setTaskHistoryItems([]); setTaskHistoryError(null); setTaskHistoryLoading(false);
      return;
    }
    if (mainView !== "threads") return;
    let cancelled = false;
    let generation = 0;
    setTaskHistoryLoading(true);
    const scopeQuery = sessionApiAvailable && selectedSessionId !== "default"
      ? `?session=${encodeURIComponent(selectedSessionId)}`
      : "";
    const load = async () => {
      const current = ++generation;
      try {
        const refreshQuery = scopeQuery ? `${scopeQuery}&refresh=${refreshToken}` : `?refresh=${refreshToken}`;
        const response = await fetch(`/api/tasks${refreshQuery}`);
        const body = await response.json().catch(() => ({})) as { tasks?: TaskHistoryItem[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? `Task history request failed: ${response.status}`);
        if (!cancelled && current === generation) {
          setTaskHistoryItems(Array.isArray(body.tasks) ? body.tasks : []);
          setTaskHistoryError(null);
        }
      } catch (error: unknown) {
        if (!cancelled && current === generation) setTaskHistoryError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled && current === generation) setTaskHistoryLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [refreshToken, selectedSessionId, sessionApiAvailable, privateDataEnabled, mainView]);
  const approvalsEnabled =
    privateDataEnabled && (mainView === "approvals" || mainView === "tasks" || mainView === "threads" || mainView === "dashboard" || mainView === "work" || mainView === "diff");
  const workspaceEventsEnabled =
    Boolean(teamWorkspaceId) && (mainView === "tasks" || mainView === "work" || mainView === "threads");
  const workspaceLive = useWorkspaceEvents({
    workspaceId: teamWorkspaceId || null,
    enabled: workspaceEventsEnabled,
    onEvent: (event) => { if (event.kind.startsWith("run.") || event.kind.startsWith("approval.") || event.kind.startsWith("ask_user.")) refreshRuns(); },
    onReconnect: refreshRuns,
  });
  const {
    approvals: storedApprovals,
    decided: decidedStoredApprovals,
    error: storedApprovalsError,
    settled: storedApprovalsSettled,
    loaded: storedApprovalsLoaded,
  } = useApprovalsState(refreshToken, approvalsEnabled, workspaceLive);
  // An approval receipt resolves to its own linked run from the URL alone, so a
  // refresh, Back or a fresh tab lands where the original decision did. Exact
  // approvalId match only: no substitute run, and nothing to replay.
  useEffect(() => {
    if (mainView !== "work" || !privateDataEnabled) return;
    const state = parseWorkSearch(new URLSearchParams(window.location.search));
    if (!state.task || state.taskKind === "run" || state.taskKind === "session") return;
    // Only an approved run-kind receipt can be superseded by its run, and only
    // when exactly one retained run claims it; anything else stays on the receipt.
    // Run-only evidence waits for a successful approvals read: until then the
    // receipt's kind and outcome are unknown, not absent.
    const local = storedDecisionReceipts[state.task];
    if (!local && !storedApprovalsLoaded) return;
    const recorded = storedApprovals.find((item) => item.approvalId === state.task) ??
      decidedStoredApprovals.find((item) => item.approvalId === state.task);
    const kind = local ? local.kind : recorded?.kind;
    const approved = local ? local.result !== "rejected" : recorded ? recorded.status === "approved" : true;
    if (!approved || (kind !== undefined && kind !== "run")) return;
    const linked = retainedRuns.filter((item) => item.approval?.approvalId === state.task);
    if (linked.length !== 1) return;
    applyWorkSelection({ view: state.view, task: linked[0]!.runId, taskKind: "run", tab: "steps" }, "replace");
  }, [mainView, retainedRuns, storedApprovals, decidedStoredApprovals, storedDecisionReceipts, storedApprovalsLoaded, workLocationTick, privateDataEnabled, applyWorkSelection]);
  const reviewAfterPublishById = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const approval of storedApprovals) {
      if (approval.reviewAfterPublish) map[approval.approvalId] = true;
    }
    return map;
  }, [storedApprovals]);
  const agentPrincipals = useAgentPrincipals(
    refreshToken,
    privateDataEnabled && (mainView === "tasks" || mainView === "threads" || mainView === "dashboard" || mainView === "work"),
  );

  const toolRuns = useMemo(() => Object.values(runsById) as ToolRunRecord[], [runsById]);

  const pendingApprovals = useMemo(
    () => extractPendingApprovals(chat.messages, storedApprovals),
    [chat.messages, storedApprovals],
  );

  // A chat-queued approval's DO pointer is the same record — the chat
  // card is the decision surface, so stored pointers already shown as
  // chat cards must not double-render or double-count in badges.
  const visibleStoredApprovals = useMemo(() => {
    const chatIds = new Set(pendingApprovals.map((approval) => approval.approvalId));
    return storedApprovals.filter((approval) => !chatIds.has(approval.approvalId));
  }, [storedApprovals, pendingApprovals]);

  // A queued run carries the conversation that owns it. The thread header speaks
  // for one thread, so another thread's approval must not mark it as needing you.
  const threadStoredApprovals = useMemo(
    () => visibleStoredApprovals.filter((approval) => approval.threadKey === chatAgentName),
    [visibleStoredApprovals, chatAgentName],
  );

  const decidedRef = useRef<Set<string>>(new Set());
  const decidedStoredRef = useRef<Set<string>>(new Set());

  // Waking from background or regaining network: reconnect now instead of
  // waiting out the socket's backoff, and refetch runs/approvals/identity.
  useEffect(() => { setShowClearModal(false); setShowOnboardingModal(false); setRepeatSource(null); }, [orchestratorName, teamWorkspaceId]);
  const hiddenAt = useRef<number | null>(null);
  useEffect(() => {
    const revive = (force: boolean) => {
      if (privateDataEnabled && (force || agent.readyState !== WebSocket.OPEN)) agent.reconnect();
      refreshRuns();
      retryIdentity();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt.current = Date.now();
        return;
      }
      const hiddenFor = hiddenAt.current === null ? 0 : Date.now() - hiddenAt.current;
      hiddenAt.current = null;
      // iOS freezes background sockets without closing them, so readyState can lie.
      revive(hiddenFor > 15_000);
    };
    const onOnline = () => {
      setOnline(true);
      revive(true);
    };
    const onOffline = () => setOnline(false);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [agent, refreshRuns, retryIdentity, privateDataEnabled]);

  // Drop decision bookkeeping for approvals that no longer wait on us.
  useEffect(() => {
    const waiting = new Set(pendingApprovals.map((approval) => approval.approvalId));
    for (const id of Array.from(decidedRef.current)) {
      if (!waiting.has(id)) decidedRef.current.delete(id);
    }
    setDecisions((current) => {
      const next: Record<string, boolean> = {};
      let changed = false;
      for (const [id, approved] of Object.entries(current)) {
        if (waiting.has(id)) {
          next[id] = approved;
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [pendingApprovals]);

  // One synchronous guard per approvalId: duplicate clicks are inert, and the
  // guard clears when the part leaves "waiting-approval".
  const decideApproval = useCallback(
    async (approvalId: string, approved: boolean) => {
      if (decidedRef.current.has(approvalId)) return;
      decidedRef.current.add(approvalId);
      setDecisions((current) => ({ ...current, [approvalId]: approved }));
      const tool = pendingApprovals.find((item) => item.approvalId === approvalId)?.tool;
      try {
        await chat.addToolApprovalResponse({ id: approvalId, approved });
        setApprovalAnnouncement(
          tool === "browser_sign_in" ? (approved ? "Saved sign-in approved for this browser." : "Saved sign-in rejected. No saved credentials will be used.") :
          tool === "generate_video" ? `Video generation ${approved ? "approved. Paid provider generation is now permitted." : "rejected. No video will be generated."}` : `Task ${approved ? "approved" : "rejected"}. ${
            approved
              ? "Sandbox execution is now permitted."
              : "No sandbox will start for this tool call."
          }`,
        );
        setNotice(null);
      } catch (decisionError) {
        // Decision failed: buttons re-enable for a retry.
        decidedRef.current.delete(approvalId);
        setDecisions((current) => {
          const next = { ...current };
          delete next[approvalId];
          return next;
        });
        setNotice(
          `${approved ? "Approval" : "Rejection"} could not be recorded: ${
            decisionError instanceof Error ? decisionError.message : String(decisionError)
          }`,
        );
      }
    },
    [chat, pendingApprovals],
  );

  const [storedDecisions, setStoredDecisions] = useState<Record<string, boolean>>({});

  // Drop decision bookkeeping for stored approvals that left the list, but
  // never forget the receipt on screen: its linked run may not exist yet, and
  // forgetting it would clear the inspector and re-open the decision.
  useEffect(() => {
    const known = new Set([
      ...storedApprovals.map((approval) => approval.approvalId),
      ...decidedStoredApprovals.map((approval) => approval.approvalId),
    ]);
    const onScreen =
      typeof window !== "undefined"
        ? parseWorkSearch(new URLSearchParams(window.location.search)).task
        : null;
    const keep = (id: string) => known.has(id) || id === onScreen;
    for (const id of Array.from(decidedStoredRef.current)) {
      if (!keep(id)) decidedStoredRef.current.delete(id);
    }
    setStoredDecisions((current) => {
      const next: Record<string, boolean> = {};
      let changed = false;
      for (const [id, approved] of Object.entries(current)) {
        if (keep(id)) {
          next[id] = approved;
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
    setStoredDecisionReceipts((current) =>
      Object.keys(current).every(keep) ? current : Object.fromEntries(Object.entries(current).filter(([id]) => keep(id))),
    );
  }, [storedApprovals, decidedStoredApprovals]);

  // Decide a DO-state approval pointer: POST resolves it in place — the
  // frozen payload executes or the queued draft is released.
  const [claimConflicts, setClaimConflicts] = useState<Record<string, { actorId: string; branch: string; repo: string; runId: string }>>({});
  const decideStoredApproval = useCallback(
    async (approval: StoredApproval, approved: boolean, claimAction?: "queue" | "new_branch" | "cancel") => {
      const approvalId = approval.approvalId;
      if (!claimAction && decidedStoredRef.current.has(approvalId)) return;
      decidedStoredRef.current.add(approvalId);
      setStoredDecisions((current) => ({ ...current, [approvalId]: approved }));
      try {
        const response = await fetch("/api/approvals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadKey: approval.threadKey,
            approvalId,
            approved,
            ...(claimAction ? { claimAction } : {}),
          }),
        });
        const body = (await response.json().catch(() => ({}))) as {
          result?: string;
          error?: string;
          code?: string;
          conflict?: { actorId: string; branch: string; repo: string; runId: string };
        };
        if (response.status === 409 && body.code === "repo_claim_conflict" && body.conflict) {
          decidedStoredRef.current.delete(approvalId);
          setStoredDecisions((current) => {
            const next = { ...current };
            delete next[approvalId];
            return next;
          });
          setClaimConflicts((current) => ({ ...current, [approvalId]: body.conflict! }));
          setNotice("Someone is already working on this branch. Queue, start a new branch, or cancel.");
          return;
        }
        setClaimConflicts((current) => {
          if (!current[approvalId]) return current;
          const next = { ...current };
          delete next[approvalId];
          return next;
        });
        if (!response.ok) {
          throw new Error(body.error ?? `Approval request failed: ${response.status}`);
        }
        if (body.result === "unknown") {
          throw new Error("The approval is gone — it expired or was already decided elsewhere.");
        }
        // The receipt stays in the URL; the linked run is resolved from it on
        // every render, so no in-memory handoff can be lost to a refresh.
        setStoredDecisionReceipts((current) => ({
          ...current,
          [approvalId]: { kind: approval.kind, result: body.result ?? (approved ? "approved" : "rejected") },
        }));
        setApprovalAnnouncement(
          approved
            ? body.result === "queued"
              ? "Approved — the request is queued behind another run on this branch."
              : "Approved — the request is executing."
            : "Rejected — nothing will execute.",
        );
        setNotice(null);
      } catch (decisionError) {
        decidedStoredRef.current.delete(approvalId);
        setStoredDecisions((current) => {
          const next = { ...current };
          delete next[approvalId];
          return next;
        });
        setNotice(
          `${approved ? "Approval" : "Rejection"} could not be recorded: ${
            decisionError instanceof Error ? decisionError.message : String(decisionError)
          }`,
        );
      }
      refreshRuns();
    },
    [refreshRuns],
  );

  const submitTask = useCallback(
    async (event?: React.FormEvent, options?: { forceWork?: boolean; customAgentId?: string; create?: ChatCreateChoice }) => {
      if (threadLinkPending) return;
      // A bot page that is opening, empty or failed has no committed conversation
      // to send into; the keyboard shortcut reaches here too.
      if (botPage !== "chat" && !options?.customAgentId) return;
      const selectedCustomAgentId = options?.customAgentId ?? customAgentId;
      if (event) event.preventDefault();
      if (submitInFlight.current || clearInFlight.current || attachmentsUploadingRef.current) return;
      if (!composerScope || !composerVisible) { setNotice("Wait for your conversation draft to reconnect before sending."); return; }
      if (attachments.length > 0 && ((!options?.forceWork && conversationMode === "chat") || appToolsWork)) {
        setNotice("Attachments are supported for sandbox work tasks. Switch to Work mode or remove the files first.");
        return;
      }
      if (!options?.forceWork && conversationMode === "chat") {
        if (!task.trim()) {
          setNotice("Enter a message first.");
          return;
        }
        if (!orchestratorName || agent.connectionError || !agent.identified) {
          setNotice(
            `Message not sent: ${agent.connectionError
              ? `connection error: ${agent.connectionError.message ?? "unknown"}`
              : !orchestratorName
                ? "still resolving your agent identity"
                : "still connecting to the orchestrator"}.`,
          );
          return;
        }
        const draft = task;
        const draftSession = composerScope;
        setNotice(null);
        setTask("");
        submitInFlight.current = true;
        submitFailed.current = false;
        setIsSubmitting(true);
        try {
          const streamId = startRealtimeStream(draft.trim());
          try {
            await chat.sendMessage({
              text: draft.trim(),
              metadata: {
                shibaMode: "chat",
                shibaRoomViewerId: realtimeViewerId,
                ...(options?.create ? { shibaChatCreate: options.create } : {}),
                ...(selectedChatLookups(chatLookupsRef.current).length ? { shibaChatTools: selectedChatLookups(chatLookupsRef.current) } : {}),
              },
            });
            finishRealtimeStream(streamId, "complete");
          } catch (error) {
            finishRealtimeStream(streamId, "failed");
            throw error;
          }
          // The failed user turn remains in the transcript; retrying it must
          // regenerate that turn rather than append a duplicate user message.
          return true;
        } catch (error) {
          restoreDraft(draftSession, draft, activeOnboardingRef);
          setNotice(`Message could not be sent: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          submitInFlight.current = false;
          setIsSubmitting(false);
        }
        return;
      }
      if (selectedOnboardingDraftRef && !activeOnboardingRef) {
        setNotice("The linked first task draft is unavailable or changed. Review its saved version before sending.");
        return;
      }
      if (onboardingExecutionIssue) { setNotice(onboardingExecutionIssue); return; }
      if (appToolsWork) {
        if (chat.isStreaming || chat.status === "streaming" || chat.status === "submitted") {
          setNotice("Wait for the current app task to finish before sending another.");
          return;
        }
        const issue = appToolsWorkIssue(appToolsContext);
        if (issue || !task.trim()) {
          setNotice(issue ?? "Enter a task first.");
          return;
        }
        const draft = task;
        const draftSession = composerScope;
        submitInFlight.current = true;
        submitFailed.current = false;
        setIsSubmitting(true);
        setNotice(null);
        setTask("");
        try {
          await sendAppToolsWork(appToolsContext, draft, (message) => chat.sendMessage(message), activeOnboardingRef,
            selectableSkills.filter((skill) => selectedSkillIds.includes(skill.id)).map((skill) => ({ skillId: skill.id, version: skill.version })));
          if (submitFailed.current) restoreDraft(draftSession, draft, activeOnboardingRef);
        } catch (error) {
          restoreDraft(draftSession, draft, activeOnboardingRef);
          setNotice(`App task could not be sent: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          submitInFlight.current = false;
          setIsSubmitting(false);
        }
        return;
      }
      if (selectedCustomAgentId && (customAgentsLoading || customAgentsError || !customAgentRecords.some((profile) => profile.id === selectedCustomAgentId))) {
        setNotice(customAgentsLoading
          ? "Wait for the selected bot to load before sending."
          : "The selected bot is unavailable. Choose an available bot before sending.");
        return;
      }
      if (!task.trim() || (executionTargetKind === "repository" && !repoUrl.trim())) {
        setNotice(executionTargetKind === "repository" ? "Enter a repository URL and a task first." : "Enter a task first.");
        return;
      }
      const normalizedRepoUrl = normalizeRepositoryInput(repoUrl);
      if (executionTargetKind === "repository" && !normalizedRepoUrl) {
        setNotice(REPOSITORY_INPUT_ERROR);
        return;
      }
      const parsedArtifactDeliverables = parseArtifactDeliverables(artifactDeliverables);
      if (executionTargetKind === "artifact-workspace" && !parsedArtifactDeliverables.success) {
        setNotice("Use 1–8 safe relative .md, .txt, .json, or .csv output paths.");
        return;
      }
      const branch = baseBranch.trim() || "main";
      if (useCloudComputer && (teamWorkspaceId || envVars.some((entry) => entry.name.trim() !== ""))) {
        setNotice("Cloud computers are only available for private runs without environment variables.");
        return;
      }
      const effort =
        reasoningEffort && (HARNESS_REASONING_EFFORTS[harness] ?? []).includes(reasoningEffort)
          ? reasoningEffort
          : "";
      const attachedSkills = selectableSkills.filter((skill) => selectedSkillIds.includes(skill.id));
      if (runTarget === "local" || selectedCustomAgentId || executionTargetKind === "artifact-workspace") {
        if (runTarget === "local" && (!selectedLocalMachineId || localComputersLoading || localComputersError)) {
          setNotice(localComputersError ?? (localComputersLoading
            ? "Wait for paired computers to be checked before sending."
            : "Choose an online paired computer that supports this bot before sending."));
          return;
        }
        if (!sessionApiAvailable && selectedSessionId !== "default") {
          setNotice("This conversation cannot queue tasks until its session connection is available. Retry after reconnecting.");
          return;
        }
        const directTarget = runTarget === "local" ? "runs on this computer" : "cloud runs";
        if (envVars.some((v) => v.name.trim() !== "")) {
          setNotice(`Environment variables aren't supported for ${directTarget} yet.`);
          return;
        }
        if (runSetup) {
          setNotice(`Repo setup isn't supported for ${directTarget} yet.`);
          return;
        }
        if (attachments.length > 0) {
          setNotice("Attachments aren't supported for runs on this computer yet.");
          return;
        }
        setNotice(null);
        // A selected bot is already a configured execution route. Queue it
        // directly, just like a local task, without a separate planner call.
        // The Worker resolves its saved profile and requires human approval
        // of the frozen task before dispatching either runtime.
        const targetFields = executionTargetKind === "repository"
          ? buildExecutionTargetFields({ kind: "repository", repoUrl: normalizedRepoUrl ?? repoUrl.trim(), baseBranch: branch })
          : buildExecutionTargetFields({
              kind: "artifact-workspace",
              workspaceName: artifactWorkspaceName,
              expectedDeliverables: parsedArtifactDeliverables.success ? parsedArtifactDeliverables.data : [],
            });
        const fields = {
          ...targetFields,
          task: task.trim(),
          ...(activeOnboardingRef ? { draftTaskId: activeOnboardingRef.draftTaskId, draftTaskVersion: activeOnboardingRef.version } : {}),
          skillPins: attachedSkills.map((skill) => ({ skillId: skill.id, version: skill.version })),
          ...(harness ? { harness } : {}),
          ...(codingModel.trim() ? { codingModel: codingModel.trim() } : {}),
          ...(connectionId.trim() ? { connectionId: connectionId.trim() } : {}),
          ...(effort ? { reasoningEffort: effort } : {}),
          publishPullRequest,
          ...(useCloudComputer ? { computer: true } : {}),
          ...(publishPullRequest && reviewAfterPublish ? { reviewAfterPublish: true } : {}),
          ...(selectedCustomAgentId ? { customAgentId: selectedCustomAgentId } : {}),
          ...(projectContextId ? { projectContextId } : {}),
        };
        // A retry retains its command ID across daemon re-pairing, but a
        // different owner, conversation or runtime is a distinct command.
        // The automatic workspace ID is generated state, not changed intent.
        const keyTarget = fields.executionTarget.kind === "artifact-workspace" && fields.executionTarget.expectedDeliverables.length === 0
          ? { ...fields.executionTarget, workspaceId: undefined }
          : fields.executionTarget;
        const key = JSON.stringify({ ...fields, executionTarget: keyTarget, owner: orchestratorName, runtime: runTarget, session: selectedSessionId });
        if (runCommand.current?.key !== key) runCommand.current = { key, id: crypto.randomUUID(), executionTarget: fields.executionTarget };
        const commandId = runCommand.current.id;
        const body = {
          ...fields,
          executionTarget: runCommand.current.executionTarget,
          runtime: runTarget,
          ...(runTarget === "local" ? { targetMachineId: selectedLocalMachineId } : {}),
        };
        const draft = task;
        const draftSession = composerScope;
        const dispatchSurface = activeSurfaceScopeRef.current;
        setTask("");
        submitInFlight.current = true;
        setIsSubmitting(true);
        try {
          const res = await fetch(
            sessionApiAvailable
              ? `/api/runs?session=${encodeURIComponent(selectedSessionId)}`
              : "/api/runs",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ...body, commandId }),
            },
          );
          if (!res.ok) {
            const raw = await res.text().catch(() => "");
            let detail = raw.slice(0, 400);
            try {
              const parsed = JSON.parse(raw) as { error?: string };
              if (typeof parsed.error === "string" && parsed.error.trim()) detail = parsed.error.trim();
            } catch {
              /* plain text */
            }
            throw new Error(detail || `Run request failed with ${res.status}`);
          }
          const receipt = await res.json().catch(() => null) as { approvalId?: unknown } | null;
          const approvalId = typeof receipt?.approvalId === "string" && receipt.approvalId.trim() ? receipt.approvalId : null;
          if (!approvalId) throw new Error("The server did not return an approval receipt. Retry to recover the same request.");
          runCommand.current = null;
          if (useCloudComputer) setComputerDraftScope((scope) => scope === draftSession ? null : scope);
          if (executionTargetKind === "repository") saveRepo(normalizedRepoUrl ?? repoUrl.trim(), orchestratorName);
          setNotice(runTarget === "local"
            ? "Queued — approve the run card to execute on this computer."
            : executionTargetKind === "artifact-workspace"
              ? "Draft queued — review and approve the run card before the cloud sandbox starts."
              : "Bot task queued — review and approve the run card to launch it.");
          refreshRuns();
          if (draftScope.current === draftSession && activeSurfaceScopeRef.current === dispatchSurface && currentNavigation.current.view === "threads") {
            inspectWork(approvalId, "approval", "approval");
          }
        } catch (error) {
          restoreDraft(draftSession, draft, activeOnboardingRef);
          setNotice(
            `Run could not be queued: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          submitInFlight.current = false;
          setIsSubmitting(false);
        }
        return;
      }
      if (!orchestratorName) {
        setNotice(
          identityError
            ? `Task not sent: agent identity failed to resolve (${identityError}).`
            : "Task not sent: still resolving your agent identity.",
        );
        return;
      }
      // Without a live agent connection sendMessage resolves silently, so the
      // task would vanish as if it had been accepted.
      if (agent.connectionError || !agent.identified) {
        setNotice(
          `Task not sent: ${
            agent.connectionError
              ? `connection error: ${agent.connectionError.message ?? "unknown"}`
              : "still connecting to the orchestrator"
          }.`,
        );
        return;
      }
      let sealedEnv: { sealed: string; names: string[]; digest: string } | null = null;
      // Unnamed rows are dropped, like the direct-run guard above; parseRunEnv rejects a blank name.
      const namedEnvVars = envVars.filter((v) => v.name.trim() !== "");
      if (namedEnvVars.length > 0) {
        // Claim the submit before the seal round-trip so a double-click can't queue two runs.
        submitInFlight.current = true;
        setIsSubmitting(true);
        const sealFailed = (message: string) => {
          submitInFlight.current = false;
          setIsSubmitting(false);
          setNotice(message);
        };
        const sealUrl = sessionApiAvailable
          ? `/api/runs/env-seal?session=${encodeURIComponent(selectedSessionId)}`
          : "/api/runs/env-seal";
        try {
          const sealRes = await fetch(sealUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              environmentVariables: namedEnvVars.map((v) => ({
                name: v.name.trim(),
                value: v.value,
              })),
            }),
          });
          const sealData = (await sealRes.json().catch(() => ({}))) as {
            sealed?: string;
            names?: string[];
            digest?: string;
            error?: string;
          };
          if (!sealRes.ok) {
            sealFailed(sealData.error ?? `Failed to seal environment variables (${sealRes.status}).`);
            return;
          }
          if (!sealData.sealed || !sealData.digest || !Array.isArray(sealData.names)) {
            sealFailed("Failed to seal environment variables: invalid server response.");
            return;
          }
          sealedEnv = {
            sealed: sealData.sealed,
            names: sealData.names,
            digest: sealData.digest,
          };
        } catch (sealError) {
          sealFailed(
            `Failed to seal environment variables: ${
              sealError instanceof Error ? sealError.message : String(sealError)
            }`,
          );
          return;
        }
      }
      setNotice(null);
      const text = [
        `Repository: ${normalizedRepoUrl ?? repoUrl.trim()}`,
        `Base branch: ${branch}`,
        `Coding agent harness: ${harness}`,
        ...(codingModel.trim() ? [`Coding model: ${codingModel.trim()}`] : []),
        ...(effort ? [`Reasoning effort: ${effort}`] : []),
        ...(sealedEnv ? [`Environment variables: ${sealedEnv.names.join(", ")}`] : []),
        ...(runSetup ? ["Run repo setup: yes"] : []),
        ...(useCloudComputer ? ["Cloud computer: yes"] : []),
        ...(attachments.length ? [`Attachments: ${attachments.map((a) => a.name).join(", ")}`] : []),
        ...(connectionId.trim() ? [`Model connection: ${connectionId.trim()}`] : []),
        `Open a pull request with the result: ${publishPullRequest ? "yes" : "no"}`,
        ...(publishPullRequest
          ? [`Read-only review after the PR opens: ${reviewAfterPublish ? "yes" : "no"}`]
          : []),
        "",
        `Task: ${task.trim()}`,
      ].join("\n");
      const draft = task;
      const draftSession = composerScope;
      setTask("");
      submitInFlight.current = true;
      submitFailed.current = false;
      setIsSubmitting(true);
      try {
        // Structured copy of the composer fields so the approval card doesn't
        // depend on the LLM echoing them back from `text`.
        await chat.sendMessage({
          text,
          metadata: {
            shibaMode: "work",
            shibaTask: {
              repoUrl: normalizedRepoUrl ?? repoUrl.trim(),
              task: task.trim(),
              ...(activeOnboardingRef ? { draftTaskId: activeOnboardingRef.draftTaskId, draftTaskVersion: activeOnboardingRef.version } : {}),
              skillPins: attachedSkills.map((skill) => ({ skillId: skill.id, version: skill.version })),
              baseBranch: branch,
              harness,
              publishPullRequest,
              ...(publishPullRequest && reviewAfterPublish ? { reviewAfterPublish: true } : {}),
              ...(codingModel.trim() ? { codingModel: codingModel.trim() } : {}),
              ...(connectionId.trim() ? { connectionId: connectionId.trim() } : {}),
              ...(effort ? { reasoningEffort: effort } : {}),
              ...(sealedEnv ? { environment: { sealed: sealedEnv.sealed, digest: sealedEnv.digest } } : {}),
              ...(runSetup ? { runSetup: true } : {}),
              ...(useCloudComputer ? { computer: true } : {}),
              ...(selectedCustomAgentId ? { customAgentId: selectedCustomAgentId } : {}),
              ...(projectContextId ? { projectContextId } : {}),
              ...(attachments.length ? { attachments } : {}),
            },
          },
        });
        // onError already surfaces chat.error in the notice banner.
        if (submitFailed.current) {
          restoreDraft(draftSession, draft, activeOnboardingRef);
        } else {
          saveRepo(normalizedRepoUrl ?? repoUrl.trim(), orchestratorName);
          if (useCloudComputer) setComputerDraftScope((scope) => scope === draftSession ? null : scope);
          setEnvVars([]);
          attachmentsGeneration.current += 1;
          attachmentsRef.current = [];
          setAttachments([]);
          refreshRuns();
        }
      } catch (error) {
        restoreDraft(draftSession, draft, activeOnboardingRef);
        setNotice(
          `Task could not be sent: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        submitInFlight.current = false;
        setIsSubmitting(false);
      }
    },
    [
      repoUrl,
      baseBranch,
      task,
      conversationMode,
      appToolsWork,
      appToolsContext,
      activeOnboardingRef,
      composerScope,
      composerVisible,
      selectedOnboardingDraftRef,
      onboardingExecutionIssue,
      publishPullRequest,
      reviewAfterPublish,
      runSetup,
      useCloudComputer,
      attachments,
      harness,
      customAgentId,
      projectContextId,
      customAgentRecords,
      customAgentsLoading,
      customAgentsError,
      codingModel,
      reasoningEffort,
      envVars,
      connectionId,
      chat,
      realtimeViewerId,
      startRealtimeStream,
      finishRealtimeStream,
      agent,
      orchestratorName,
      identityError,
      refreshRuns,
      inspectWork,
      selectableSkills,
      selectedSkillIds,
      runTarget,
      teamWorkspaceId,
      executionTargetKind,
      artifactWorkspaceName,
      artifactDeliverables,
      sessionApiAvailable,
      selectedSessionId,
      threadLinkPending,
      selectedLocalMachineId,
      localComputersLoading,
      localComputersError,
      restoreDraft,
    ],
  );

  const confirmClearAll = useCallback(async () => {
    setShowClearModal(false);
    if (clearInFlight.current || submitInFlight.current) return;
    clearInFlight.current = true;
    setClearing(true);
    setNotice(null);
    let historyCleared = false;
    try {
      await chat.clearHistory();
      historyCleared = true;
      // Session-scoped delete only when the sessions API exists; never fall
      // back to an unscoped delete for a named session — that would wipe runs
      // belonging to other sessions.
      if (!sessionApiAvailable && selectedSessionId !== "default") {
        setNotice(
          "Conversation history cleared. Run registry is unchanged because this backend does not support session-scoped runs.",
        );
        return;
      }
      const response = await fetch(
        sessionApiAvailable
          ? `/api/runs?session=${encodeURIComponent(selectedSessionId)}`
          : "/api/runs",
        { method: "DELETE" },
      );
      if (sessionApiAvailable && (response.status === 404 || response.status === 405)) {
        // A real "Session not found." means the scoped session is gone — the
        // API still works; prune the stale item and land on the default
        // session instead of disabling session scoping globally.
        if (response.status === 404 && (await isSessionNotFoundBody(response))) {
          setWebSessions((current) =>
            current.filter((session) => session.id !== selectedSessionId),
          );
          setSelectedSessionId("default");
          writeRememberedSessionId("default");
          setNotice(
            "That session no longer exists — it was removed from the list. Conversation history cleared; run registry is unchanged.",
          );
          refreshRuns();
          return;
        }
        setSessionApiAvailable(false);
        setNotice(
          "Conversation history cleared. Run registry is unchanged because this backend does not support session-scoped runs.",
        );
        return;
      }
      if (!response.ok) throw new Error(`Runs clear failed: ${response.status}`);
      setNotice("Conversation history and run registry cleared.");
      refreshRuns();
    } catch (error) {
      setNotice(
        historyCleared
          ? "History cleared locally; run registry could not be cleared"
          : `History could not be cleared: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearInFlight.current = false;
      setClearing(false);
    }
  }, [chat, refreshRuns, selectedSessionId, sessionApiAvailable]);

  const cancelRun = useCallback(
    async (runId: string) => {
      if (cancellingRunRef.current !== null) return;
      cancellingRunRef.current = runId;
      setCancellingRunId(runId);
      try {
        let url = sessionApiAvailable
          ? `/api/runs/${encodeURIComponent(runId)}?session=${encodeURIComponent(selectedSessionId)}`
          : `/api/runs/${encodeURIComponent(runId)}`;
        let response = await fetch(url, { method: "DELETE" });
        // Scoped delete targets exactly one run; a backend that doesn't know
        // the session route can still cancel it unscoped. But a 404 JSON
        // {error:"Session not found."} means the session itself is gone —
        // prune it and land on the default session instead of disabling the
        // sessions API or firing an unscoped delete at another session's run.
        if ((response.status === 404 || response.status === 405) && sessionApiAvailable) {
          if (response.status === 404 && (await isSessionNotFoundBody(response))) {
            setWebSessions((current) =>
              current.filter((session) => session.id !== selectedSessionId),
            );
            setSelectedSessionId("default");
            writeRememberedSessionId("default");
            setNotice("That session no longer exists — it was removed from the list.");
            refreshRuns();
            return;
          }
          setSessionApiAvailable(false);
          url = `/api/runs/${encodeURIComponent(runId)}`;
          response = await fetch(url, { method: "DELETE" });
        }
        if (!response.ok) throw new Error(`Request failed: ${response.status}`);
        setNotice(`Cancellation requested for ${runId}.`);
        refreshRuns();
      } catch (error) {
        setNotice(
          `Cancellation could not be requested: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        cancellingRunRef.current = null;
        setCancellingRunId(null);
      }
    },
    [refreshRuns, selectedSessionId, sessionApiAvailable],
  );

  const retryTaskHistory = useCallback(async (taskId: string) => {
    const query = sessionApiAvailable && selectedSessionId !== "default"
      ? `?session=${encodeURIComponent(selectedSessionId)}`
      : "";
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/retry${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: crypto.randomUUID() }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Retry request failed: ${response.status}`);
      setNotice("Retry queued for approval. Review the new approval card before it runs.");
      refreshRuns();
    } catch (error) {
      setNotice(`Task retry could not be queued: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [refreshRuns, selectedSessionId, sessionApiAvailable]);

  const cancelTaskHistory = useCallback(async (taskId: string, attempt: number) => {
    const query = sessionApiAvailable && selectedSessionId !== "default"
      ? `?session=${encodeURIComponent(selectedSessionId)}`
      : "";
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/cancel${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attempt }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Cancellation failed: ${response.status}`);
      setNotice("Task cancellation recorded.");
      refreshRuns();
    } catch (error) {
      setNotice(`Task cancellation could not be completed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [refreshRuns, selectedSessionId, sessionApiAvailable]);

  // Keyboard shortcut listener: Cmd/Ctrl+Enter submits, Escape closes modals
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowClearModal(false);
        setShowShortcutsModal(false);
        setShowOnboardingModal(false);
        setMobileSessionsOpen(false);
        setMobileNavOpen(false);
        setCommandMenuOpen(false);
        return;
      }
      if (nudgeVisible && nudgeSession?.popupOpen) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandMenuOpen((prev) => !prev);
        return;
      }
      if (commandMenuOpen || showShortcutsModal || showClearModal || showOnboardingModal || showFirstRun) {
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        if (e.defaultPrevented) return;
        if (!isSubmitting && !attachmentsUploading && hasComposerInput({ task, repoUrl, executionTargetKind, conversationMode, appToolsWork })) {
          e.preventDefault();
          const chatForm = document.forms.namedItem("chat-message-composer");
          if (chatForm) chatForm.requestSubmit();
          else submitTask();
        }
        return;
      }
      if (isEditableTarget(e.target)) return;
      if (e.altKey && !e.metaKey && !e.ctrlKey && /^Digit[1-7]$/.test(e.code)) {
        const target = ([teamWorkspaceId ? "work" : "tasks", "custom-agents", "threads", "integrations", "inbox", "memory", "settings"] as const)[Number(e.code.slice(5)) - 1];
        if (target) { e.preventDefault(); openView(target); }
        return;
      }
      // WCAG 2.1.4: single-character shortcuts can be turned off in the shortcuts dialog.
      if (!e.metaKey && !e.ctrlKey && !e.altKey && !singleKeyShortcutsEnabled()) return;
      if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "c" || e.key === "C") && currentNavigation.current.view === "work") {
        const input = document.querySelector<HTMLInputElement>('input[placeholder*="Add a task"]');
        if (input) { e.preventDefault(); input.focus(); }
        return;
      }
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && currentNavigation.current.view === "threads") {
        const composer = document.querySelector<HTMLTextAreaElement>('[data-testid="task-composer"] textarea');
        if (composer) { e.preventDefault(); composer.focus(); }
        return;
      }
      if ((e.key === "j" || e.key === "k") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const list = sessionsNavRef.current;
        if (list.length === 0) return;
        e.preventDefault();
        const currentId = selectedNavIdRef.current;
        const index = list.findIndex((session) => session.id === currentId);
        const delta = e.key === "j" ? 1 : -1;
        const next = list[(index < 0 ? 0 : index + delta + list.length) % list.length];
        if (next) selectSessionRef.current(next.id);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "o" || e.key === "O")) {
        e.preventDefault();
        handleNewTaskRef.current();
      } else if ((e.metaKey || e.ctrlKey) && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        toggleActiveSidebar();
      } else if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        if (currentNavigation.current.view === "settings") closeSettings(); else openView("settings");
      } else if (e.key.toLowerCase() === "d" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        toggleTheme();
      } else if (e.key === "[") {
        e.preventDefault();
        toggleSessionsCollapsed();
      } else if (e.key === "?") {
        setShowShortcutsModal((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    isSubmitting,
    repoUrl,
    task,
    submitTask,
    executionTargetKind,
    conversationMode,
    appToolsWork,
    teamWorkspaceId,
    toggleActiveSidebar,
    toggleSessionsCollapsed,
    toggleTheme,
    closeSettings,
    openView,
    commandMenuOpen,
    nudgeVisible,
    nudgeSession?.popupOpen,
    showShortcutsModal,
    showClearModal,
    showOnboardingModal,
    showFirstRun,
  ]);

  const handleNewTaskRef = useRef<() => void>(() => {});
  const sessionsNavRef = useRef<SessionItem[]>([]);
  const selectedNavIdRef = useRef<string | null>(null);
  const selectSessionRef = useRef<(id: string) => void>(() => {});
  // First-seen time per live run: a stable createdAt so ordering doesn't churn.
  const firstSeen = useRef(new Map<string, number>());
  const seenAt = useCallback((runId: string) => {
    let at = firstSeen.current.get(runId);
    if (at === undefined) {
      at = Date.now();
      firstSeen.current.set(runId, at);
    }
    return at;
  }, []);

  const allRuns: VMRun[] = useMemo(() => {
    const map = new Map<string, VMRun>();
    for (const r of retainedRuns) {
      map.set(r.runId, {
        runId: r.runId,
        sandboxId: r.sandboxId,
        repoUrl: r.repoUrl,
        task: r.task,
        baseBranch: r.baseBranch,
        publishPullRequest: r.publishPullRequest,
        ...(r.computer === true ? { computer: true } : {}),
        ...(r.pullUrl !== undefined ? { pullUrl: r.pullUrl } : {}),
        ...(r.reviewAfterPublish !== undefined ? { reviewAfterPublish: r.reviewAfterPublish } : {}),
        ...(r.customAgentVersion !== undefined ? { customAgentVersion: r.customAgentVersion } : {}),
        ...(r.expectedDeliverables !== undefined ? { expectedDeliverables: r.expectedDeliverables } : {}),
        ...(r.deliverables !== undefined ? { deliverables: r.deliverables } : {}),
        ...(r.artifactBundle !== undefined ? { artifactBundle: r.artifactBundle } : {}),
        ...(r.executionTarget !== undefined ? { executionTarget: r.executionTarget } : {}),
        ...(r.approval !== undefined ? { approval: r.approval } : {}),
        status: r.status,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        summary: r.summary,
        error: r.error,
        diff: r.diff,
        hasDiff: r.hasDiff ?? Boolean(r.diff),
      });
    }
    for (const tr of toolRuns) {
      const existing = map.get(tr.runId);
      const completedDiff = extractCompletedDiff(tr);
      if (existing) {
        if (!existing.computer) existing.status = normalizeRunStatus(tr.status || existing.status);
        if (!existing.diff?.trim() && completedDiff) existing.diff = completedDiff;
        if (tr.summary) existing.summary = tr.summary;
        if (tr.error) existing.error = tr.error;
      } else {
        const input = toolRunInput(tr);
        const at = seenAt(tr.runId);
        map.set(tr.runId, {
          runId: tr.runId,
          sandboxId: tr.runId,
          repoUrl: typeof input.repoUrl === "string" ? input.repoUrl : "",
          task:
            typeof input.task === "string" ? input.task : `Delegated run ${tr.runId.slice(0, 8)}`,
          baseBranch: typeof input.baseBranch === "string" ? input.baseBranch : "main",
          publishPullRequest: input.publishPullRequest === true,
          status: normalizeRunStatus(tr.status || "running"),
          createdAt: at,
          updatedAt: at,
          summary: tr.summary,
          error: tr.error,
          diff: completedDiff || undefined,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.createdAt - a.createdAt);
  }, [retainedRuns, toolRuns, seenAt]);

  const reviewRun = useMemo(() => {
    const selected = allRuns.find((run) => run.runId === selectedRunId);
    if (selected) return selected;
    const retainedNewestFirst = [...retainedRuns].sort((left, right) => right.updatedAt - left.updatedAt);
    const retained = retainedNewestFirst.find(canInspectThreadRun) ?? retainedNewestFirst[0];
    if (retained) return allRuns.find((run) => run.runId === retained.runId);
    const newest = [...allRuns].sort((a, b) => b.updatedAt - a.updatedAt);
    return newest.find((run) => run.pullUrl) ?? newest[0];
  }, [allRuns, retainedRuns, selectedRunId]);
  const reviewThreadId = reviewRun?.runId ?? null;
  const retainedReviewRun = retainedRuns.find((run) => run.runId === reviewThreadId);
  const chatDetailsRunId = canInspectThreadRun(retainedReviewRun) ? reviewThreadId : null;

  const threadHasWork = chat.messages.length > 0 || reviewThreadId !== null;
  const pendingApprovalCount = pendingApprovals.length + visibleStoredApprovals.length;
  const hasSignInApproval = pendingApprovals.some((approval) => approval.tool === "browser_sign_in");
  // Model-by-purpose config: connections + the coding-purpose suggestion list.
  const modelConfig = useModelConfig(signedIn && workspaceAuthorityReady && !restrictedTeamMember);
  const agentsDirectory = useAgentsDirectory(signedIn && workspaceAuthorityReady && !restrictedTeamMember);
  const modelConnections = useMemo(
    () =>
      modelConfig.state.kind === "data"
        ? readyConnectionOptions(modelConfig.state.data.connections)
        : [],
    [modelConfig.state],
  );
  // Only offer models the backend would accept: the provider namespace must
  // have a ready connection — and match the selected one when one is picked.
  const codingModelSuggestions = useMemo(() => {
    const models =
      agentsDirectory.state.kind === "data"
        ? agentsDirectory.state.data.agents
            .map((agent) => agent.defaultModel)
            .filter((m) => typeof m === "string" && m.includes("/"))
        : [];
    return codingModelOptions(models, modelConnections, connectionId);
  }, [agentsDirectory.state, modelConnections, connectionId]);

  // Connections/agents can change in Settings — refetch each time the user
  // returns to the composer so the pickers never serve a stale snapshot.
  // Depend on the stable reload callbacks: the hook results are new objects every render, which looped.
  const reloadModelConfig = modelConfig.reload;
  const reloadAgentsDirectory = agentsDirectory.reload;
  useEffect(() => {
    if (mainView === "threads") {
      reloadModelConfig();
      reloadAgentsDirectory();
    }
    if (mainView === "tasks" || mainView === "threads" || mainView === "work" || mainView === "custom-agents" || mainView === "chief-of-staff") refreshCustomAgents();
  }, [mainView, reloadModelConfig, reloadAgentsDirectory, refreshCustomAgents]);

  const repoSuggestions = useMemo(() => {
    const merged = [...savedRepos, ...allRuns.map((run) => run.repoUrl)];
    return [
      ...new Set(
        merged.filter((repo) => typeof repo === "string" && repo.startsWith("https://github.com/")),
      ),
    ];
  }, [savedRepos, allRuns]);

  // Named web sessions are selectable chat contexts; retained delegated runs remain inspectable.
  const sessions = useMemo<SessionItem[]>(() => {
    const botNames = new Map(customAgentRecords.map((record) => [record.id, record.config.name]));
    const botOf = (session: WebThread) => {
      const id = threadAgentId(session);
      return id ? { id, name: botNames.get(id) ?? "Unavailable bot" } : undefined;
    };
    const items: SessionItem[] = webSessions.map((session) => ({
      id: session.id,
      title:
        session.id === "default" && chat.messages.length > 0 ? "Current session" : session.name,
      repoName: "web chat",
      status:
        session.id === selectedSessionId && (chat.isStreaming || chat.status === "streaming")
          ? "running"
          : launchBlocked
            ? "needs-provider"
            : "ready",
      updatedAt: session.updatedAt,
      live:
        session.id === selectedSessionId &&
        (chat.isStreaming || chat.status === "streaming"),
      webSession: true,
      agent: botOf(session),
    }));
    if (!items.some((session) => session.id === "default")) {
      items.unshift({
        id: "default",
        title: "Default Session",
        repoName: "web chat",
        status:
          selectedSessionId === "default" && (chat.isStreaming || chat.status === "streaming")
            ? "running"
            : launchBlocked
              ? "needs-provider"
              : "ready",
        updatedAt: 0,
        live:
          selectedSessionId === "default" &&
          (chat.isStreaming || chat.status === "streaming"),
        webSession: true,
      });
    }
    const seen = new Set<string>();
    for (const run of retainedRuns) {
      seen.add(run.runId);
      items.push({
        id: run.runId,
        title: run.task,
        repoName: parseRepoName(run.repoUrl),
        status: run.status,
        updatedAt: run.updatedAt || run.createdAt,
      });
    }
    for (const run of toolRuns) {
      if (seen.has(run.runId)) continue;
      const input = toolRunInput(run);
      items.push({
        id: run.runId,
        title:
          typeof input.task === "string" ? input.task : `Delegated run ${run.runId.slice(0, 8)}`,
        repoName:
          typeof input.repoUrl === "string"
            ? parseRepoName(input.repoUrl)
            : (run.agentType ?? "sandbox"),
        status: run.status,
        updatedAt: seenAt(run.runId),
      });
    }
    return items;
    // Deps are only what the list actually reads — composer keystroke
    // state (task/repoUrl) must not invalidate the sidebar per keypress.
  }, [
    chat.messages.length,
    chat.isStreaming,
    chat.status,
    retainedRuns,
    toolRuns,
    seenAt,
    webSessions,
    customAgentRecords,
    selectedSessionId,
    launchBlocked,
  ]);

  const threadsLoading =
    (!sessionsLoaded || !listSettled) && retainedRuns.length === 0 && toolRuns.length === 0;

  const liveSession = sessions.find((session) => session.id === selectedSessionId) ?? sessions[0];

  const handleSelectSession = useCallback(
    async (id: string, intent: "bot" | "thread" = "thread"): Promise<"ok" | "failed" | "superseded"> => {
      if (!privateDataEnabled) return "failed";
      const selectionScope = activeSurfaceScopeRef.current;
      const selectionTicket = ++sessionSelectionSeq.current;
      const session = visibleWebSessions.find((item) => item.id === id);
      if (!session && id !== "default") {
        // A run row is not a chat session: inspect it without disturbing the
        // selected chat session or its session-scoped run list.
        setMobileSessionsOpen(false);
        openRunInAnalytics(id);
        return "ok";
      }
      if (session && id !== "default") {
        try {
          const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/resume`, {
            method: "POST",
          });
          if (activeSurfaceScopeRef.current !== selectionScope) return "superseded";
          if (response.status === 404 || response.status === 405) {
            if (response.status === 404 && (await isSessionNotFoundBody(response))) {
              if (activeSurfaceScopeRef.current !== selectionScope) return "superseded";
              if (selectionTicket !== sessionSelectionSeq.current) return "superseded";
              // Real session-not-found: the API is healthy, this item is stale.
              // Prune it and land on the default session — don't mark the
              // sessions API unavailable or select the dead session.
              setWebSessions((current) => current.filter((item) => item.id !== id));
              setSelectedSessionId("default");
              writeRememberedSessionId("default");
              setMobileSessionsOpen(false);
              setSelectedRunId(null);
              setMainView("threads");
              if (intent === "bot") {
                // The page keeps the bot it was opened from; only the thread it
                // pointed at is gone, so the panel explains that and offers Start.
                setBotPageMessage("That thread was removed from this workspace. Start a new one with this bot.");
              } else {
                setNotice("That session no longer exists — it was removed from the list.");
              }
              return "failed";
            }
            // Older backends lack the resume route: degrade to local selection
            // instead of blocking the switch — but only for the selection still on
            // screen. A stale 405 must not switch session scoping off, which would
            // send the next read for the current session to the default store.
            if (activeSurfaceScopeRef.current !== selectionScope) return "superseded";
            if (selectionTicket !== sessionSelectionSeq.current) return "superseded";
            setSessionApiAvailable(false);
          } else if (!response.ok) {
            throw new Error(`Could not resume session: ${response.status}`);
          }
        } catch (error) {
          if (activeSurfaceScopeRef.current !== selectionScope) return "superseded";
          // A stale failure must not narrate over a newer selection.
          if (selectionTicket !== sessionSelectionSeq.current) return "superseded";
          setNotice(error instanceof Error ? error.message : String(error));
          return "failed";
        }
      }
      if (activeSurfaceScopeRef.current !== selectionScope) return "superseded";
      // A newer click already owns the surface; this reply is stale.
      if (selectionTicket !== sessionSelectionSeq.current) return "superseded";
      pushThreadUrl();
      setSelectedSessionId(id);
      writeRememberedSessionId(id);
      setCustomAgentId(threadAgentId(session));
      setMobileSessionsOpen(false);
      setSelectedRunId(null);
      setBotPage("chat");
      setBotPageMessage(null);
      setMainView("threads");
      return "ok";
    },
    [visibleWebSessions, privateDataEnabled, pushThreadUrl, openRunInAnalytics],
  );

  sessionsNavRef.current = sessions;
  selectedNavIdRef.current = selectedRunId ?? selectedSessionId;
  selectSessionRef.current = (id: string) => {
    void handleSelectSession(id);
  };

  const threadCreationPending = useRef(false);
  // A shared workspace opens its room without a session; a private thread needs
  // verified access and this actor's answered thread registry before one can be
  // created. Every creation entry point reads this one reason.
  const taskCreationBlocker = teamWorkspaceId
    ? null
    : !privateDataEnabled
      ? "Wait for your workspace access to be verified."
      : sessionRegistryAnswer?.actor !== orchestratorName
        ? "Loading your threads…"
        : sessionRegistryAnswer.failed
          ? "Your threads couldn't load. Reload to try again."
          : !sessionApiAvailable
            ? "Session creation is unavailable on this server."
            : null;
  const handleNewTask = useCallback(async () => {
    if (teamWorkspaceId) {
      setSharedRoomId(undefined); setSharedHandoffId(undefined); setSharedEmployeeId(undefined); setMainView("threads");
      return null;
    }
    if (threadCreationPending.current) return null;
    if (taskCreationBlocker) {
      setNotice(taskCreationBlocker);
      return null;
    }
    const creationScope = activeSurfaceScopeRef.current;
    threadCreationPending.current = true;
    try {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (activeSurfaceScopeRef.current !== creationScope) return null;
      if (response.status === 404 || response.status === 405) {
        setSessionApiAvailable(false);
      setNotice("Session creation is unavailable. Your existing draft has been kept.");
      return null;
      }
      if (!response.ok) throw new Error(`Could not create session: ${response.status}`);
      const body = (await response.json()) as {
        session: { id: string; name: string; agentName: string; updatedAt: number };
      };
      if (activeSurfaceScopeRef.current !== creationScope) return null;
      pushThreadUrl();
      setWebSessions((current) => [
        body.session,
        ...current.filter((session) => session.id !== body.session.id),
      ]);
      setSelectedSessionId(body.session.id);
      writeRememberedSessionId(body.session.id);
      setSelectedRunId(null);
      setBotPage("chat");
      setBotPageMessage(null);
      setCustomAgentId("");
      setNotice(null);
      setMobileSessionsOpen(false);
      setMainView("threads");
      window.setTimeout(() => {
        document.querySelector<HTMLTextAreaElement>('[data-testid="task-composer"] textarea')?.focus();
      }, 0);
      return body.session.id;
    } catch (error) {
      if (activeSurfaceScopeRef.current !== creationScope) return null;
      setNotice(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      threadCreationPending.current = false;
    }
  }, [taskCreationBlocker, teamWorkspaceId, pushThreadUrl]);
  handleNewTaskRef.current = () => { void handleNewTask(); };

  const handleStartAgentThread = useCallback(async (profile: CustomAgentWire) => {
    if (teamWorkspaceId) {
      setSharedRoomId(undefined); setSharedHandoffId(undefined); setSharedEmployeeId(profile.id); setMainView("threads");
      return null;
    }
    if (taskCreationBlocker) throw new Error(taskCreationBlocker);
    const creationScope = activeSurfaceScopeRef.current;
    if (threadCreationPending.current) throw new Error("Another thread is being created. Wait, then try again.");
    threadCreationPending.current = true;
    try {
      const session = await createAgentThread(profile);
      if (activeSurfaceScopeRef.current !== creationScope) return null;
      setSessionRegistryOwner(orchestratorName);
      setWebSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
      setSessionApiAvailable(true);
      pushThreadUrl();
      setSelectedSessionId(session.id);
      writeRememberedSessionId(session.id);
      setSelectedRunId(null);
      setBotPage("chat");
      setBotPageMessage(null);
      setCustomAgentId(profile.id);
      applyThreadProfile(profile);
      setNotice(null);
      refreshCustomAgents();
      setMainView("threads");
      setMobileSessionsOpen(false);
      window.setTimeout(() => {
        document.querySelector<HTMLTextAreaElement>('[data-testid="task-composer"] textarea')?.focus();
      }, 0);
      return session.id;
    } finally {
      threadCreationPending.current = false;
    }
  }, [applyThreadProfile, orchestratorName, refreshCustomAgents, teamWorkspaceId, taskCreationBlocker, pushThreadUrl]);

  const startSidebarAgentThread = async (profile?: CustomAgentWire) => {
    const creationScope = activeSurfaceScopeRef.current;
    try {
      if (profile) await handleStartAgentThread(profile);
      else await handleNewTask();
    } catch (error) {
      if (activeSurfaceScopeRef.current !== creationScope) return;
      setNotice(error instanceof Error ? error.message : "Could not start a thread. Try again from the sidebar.");
    }
  };
  // One bot, one page: select it, open its panel, and land on its newest thread
  // when it has one. A click never creates a thread, and a shared room keeps its
  // own surface instead of borrowing this private panel.
  const openBotPanel = useCallback((agentId?: string) => {
    if (teamWorkspaceId) { openView("custom-agents"); return; }
    const profile = agentId ? customAgentRecordsRef.current.find((item) => item.id === agentId) : undefined;
    const latest = visibleWebSessions
      .filter((session) => (profile ? threadAgentId(session) === profile.id : !threadAgentId(session)))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    // Fence any reply still in flight for the conversation on screen: it must not
    // land on the bot page that is opening now.
    sessionSelectionSeq.current += 1;
    setCustomAgentId(profile?.id ?? "");
    setAgentDetailsOpen(true);
    setMainView("threads");
    if (latest) {
      // Nothing from the previous bot stays actionable while its session opens:
      // a failed or slow resume must not leave another bot's composer live here.
      setBotPage("pending");
      setBotPageMessage(null);
      const opening = handleSelectSession(latest.id, "bot");
      const ticket = sessionSelectionSeq.current;
      void opening.then((result) => {
        // A newer selection owns the surface; it decides what shows.
        if (ticket !== sessionSelectionSeq.current) return;
        if (result === "failed") setBotPage("unavailable");
      });
    } else {
      // No thread is this bot's own state, not a reason to keep the last bot's
      // thread selected with its title editor and composer pointed at it.
      setBotPage("empty");
      setSelectedRunId(null);
    }
  }, [handleSelectSession, openView, teamWorkspaceId, visibleWebSessions]);
  const setupEmployee = async (template: EmployeeTemplate) => {
    const setupScope = activeSurfaceScopeRef.current;
    const profile = await createEmployeeAgent(template, teamWorkspaceId || undefined);
    if (activeSurfaceScopeRef.current !== setupScope) return;
    try {
      await handleStartAgentThread(profile);
      if (activeSurfaceScopeRef.current !== setupScope) return;
      setTask("");
      dismissEmployeeOnboarding();
    } catch (error) {
      if (activeSurfaceScopeRef.current !== setupScope) return;
      dismissEmployeeOnboarding();
      setMainView("threads");
      setNotice(`Agent created. Start a new thread from its sidebar row. ${error instanceof Error ? error.message : "Thread creation failed."}`);
      refreshCustomAgents();
    }
  };
  // Read the record at call time, not at render time: two edits in quick
  // succession must send the version the first save returned.
  const customAgentRecordsRef = useRef(customAgentRecords);
  customAgentRecordsRef.current = customAgentRecords;
  const saveBotLibrary = useCallback(async (employeeId: string, deliverables: string[]) => {
    const employee = customAgentRecordsRef.current.find((profile) => profile.id === employeeId);
    if (!employee) throw new Error("This bot is no longer in this workspace. Reload to see the current directory.");
    applyCustomAgentRecord(await saveBotDeliverables(employee, deliverables, teamWorkspaceId || undefined));
  }, [applyCustomAgentRecord, teamWorkspaceId]);
  // One bot-panel edit path: the record is read at call time so a second save
  // sends the version the first one returned, and a panel that has moved on to
  // another bot cannot write through stale props.
  const saveBotConfigEdit = useCallback(async (employeeId: string, edit: BotConfigEdit) => {
    const employee = customAgentRecordsRef.current.find((profile) => profile.id === employeeId);
    if (!employee) throw new Error("This bot is no longer in this workspace. Reload to see the current directory.");
    applyCustomAgentRecord(await saveBotConfig(employee, edit, teamWorkspaceId || undefined));
  }, [applyCustomAgentRecord, teamWorkspaceId]);
  const activeEmployee = customAgentRecords.find((profile) => profile.id === customAgentId);
  // Runs this bot started and the files they captured. Shiba's list is the runs
  // queued without a profile; no bot ever sees another bot's runs.
  const botRuns = useMemo(() => {
    const mine = retainedRuns.filter((run) => (customAgentId ? run.customAgentId === customAgentId : !run.customAgentId));
    return [...mine].sort((a, b) => b.createdAt - a.createdAt);
  }, [retainedRuns, customAgentId]);
  const botRunRows = useMemo(() => botRuns.slice(0, 8).map((run) => ({
    runId: run.runId, status: run.status, task: run.task, createdAt: run.createdAt, updatedAt: run.updatedAt,
  })), [botRuns]);
  // Rows stay on screen while the next scope loads, so a run's link must carry
  // the session its own answer came from — not the one just selected.
  const runsSourceSession = runsSession ?? selectedSessionId;
  // Runs are stored per session and the deliverable route reads only the session
  // it is given, so every captured file carries the conversation that owns it.
  const botRunOutputs = useMemo(() => botRuns.flatMap((run) => (run.deliverables ?? []).map((file, index) => ({
    runId: run.runId, runStatus: run.status, runCreatedAt: run.createdAt, path: file.path, index,
    sessionId: runsSourceSession,
    ...(file.bytes !== undefined ? { bytes: file.bytes } : {}),
    ...(file.mediaType !== undefined ? { mediaType: file.mediaType } : {}),
  }))), [botRuns, runsSourceSession]);
  // This bot's other threads, which the run list cannot see: the dashboard reads
  // runs per session, so the panel names that narrower coverage instead of
  // calling one thread's runs the bot's whole history.
  const botRunsScope = useMemo<BotRunsScope>(() => {
    const threads = visibleWebSessions.filter((session) => customAgentId ? threadAgentId(session) === customAgentId : !threadAgentId(session));
    return {
      // A retained list from the previous session is not this session's answer.
      state: runsStale ? "loading" : runsError ? "error" : listSettled ? "ready" : "loading",
      ...(selectedSessionId !== "default" && activeWebSession && botPage === "chat" ? { threadName: activeWebSession.name || "this thread" } : {}),
      otherThreadCount: Math.max(0, threads.length - 1),
    };
  }, [visibleWebSessions, customAgentId, runsStale, runsError, listSettled, selectedSessionId, activeWebSession, botPage]);
  const botPendingApprovals = useMemo(
    () => visibleStoredApprovals.filter((approval) => (customAgentId ? approval.customAgentId === customAgentId : !approval.customAgentId)).length,
    [visibleStoredApprovals, customAgentId],
  );
  const botModelEdit = useMemo(() => (activeEmployee ? {
    value: activeEmployee.config.codingModel ?? "",
    options: codingModelSuggestions.map((model) => ({ id: model, label: model })),
    busy: false,
    onChange: (value: string) => { void saveBotConfigEdit(activeEmployee.id, { codingModel: value || null }).catch((error: unknown) => setNotice(error instanceof Error ? error.message : "Could not save the model.")); },
  } : null), [activeEmployee, codingModelSuggestions, saveBotConfigEdit]);
  const employeeName = activeEmployee?.config.name ?? "Shiba";
  const chatAgent = { id: activeEmployee?.id ?? "shiba", name: employeeName, mascotPreset: activeEmployee?.config.mascotPreset, look: activeEmployee?.config.look, avatar: activeEmployee?.config.avatar, role: activeEmployee ? employeeRole(activeEmployee.slug, activeEmployee.config.roleTemplateId) : undefined };
  const mentionableAgents = customAgentRecords.map((record) => ({ id: record.id, name: record.config.name, mascotPreset: record.config.mascotPreset, look: record.config.look, avatar: record.config.avatar, role: employeeRole(record.slug, record.config.roleTemplateId) }));
  const showEmployeeOnboarding = !teamWorkspaceId && !restrictedTeamMember && !employeeOnboardingDismissed && !threadsLoading && !customAgentsLoading && !customAgentsError && sessionApiAvailable && customAgentRecords.length === 0 && webSessions.every((session) => session.id === "default") && sessions.every((session) => session.id === "default") && !threadHasWork;

  const activeSandboxCount = useMemo(() => {
    return (
      toolRuns.filter((r) => r.status === "running" || r.status === "pending").length +
      retainedRuns.filter((r) => r.status === "running" || r.status === "pending").length
    );
  }, [toolRuns, retainedRuns]);

  const connectionState = identityError
    ? `Identity error: ${identityError}`
    : agent.connectionError
      ? `Connection error: ${agent.connectionError.message ?? "unknown"}`
      : launchBlocked
        ? "Can't launch yet"
        : agent.identified
          ? "Connected"
          : "Connecting";

  const busy =
    isSubmitting ||
    clearing ||
    chat.isStreaming ||
    chat.isRecovering ||
    chat.status === "streaming" ||
    chat.status === "submitted";

  const pickSuggestion = (prompt: string) => focusComposerDraft(setTask, prompt);

  if (orchestratorName === null && identityIssue === null) {
    return <SessionPending onRetry={retryIdentity} />;
  }

  // Built-in login lane: the Worker 401s with code "better-auth".
  if (identityIssue === "signin" && authMode === "better-auth") {
    return <AuthScreen onSignedIn={retryIdentity} invitationToken={invitationToken} />;
  }

  if (identityIssue === "signin" || identityIssue === "unconfigured") {
    const accessUnconfigured = identityIssue === "unconfigured";
    return (
      <div className="h-dvh bg-[var(--bg)] text-[var(--fg)] font-sans flex items-center justify-center p-6 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <div className="bg-[var(--card)] border border-[var(--border-1)] rounded-[var(--radius-button)] max-w-sm w-full p-6 shadow-[var(--sh-overlay)] flex flex-col items-center text-center gap-3">
          <ShibaMark />
          <h1 className="text-xl text-[var(--fg)]">
            {accessUnconfigured ? "Dashboard access isn't configured" : "Sign in to continue"}
          </h1>
          <p className="text-sm text-[var(--muted-foreground-2)] leading-relaxed">
            {accessUnconfigured
              ? "This deployment has no Cloudflare Access application, so the dashboard is locked. Set ACCESS_EMAILS and WORKERS_SUBDOMAIN and redeploy, or set ACCESS_AUD to an existing Access app's AUD tag."
              : "Your Cloudflare Access session has expired or you are not signed in yet."}
          </p>
          {accessUnconfigured ? (
            <a
              href="/docs/deployment/"
              className="mt-1 w-full min-h-11 flex items-center justify-center rounded-[var(--radius-button)] bg-[var(--primary)] hover:bg-[var(--primary-soft-hover)] text-[var(--primary-text)] text-sm font-semibold transition-colors shadow-[var(--sh-card)]"
            >
              Deployment documentation
            </a>
          ) : (
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-1 w-full min-h-11 rounded-[var(--radius-button)] bg-[var(--primary)] hover:bg-[var(--primary-soft-hover)] text-[var(--primary-text)] text-sm font-semibold transition-colors shadow-[var(--sh-card)] active:scale-[0.98]"
            >
              Sign in
            </button>
          )}
        </div>
      </div>
    );
  }

  if (identityIssue === "unreachable" || identityIssue === "error") {
    return (
      <SessionProblem
        message={
          identityIssue === "unreachable"
            ? "Backend not connected — open your Worker URL."
            : `Identity lookup failed: ${identityError ?? "unknown error"}`
        }
        onRetry={retryIdentity}
      />
    );
  }

  const bannerMessage = !online
    ? "You're offline. Changes will sync when the network returns."
    : identityIssue === "unreachable"
      ? "Backend not connected — open your Worker URL."
      : identityIssue === "error"
        ? `Identity lookup failed: ${identityError ?? "unknown error"}`
        : orchestratorName && !teamWorkspaceId && !restrictedTeamMember && agent.connectionError
          ? `Live connection lost: ${agent.connectionError.message ?? "unknown"}. Reconnecting…`
          : null;

  const panelProps = { scope, onScopeChange: handleScopeChange } as const;
  const isNavId = (id: string): id is AppNavView => APP_NAV_ITEMS.some((item) => item.id === id);
  const privateData = privateDataEnabled && sessionRegistryOwner === orchestratorName;
  const personalOnlyNotice = Boolean(teamWorkspaceId) && !TEAM_WORKSPACE_VIEWS.includes(mainView);
  const noMailboxCounts: Partial<MailboxCounts> = {};
  const noMemoryCounts: Partial<MemoryCounts> = {};
  let destinationPanel: React.ReactNode = null;
  if (personalOnlyNotice) {
    destinationPanel = null;
  } else if (
    mainView === "custom-agents" ||
    mainView === "employee-tools" ||
    mainView === "swarm" ||
    mainView === "tasks" ||
    (mainView === "threads" && !teamWorkspaceId && privateData)
  ) {
    destinationPanel = (
      <AgentsPanel
        {...panelProps}
        active={mainView === "custom-agents" ? customAgentId : mainView === "threads" ? selectedRunId ?? selectedSessionId : mainView}
        onSelect={(id) => { if (id === "employee-tools" || id === "swarm" || id === "tasks") openView(id); }}
        agents={signedIn && workspaceAuthorityReady && !teamDirectory.error ? customAgentRecords : []}
        threads={visibleWebSessions}
        threadsLoading={mainView === "threads" && threadsLoading}
        runs={mainView === "threads" ? sessions.filter((session) => !session.webSession) : []}
        onLoadMoreRuns={mainView === "threads" ? () => {
          setWorkViewMode("list");
          openView("work");
        } : undefined}
        // Only the open thread has a live stream; the rest fall back to stored session metadata.
        threadStates={{ [selectedSessionId]: chat.isStreaming || chat.status === "streaming" || chat.status === "submitted" ? "working" : pendingApprovals.length > 0 ? "waiting" : "idle" }}
        ownerName={orchestratorName ?? undefined}
        workspaceName={teamWorkspace?.name}
        loading={customAgentsLoading}
        error={customAgentsError}
        onSelectAgent={mainView === "threads" ? openBotPanel : (id) => {
          setInitialEmployeeId(id);
          openView("custom-agents");
        }}
        onOpenAgent={mainView === "threads" ? undefined : openBotPanel}
        onSelectThread={(id) => { void handleSelectSession(id); openView("threads"); }}
        onSelectRun={openRunInAnalytics}
        onNewThread={(agentId) => { void startSidebarAgentThread(customAgentRecords.find((profile) => profile.id === agentId)); }}
        onNewChat={mainView === "threads" ? () => { void handleNewTask(); } : undefined}
        onSearchAll={mainView === "threads" ? () => setCommandMenuOpen(true) : undefined}
        newThreadDisabledReason={taskCreationBlocker ?? undefined}
        onNewAgent={mainView === "custom-agents" ? undefined : () => openView("custom-agents")}
      />
    );
  } else if (mainView === "collaboration" || mainView === "threads") {
    destinationPanel = (
      <ChatsPanel
        {...panelProps}
        active={selectedRunId ?? selectedSessionId}
        onSelect={(id) => { openView("threads"); void handleSelectSession(id); }}
        showWorkspaceGroups={false}
        loading={privateData && threadsLoading}
        sessions={privateData ? sessions : []}
        onNewChat={() => { void handleNewTask(); }}
        onSearchClick={() => setCommandMenuOpen(true)}
      />
    );
  } else if (["integrations", "skills", "agents", "providers", "spaces"].includes(mainView)) {
    destinationPanel = <ExtensionsPanel {...panelProps} active={mainView} onSelect={(id) => { if (isNavId(id)) openView(id); }} onSearchClick={() => setCommandMenuOpen(true)} />;
  } else if (mainView === "inbox") {
    destinationPanel = (
      <MailboxPanel
        {...panelProps}
        active={mailboxFolder}
        onSelect={setMailboxFolder}
        counts={privateData ? mailboxCounts : noMailboxCounts}
        mailboxes={privateData ? mailboxes : []}
        selectedMailbox={mailboxAddress}
        onSelectMailbox={setMailboxAddress}
      />
    );
  } else if (mainView === "memory") {
    destinationPanel = <MemoryPanel {...panelProps} active={memoryView} onSelect={(id) => setMemoryView(id as "facts" | "sources" | "sessions")} counts={privateData ? memoryCounts : noMemoryCounts} />;
  } else if (["dashboard", "analytics", "activity", "diff", "approvals"].includes(mainView)) {
    destinationPanel = <InsightsPanel {...panelProps} active={mainView} onSelect={(id) => { if (isNavId(id)) openView(id); }} pendingApprovalsCount={teamWorkspaceId ? 0 : pendingApprovals.length + visibleStoredApprovals.length} />;
  } else if (mainView === "automations") {
    destinationPanel = <AutomationsPanel {...panelProps} automations={privateDataEnabled && scope === "personal" ? automationList : []} active={selectedAutomationId ?? ""} onSelect={setSelectedAutomationId} />;
  } else if (mainView === "settings") {
    destinationPanel = <SettingsPanel {...panelProps} active={settingsSection} onSelect={setSettingsSection} onBack={closeSettings} />;
  }

  // Guided journey: every stage is derived from state the server already owns,
  // so a reload or relaunch resumes in place and a satisfied stage is skipped.
  const journeyDraft = firstRunProgress?.draftTask ?? null;
  // The guided approval is the one the server issued for this draft, matched only
  // on the draft id the approval was frozen with. Task text is not an identifier:
  // an unrelated approval can carry the same words, and offering it here would put
  // this flow's framing on someone else's decision.
  const journeyApproval: StoredApproval | null = firstRunProgress?.draftTaskId
    ? visibleStoredApprovals.find((approval) => approval.draftTaskId === firstRunProgress.draftTaskId) ?? null
    : null;
  const journeyOtherApprovalCount = visibleStoredApprovals.filter((approval) => approval.approvalId !== journeyApproval?.approvalId).length;
  const journeyRunRecord = firstRunProgress?.draftTaskId
    ? retainedRuns.find((candidate) => candidate.draftTaskId === firstRunProgress.draftTaskId) ?? null
    : null;
  const journeyRun: JourneyRun | null = journeyRunRecord
    ? {
        runId: journeyRunRecord.runId,
        status: journeyRunRecord.status,
        summary: journeyRunRecord.summary,
        error: journeyRunRecord.error,
        deliverables: journeyRunRecord.deliverables,
      }
    : null;
  const journeyRunState = journeyRun
    ? journeyRun.status === "completed"
      ? "completed"
      : ["error", "aborted", "unknown", "cancelled"].includes(journeyRun.status)
        ? "failed"
        : journeyRun.status === "pending"
          ? "awaiting-approval"
          : "running"
    : journeyApproval
      ? "awaiting-approval"
      : "none";
  const journey = deriveJourney({
    workspaceReady: signedIn && workspaceAuthorityReady && !restrictedTeamMember,
    providerReady: providerReadiness.ready,
    employeeReady: Boolean(journeyDraft?.employeeId && journeyDraft.employeeVersion != null),
    taskPrepared: Boolean(journeyDraft?.preparedAt && firstRunProgress?.draftTaskId),
    run: journeyRunState,
    activated: firstRunProgress?.activatedAt != null,
    dismissed: firstRunProgress?.dismissedAt != null,
  });
  // A finished flow opens on its result; an unfinished one on its resume point.
  const activeJourneyStage: JourneyStepId = journeyStage ?? journey.resume ?? (journey.complete ? "result" : "task");
  const journeyEmployees: JourneyEmployee[] = customAgentRecords
    .filter((record) => record.archivedAt === undefined)
    .map((record) => ({ id: record.id, version: record.version, name: record.config.name, slug: record.slug, look: record.config.look, roleTemplateId: record.config.roleTemplateId }));
  const createJourneyWorkspace = async (name: string): Promise<void> => {
    const body = await teamWorkspaceRequest<{ workspace: { workspaceId: string } }>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    await teamDirectory.refresh();
    teamDirectory.selectWorkspace(body.workspace.workspaceId);
  };
  const selectJourneyEmployee = (employee: JourneyEmployee): Promise<void> => {
    // Choosing the employee here answers the draft's own employee question, so the
    // guided brief continues at the first unanswered outcome question.
    const nextStep = (["goal", "audience", "acceptance"] as const).find((id) => !journeyDraft?.[id]?.trim()) ?? "review";
    return updateFirstRunProgress({
      action: "save-draft",
      draftTask: {
        employeeAnswer: employee.name,
        employeeId: employee.id,
        employeeVersion: employee.version,
        employeeTemplateId: null,
        employeeTemplateVersion: null,
        completedSteps: [...new Set([...(journeyDraft?.completedSteps ?? []), "employee" as const])],
        currentStep: nextStep,
      },
    });
  };
  return (
    <AppShell activeView={mainView} onNavigate={openView} pendingApprovalCount={teamWorkspaceId ? 0 : pendingApprovals.length + visibleStoredApprovals.length}>
      {/* LEFT: app navigation rail (lg+; phones use the sheet below) */}
      <AppNavRail
        workspaceSwitcher={<WorkspaceSwitcher workspaces={teamDirectory.workspaces} selectedWorkspaceId={teamWorkspaceId} loading={teamDirectory.loading} onSelect={(id) => { flushDraft(); roomRoute.clear(); teamDirectory.selectWorkspace(id); }} onManage={() => openView("team")} />}
        workspaces={teamDirectory.workspaces}
        selectedWorkspaceId={teamWorkspaceId}
        onSelectWorkspace={(id) => { flushDraft(); roomRoute.clear(); teamDirectory.selectWorkspace(id); }}
        collapsed={mainView === "work" ? workPanelCollapsed : sessionsCollapsed}
        sidebarPanelId={mainView === "work" ? "work-panel" : "app-context-panel"}
        activeView={mainView}
        onNavigate={openView}
        pendingApprovalCount={teamWorkspaceId ? 0 : pendingApprovals.length + visibleStoredApprovals.length}
        theme={theme}
        onToggleTheme={toggleTheme}
        activeSandboxCount={activeSandboxCount}
        setupDone={setupDone}
        setupTotal={SETUP_TOTAL_STEPS}
        onOpenSetup={openFirstRun}
        onOpenShortcuts={() => setShowShortcutsModal(true)}
        accountEmail={orchestratorName}
        onSignOut={authMode === "better-auth" ? handleSignOut : undefined}
        sessions={privateDataEnabled && sessionRegistryOwner === orchestratorName ? sessions : []}
        selectedSessionId={selectedRunId ?? selectedSessionId}
        onSelectSession={handleSelectSession}
        onNewTask={handleNewTask}
        onOpenSearch={() => setCommandMenuOpen(true)}
        onToggleCollapse={toggleActiveSidebar}
        threadsLoading={threadsLoading}
        customAgentRecords={customAgentRecords}
        agentThreads={visibleWebSessions}
        onNewAgentThread={startSidebarAgentThread}
        onOpenAgent={openBotPanel}
        connectionLabel={teamWorkspaceId ? "Shared workspace" : connectionState}
        connectionTone={
          identityError || agent.connectionError
            ? "error"
            : launchBlocked || !agent.identified
              ? "pending"
              : "ok"
        }
      />

      {mobileNavOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-[var(--overlay)]"
            onClick={() => setMobileNavOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 shadow-[var(--sh-overlay)] animate-enter-x">
            <AppNavRail
              workspaceSwitcher={<WorkspaceSwitcher workspaces={teamDirectory.workspaces} selectedWorkspaceId={teamWorkspaceId} loading={teamDirectory.loading} onSelect={(id) => { flushDraft(); roomRoute.clear(); teamDirectory.selectWorkspace(id); }} onManage={() => { openView("team"); setMobileNavOpen(false); }} />}
              variant="sheet"
              activeView={mainView}
              onNavigate={(view) => {
                if (view === "settings") mobileNavWasOpen.current = false;
                openView(view);
                setMobileNavOpen(false);
              }}
              pendingApprovalCount={teamWorkspaceId ? 0 : pendingApprovals.length + visibleStoredApprovals.length}
              theme={theme}
              onToggleTheme={toggleTheme}
              activeSandboxCount={activeSandboxCount}
              setupDone={setupDone}
              setupTotal={SETUP_TOTAL_STEPS}
              onOpenSetup={() => {
                setMobileNavOpen(false);
                openFirstRun();
              }}
              onOpenShortcuts={() => {
                setMobileNavOpen(false);
                setShowShortcutsModal(true);
              }}
              accountEmail={orchestratorName}
              onSignOut={authMode === "better-auth" ? handleSignOut : undefined}
              onClose={() => setMobileNavOpen(false)}
              sessions={privateDataEnabled && sessionRegistryOwner === orchestratorName ? sessions : []}
              selectedSessionId={selectedRunId ?? selectedSessionId}
              onSelectSession={(id) => {
                handleSelectSession(id);
                setMobileNavOpen(false);
              }}
              onNewTask={() => {
                handleNewTask();
                setMobileNavOpen(false);
              }}
              threadsLoading={threadsLoading}
              customAgentRecords={customAgentRecords}
              agentThreads={visibleWebSessions}
              onNewAgentThread={(profile) => { startSidebarAgentThread(profile); setMobileNavOpen(false); }}
              onOpenAgent={(agentId) => { openBotPanel(agentId); setMobileNavOpen(false); }}
              onOpenSearch={() => {
                mobileNavWasOpen.current = false;
                mobileNavTriggerRef.current?.focus();
                setMobileNavOpen(false);
                setCommandMenuOpen(true);
              }}
              connectionLabel={connectionState}
              connectionTone={
                identityError || agent.connectionError
                  ? "error"
                  : launchBlocked || !agent.identified
                    ? "pending"
                    : "ok"
              }
            />
          </div>
        </div>
      ) : null}

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* TOP BAR — subtle chrome header */}
        <header className="shiba-app-topbar pt-[env(safe-area-inset-top)] shrink-0 text-[var(--fg)] flex items-center gap-2.5 pl-2 pr-3 lg:px-4 z-20">
          <button
            type="button"
            ref={mobileNavTriggerRef}
            onClick={() => setMobileNavOpen(true)}
            aria-label="Open navigation"
            aria-expanded={mobileNavOpen}
            className="lg:hidden size-11 -my-1 shrink-0 rounded-[var(--radius-button)] flex items-center justify-center text-[var(--muted-foreground-1)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] transition-colors"
          >
            <svg
              aria-hidden="true"
              className="size-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div className="flex min-w-0 items-center gap-2 text-[13px]">
            <span className="shiba-workspace-indicator" aria-hidden="true">{teamWorkspaceId ? "T" : "P"}</span>
            <span className="truncate font-medium" title={teamWorkspaceId ? (teamWorkspace?.name ?? "Team workspace") : "Personal workspace"}>{teamWorkspaceId ? (teamWorkspace?.name ?? "Team workspace") : "Personal workspace"}</span>
            <span className="hidden text-[var(--muted-foreground-3)] sm:inline" aria-hidden="true">/</span>
            <span className="hidden truncate text-[var(--muted-foreground-2)] sm:inline">{APP_NAV_ITEMS.find((item) => item.id === mainView)?.label ?? "Threads"}</span>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <Tooltip content="Command menu" shortcut="⌘K" side="bottom">
              <button
                type="button"
                onClick={() => setCommandMenuOpen(true)}
                aria-label="Open command menu"
                className="shiba-command-trigger min-h-11 sm:min-h-9 touch:min-h-11 justify-center rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] text-[var(--muted-foreground-1)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] flex items-center gap-2 px-3 text-xs transition-colors"
              >
                <svg
                  aria-hidden="true"
                  className="size-3.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M21 21l-4.35-4.35M17 10.5a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z"
                  />
                </svg>
                <span className="hidden sm:inline">Search and commands</span>
                <kbd className="hidden rounded border border-[var(--border-1)] px-1 py-0.5 font-mono text-[10px] text-[var(--muted-foreground-2)] sm:inline">⌘K</kbd>
              </button>
            </Tooltip>
          </div>
        </header>

        {bannerMessage ? (
          <div
            role="alert"
            className="shrink-0 flex items-center gap-3 px-4 py-2 bg-[var(--destructive-soft)] border-b border-[color-mix(in_oklch,var(--destructive)_30%,transparent)] text-xs text-[var(--destructive-fg)]"
          >
            <span
              className="size-2 shrink-0 rounded-full bg-[var(--destructive)] animate-pulse"
              aria-hidden="true"
            />
            <span className="flex-1 min-w-0 break-words">
              {bannerMessage}
              {online && identityIssue ? (
                <span className="text-[var(--muted-foreground-2)]"> Retrying automatically.</span>
              ) : null}
            </span>
            <button
              type="button"
              onClick={() => {
                if (identityIssue) retryIdentity();
                else if (privateDataEnabled) agent.reconnect();
              }}
              className="shrink-0 touch:min-h-11 px-3 py-1 rounded-[var(--radius-button)] border border-[color-mix(in_oklch,var(--destructive)_40%,transparent)] bg-[var(--card)] text-[var(--destructive-fg)] font-medium hover:bg-[var(--destructive-soft)] transition-colors"
            >
              Retry now
            </button>
          </div>
        ) : null}

        {nudgeVisible && nudgeStatus ? <>
          {!nudgeSession?.bannerDismissed ? <OnboardingNudgeBanner key={orchestratorName} status={nudgeStatus} onResume={(step) => { void resumeNudgeStep(step); }} onDismiss={dismissNudgeBanner} /> : null}
          <OnboardingNudgePopup status={nudgeStatus} open={nudgeSession?.popupOpen ?? false} onResume={(step) => { void resumeNudgeStep(step); }} onDismiss={closeNudgePopup} />
        </> : null}

        <div className={`shiba-app-content flex-1 flex min-w-0 min-h-0 ${mainView === "work" ? "" : "gap-3 p-3"}`}>
          {mainView !== "work" && !sessionsCollapsed ? <div id="app-context-panel" className="hidden min-h-0 lg:flex">{destinationPanel ?? <AppAreaSidebar />}</div> : null}
          <MainCard className={mainView === "work" || mainView === "settings" || (!personalOnlyNotice && SELF_CARDED_VIEWS.includes(mainView) && !(mainView === "integrations" && (teamWorkspaceId || restrictedTeamMember))) ? "!rounded-none !border-0 !bg-transparent !shadow-none" : ""}>
          {inboxMounted && privateDataEnabled ? (
            <div
              className="flex flex-1 flex-col h-full min-h-0 overflow-hidden"
              style={mainView === "inbox" ? undefined : { display: "none" }}
            >
              <InboxTab
                key={orchestratorName ?? "signed-out"}
                scope={scope}
                activeFolder={mailboxFolder}
                onSelectFolder={setMailboxFolder}
                mailboxFilter={mailboxAddress}
                onSelectMailbox={setMailboxAddress}
                showFolderSwitcher={sessionsCollapsed}
                onCountsChange={setMailboxCounts}
                onMailboxesChange={handleMailboxesChange}
                onOpenApprovals={() => setMainView("approvals")}
              />
            </div>
          ) : null}
{repeatSource && privateDataEnabled && !teamWorkspaceId ? <RepeatRoutineDialog key={`${orchestratorName}:${selectedSessionId}`} source={repeatSource} employees={customAgentRecords.map((record) => ({ id: record.id, name: record.config.name }))} onClose={() => setRepeatSource(null)} onCreated={() => { setNotice("Routine created. Find it in Tasks → Routines."); refreshRuns(); }} /> : null}
{showFirstRun && teamWorkspaceId && workspaceAuthorityReady ? (
            <TeamOnboardingDraft key={`${orchestratorName}:${teamWorkspaceId}`} workspaceId={teamWorkspaceId} workspaceName={teamWorkspace?.name} actorId={orchestratorName?.trim().toLowerCase()} onStageTask={stageTeamSetupTask} onConfigureEmployee={teamWorkspace && ["owner", "admin"].includes(teamWorkspace.membership.role) ? (templateId) => { setInitialEmployeeTemplateId(templateId); setShowFirstRun(false); openView("custom-agents"); } : undefined} onClose={() => setShowFirstRun(false)} onOpenRooms={() => { setShowFirstRun(false); openView("threads"); }} />
          ) : showFirstRun && privateDataEnabled ? (
            <OnboardingJourney
              key={orchestratorName ?? "pending"}
              status={journey}
              stage={activeJourneyStage}
              onSelectStage={setJourneyStage}
              onSkip={() => { void dismissOutcomeSetup().then(() => setShowFirstRun(false)).catch(() => setNotice("Your setup place could not be saved. Retry Skip for now.")); }}
              workspace={{
                personalReady: signedIn && workspaceAuthorityReady && !restrictedTeamMember,
                workspaces: teamDirectory.workspaces.map((item) => ({ id: item.workspaceId, name: item.name, role: item.membership?.role })),
                selectedId: teamWorkspaceId || null,
                canCreate: workspaceAuthorityReady && !restrictedTeamMember && !teamDirectory.error,
                onSelect: (id) => { flushDraft(); roomRoute.clear(); teamDirectory.selectWorkspace(id ?? ""); },
                onCreate: createJourneyWorkspace,
              }}
              provider={{
                ready: providerReadiness.ready,
                pending: providerReadiness.pending,
                label: providerReadiness.label,
                findings: providerReadiness.findings,
                error: providerReadiness.error,
                onOpenProviders: () => { setShowFirstRun(false); openView("providers"); },
                onRecheck: refreshProviderReadiness,
              }}
              employees={journeyEmployees}
              selectedEmployeeId={journeyDraft?.employeeId ?? null}
              onSelectEmployee={selectJourneyEmployee}
              onCreateEmployee={(templateId) => { setInitialEmployeeTemplateId(templateId); setShowFirstRun(false); openView("custom-agents"); }}
              approval={journeyApproval ? { approvalId: journeyApproval.approvalId, task: journeyApproval.task, repoUrl: journeyApproval.repoUrl } : null}
              otherApprovalCount={journeyOtherApprovalCount}
              onReviewApproval={(approval) => {
                // The decision is taken on the existing approval surface, so the
                // guide steps aside and the person lands on that surface rather
                // than at the top of a new view.
                setShowFirstRun(false);
                inspectWork(approval.approvalId, "approval", "approval");
                let frames = 0;
                const land = () => {
                  const card = document.querySelector<HTMLElement>(`[data-approval-id="${CSS.escape(approval.approvalId)}"]`);
                  if (card) card.focus();
                  else if (frames++ < 20) window.requestAnimationFrame(land);
                };
                window.requestAnimationFrame(land);
              }}
              onOpenApprovals={() => { setShowFirstRun(false); openView("approvals"); }}
              draftPrepared={Boolean(journeyDraft?.preparedAt && firstRunProgress?.draftTaskId)}
              onSendForApproval={() => { if (preparedOnboardingSelection) applyOnboardingDraft(preparedOnboardingSelection, true); }}
              onOpenDraft={() => setJourneyStage("task")}
              run={journeyRun}
              onOpenRun={() => { if (journeyRun) { setShowFirstRun(false); inspectWork(journeyRun.runId, "run", "steps"); } }}
              onOpenReview={() => { setShowFirstRun(false); openView("threads"); }}
              taskStage={
                <ConversationalOnboarding key={`${orchestratorName ?? "pending"}:task`} progress={firstRunProgress}
                  onUpdate={updateFirstRunProgress} onResume={resumeFirstRunProgress} onRefresh={refreshFirstRunProgress}
                  onDismiss={dismissOutcomeSetup} onClose={() => setShowFirstRun(false)} onNavigate={(view) => { if (view === "memory") setMemoryView("sources"); openView(view); }}
                  onLegacyGuide={() => { setShowFirstRun(false); setShowLegacyFirstRun(true); }}
                  onConfigureEmployee={(templateId) => { setInitialEmployeeTemplateId(templateId); setShowFirstRun(false); openView("custom-agents"); }}
                  onUseDraft={applyOnboardingDraft} employees={customAgentRecords} draftScope={orchestratorName ?? undefined} />
              }
            />
          ) : (!roomRoute.ready || (teamIdentityAvailable && (!teamDirectory.verified || teamDirectory.error))) && mainView !== "team" ? (
            <section className="m-4 min-w-0 border border-[var(--border-1)] bg-[var(--card)] p-6 text-sm text-[var(--fg)]" aria-label="Workspace verification"><h1 className="text-xl font-medium">{teamDirectory.loading || roomRoute.pending ? "Checking workspace access…" : "Workspace access could not be verified"}</h1>{teamDirectory.error || !roomRoute.ready && !teamDirectory.loading ? <><p className="mt-3 text-[var(--muted-foreground-2)]">{teamDirectory.error ?? "This room link is invalid or its workspace is unavailable to your account. Links do not grant access."}</p><button type="button" className="mt-4 min-h-11 border border-[var(--border-1)] px-4" onClick={() => { void teamDirectory.refresh(); }}>Retry workspace access</button><button type="button" className="ml-3 min-h-11 border border-[var(--border-1)] px-4" onClick={() => { roomRoute.clear(); teamDirectory.selectWorkspace(""); }}>Open personal workspace</button></> : <p role="status" className="mt-3">Your selected workspace is being checked before conversations load.</p>}</section>
          ) : restrictedTeamMember && !teamWorkspaceId && !["team", "providers", "memory"].includes(mainView) ? (
            <TeamWorkspaceView actorId={orchestratorName?.trim().toLowerCase() ?? null} invitationToken={invitationToken}
              onOpenAgents={() => openView("custom-agents")} onOpenToolPolicy={teamWorkspaceId ? undefined : () => openView("employee-tools")}
              onInvitationAccepted={(id) => { setInvitationToken(""); void teamDirectory.refresh().then(() => teamDirectory.selectWorkspace(id)); }}
              onSelectWorkspace={(id) => { roomRoute.clear(); void teamDirectory.refresh().then(() => teamDirectory.selectWorkspace(id)); }} onChanged={() => { void teamDirectory.refresh(); }} />
          ) : personalOnlyNotice ? (
            <section className="m-4 min-w-0 border border-[var(--border-1)] bg-[var(--card)] p-6 text-sm text-[var(--fg)]" aria-label="Personal workspace feature"><h1 className="text-xl font-medium">Open this feature in your personal workspace</h1><p className="mt-3 max-w-xl text-[var(--muted-foreground-2)]">This view uses personal or deployment settings. Team messages, context and results stay in the selected team’s shared chat and Work views.</p><button type="button" className="mt-4 min-h-11 border border-[var(--border-1)] px-4" onClick={() => { roomRoute.clear(); teamDirectory.selectWorkspace(""); }}>Switch to personal workspace</button><button type="button" className="ml-3 min-h-11 border border-[var(--border-1)] px-4" onClick={() => openView("threads")}>Open team chat</button></section>
          ) : mainView === "inbox" ? null : mainView === "work" ? (
            <div className="flex min-h-0 flex-1 p-3 gap-3 overflow-hidden">
              <div id="work-panel" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
                {teamWorkspaceId ? <aside className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] bg-[var(--card)] px-4 py-3 text-xs"><p>Plan your first team task with optional role and employee choices. Saved drafts start no work.</p><button type="button" disabled={authMode !== "better-auth"} className="min-h-11 border border-[var(--line)] px-3 disabled:opacity-50" onClick={() => setShowFirstRun(true)}>{authMode === "better-auth" ? "Set up a team task" : "Saved setup requires email sign-in"}</button></aside> : null}
                {showEmployeeOnboarding ? <EmployeeOnboarding onSelect={setupEmployee} onSkip={dismissEmployeeOnboarding} /> : null}
                <WorkView
                  key={`${orchestratorName}:${teamWorkspaceId || "personal"}`}
                  routinesEnabled={privateDataEnabled && !teamWorkspaceId}
                  routinesRefreshToken={refreshToken}
                  onRepeatTask={!teamWorkspaceId ? (run) => setRepeatSource(routineSourceFromRun(run)) : undefined}
                  view={workViewMode}
                  onViewChange={setWorkViewMode}
                  sidebarCollapsed={workPanelCollapsed}
                  onToggleSidebar={toggleWorkPanelCollapsed}
                  onScopeChange={handleScopeChange}
                  employees={workEmployees}
                  // Browsing the org chart must not rewrite the composer's bot or model settings.
                  onOpenEmployee={(id) => { setInitialEmployeeId(id); openView("custom-agents"); }}
                  // The approvals queue is personal-only; team workspaces would land on a notice.
                  onOpenApprovals={teamWorkspaceId ? undefined : () => setMainView("approvals")}
                  onOpenChief={teamWorkspaceId ? undefined : () => { void handleSelectSession("default"); openView("threads"); }}
                  onOpenChiefPage={teamWorkspaceId ? undefined : () => openView("chief-of-staff")}
                  // In a team workspace only owners and admins configure employees.
                  onHireEmployee={teamWorkspaceId && teamWorkspace?.membership.role !== "owner" && teamWorkspace?.membership.role !== "admin" ? undefined : () => openView("custom-agents")}
                  onOpenOutputs={teamWorkspaceId ? undefined : () => openView("outputs")}
                  workspaceId={teamWorkspaceId || undefined}
                  workspaceName={teamWorkspace?.name}
                  currentActorId={orchestratorName ? `human:${orchestratorName.trim().toLowerCase()}` : undefined}
                  sharedTasks={sharedWork.tasks}
                  sharedTasksLoading={sharedWork.loading}
                  sharedTasksError={sharedWork.error ?? undefined}
                  onCreateTask={(title, patch) => sharedWork.create(title, patch)}
                  onUpdateTask={(id, patch) => { void sharedWork.update(id, patch); }}
                  onArchiveTask={(id) => { void sharedWork.archive(id); }}
                  onCommentTask={(id, text) => { void sharedWork.comment(id, text); }}
                  agents={teamWorkspaceId ? mentionableAgents.map((agent) => ({ ...agent, id: `agent:${agent.id}` })) : mentionableAgents}
                  onOpenTeam={() => openView("team")}
                  onOpenSharedTask={(item) => { setSharedRoomId(item.roomId); setSharedHandoffId(item.id); setMainView("threads"); }}
                  runs={retainedRuns}
                  sessions={sessions}
                  storedApprovals={visibleStoredApprovals}
                  decidedApprovals={decidedStoredApprovals}
                  runsDetailReady={runsDetailReady}
                  selectionResolved={storedApprovalsSettled && listSettled}
                  onMissingSelection={() => applyWorkSelection({ view: workViewMode, task: null, tab: "steps" }, "replace")}
                  pendingApprovals={pendingApprovals}
                  requestedState={workInspectionRequest}
                  onDecideApproval={decideApproval}
                  onDecideStoredApproval={decideStoredApproval}
                  claimConflicts={claimConflicts}
                  approvalDecisions={{ ...decisions, ...storedDecisions }}
                  approvalDecisionResults={Object.fromEntries(Object.entries(storedDecisionReceipts).map(([id, receipt]) => [id, receipt.result]))}
                  runsError={runsError}
                  peekSessionId={selectedSessionId}
                  peekNotice={notice}
                  renderPeekContent={(task, tab) => {
                    if (tab !== "steps" || task.kind !== "session" || task.id !== selectedSessionId ||
                      sessionRegistryOwner !== orchestratorName || agent.name !== chatAgentName ||
                      !agent.identified || agent.connectionError || !chat.messages.length) return undefined;
                    return <><StepTimeline messages={chat.messages}
                      isStreaming={chat.isStreaming || chat.status === "streaming"}
                      pendingApprovals={pendingApprovals} decisions={decisions}
                      onDecideApproval={decideApproval} reviewAfterPublishById={reviewAfterPublishById} />
                      {chatAgentName ? <UiBlockQuestions key={chatAgentName} runId={chatAgentName} sessionId={selectedSessionId} /> : null}</>;
                  }}
                  onSearchChange={(state) => writeWorkSearch(state, false)}
                  onSearchRestore={(state) => writeWorkSearch(state, true)}
                  onSelectTask={(id, kind) => {
                    if (kind === "approval") { setMainView("approvals"); return; }
                    void handleSelectSession(id);
                    setMainView("threads");
                  }}
                  newTaskBlockedReason={taskCreationBlocker ?? undefined}
                  onNewTask={taskCreationBlocker ? undefined : handleNewTask}
                  onQuickAddTask={taskCreationBlocker ? undefined : async (taskText) => {
                    const id = await handleNewTask();
                    if (!id) return false;
                    if (!orchestratorName) return false;
                    const scope = composerDraftScope(orchestratorName, id);
                    quickDraft.current = { scope, text: taskText };
                    writeDraft(scope, taskText);
                    setTask(taskText);
                    return true;
                  }}
                  onOpenRunTab={(runId, tab) => {
                    // Stay in Work: select the run itself so its steps and diff are loaded.
                    applyWorkSelection({ view: workViewMode, task: runId, taskKind: "run", tab }, "push");
                  }}
                  onReviewApproval={(approvalId) => {
                    // Stay in Work: the review is a tab on the same receipt.
                    applyWorkSelection({ view: workViewMode, task: approvalId, taskKind: "approval", tab: "approval" }, "push");
                  }}
                />
              </div>
            </div>
          ) : mainView === "tasks" ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {showEmployeeOnboarding ? <EmployeeOnboarding onSelect={setupEmployee} onSkip={dismissEmployeeOnboarding} /> : null}
            <TasksHomeView
              workspaceId={teamWorkspaceId || undefined}
              task={composerVisible ? task : ""}
              onTaskChange={setTask}
              onAutomationDraft={(prompt) => { setAutomationDraft({ prompt, repoUrl }); openView("automations"); }}
              onOpenSuggestion={(item) => {
                if (item.kind === "setup") {
                  const step = nudgeStatus?.steps.find((candidate) => item.id === `setup:${candidate.id}`);
                  if (step) void resumeNudgeStep(step);
                  else openFirstRun();
                  return;
                }
                const view = item.action.payload.view;
                if (view && isNavId(view)) openView(view);
              }}
              agents={customAgentRecords.map((profile) => ({
                id: profile.id,
                name: profile.config.name,
                slug: profile.slug,
                emoji: profile.config.emoji,
                defaultRepoUrl: profile.config.defaultRepoUrl,
                mascotPreset: profile.config.mascotPreset,
                avatar: profile.config.avatar,
                look: profile.config.look,
                role: employeeRole(profile.slug, profile.config.roleTemplateId),
              }))}
              agentsLoading={customAgentsLoading}
              selectedAgentId={customAgentId}
              onAgentChange={(id) => {
                const profile = customAgentRecords.find((candidate) => candidate.id === id);
                if (profile) {
                  if (!customAgentId) builtinTaskDefaults.current = { harness, codingModel, connectionId, repoUrl, runTarget };
                  setCustomAgentId(profile.id);
                  applyThreadProfile(profile);
                  if (!profile.config.defaultRepoUrl && !repoUrl) setRepoUrl(repoSuggestions[0] ?? "");
                } else {
                  setCustomAgentId("");
                  const defaults = builtinTaskDefaults.current;
                  setHarness(defaults?.harness ?? "opencode");
                  setCodingModel(defaults?.codingModel ?? "");
                  setConnectionId(defaults?.connectionId ?? "");
                  setRepoUrl(defaults?.repoUrl ?? "");
                  setRunTarget(defaults?.runTarget ?? "sandbox");
                  setPublishPullRequest(false);
                }
                setNotice(null);
              }}
              repoUrl={repoUrl}
              repoSuggestions={repoSuggestions}
              onRepoUrlChange={setRepoUrl}
              runs={retainedRuns}
              approvals={visibleStoredApprovals}
              pendingApprovals={pendingApprovals}
              busy={busy}
              submitNotice={notice}
              route={{ harness, codingModel, connectionId, runTarget }}
              onOpenModels={() => { setSettingsSection("models"); setMainView("settings"); }}
              onOpenProviders={() => { setSettingsSection("providers"); setMainView("settings"); }}
              onSubmit={async (event, agentId) => { await submitTask(event, { forceWork: true, customAgentId: agentId }); }}
              onOpenRun={(runId) => { void handleSelectSession(runId); }}
              onOpenApproval={() => setMainView("approvals")}
              onToggleAgents={toggleSessionsCollapsed}
              agentsOpen={!sessionsCollapsed}
            />
            </div>
          ) : mainView === "dashboard" ? (

            <DashboardView
              runs={retainedRuns}
              pendingApprovals={pendingApprovals}
              storedApprovals={visibleStoredApprovals}
              agents={agentPrincipals}
              employees={workEmployees}
              workspaceName={teamWorkspace?.name}
              sharedTasks={teamWorkspaceId ? sharedWork.tasks : []}
              sharedTasksLoading={Boolean(teamWorkspaceId && sharedWork.loading)}
              onOpenSharedTask={(taskId) => {
                applyWorkSelection({ view: workViewMode, task: taskId, tab: "steps" }, "push");
                setMainView("work");
              }}
              scope={teamWorkspaceId ? "workspace" : "personal"}
              launchBlocked={launchBlocked}
              connectionLabel={connectionState}
              connectionTone={
                identityError || agent.connectionError
                  ? "error"
                  : launchBlocked || !agent.identified
                    ? "pending"
                    : "ok"
              }
              runsError={runsError}
              onNavigate={openView}
              onNewTask={handleNewTask}
              onInspectRun={openRunInAnalytics}
            />
          ) : mainView === "threads" && teamWorkspaceId ? (
            <CollaborationView key={`${orchestratorName}:${teamWorkspaceId}`} workspaceId={teamWorkspaceId} initialRoomId={roomRoute.roomId ?? sharedRoomId} initialHandoffId={sharedHandoffId} initialEmployeeId={sharedEmployeeId} incomingMention={incomingRoomMention} onMentionConsumed={(id) => setRoomMention((current) => current?.id === id ? undefined : current)} incomingTaskDraft={currentSlackTask ?? undefined} onTaskDraftConsumed={(id) => setIncomingSlackTask((current) => current?.id === id ? null : current)} onRoomChange={(id) => { setSharedRoomId(id); roomRoute.onRoomChange(id); }} onOpenNotificationPreferences={teamWorkspaceId ? undefined : () => { setSettingsSection("notifications"); openView("settings"); }}
              renderApproval={(handoff) => teamWorkspaceId && handoff.senderActorId === `human:${orchestratorName?.trim().toLowerCase()}` ? <RoomApprovalReview workspaceId={teamWorkspaceId} workspaceName={teamWorkspace?.name} roomId={handoff.roomId} handoffId={handoff.handoffId} actorId={orchestratorName?.trim().toLowerCase() ?? null} /> : null}
              renderExecution={(handoff) => <RoomExecutionPanel key={`${handoff.handoffId}:${handoff.runId}:${handoff.execution?.approvalStatus}`} workspaceId={teamWorkspaceId} roomId={handoff.roomId} handoffId={handoff.handoffId} runId={handoff.runId} />} />
          ) : mainView === "threads" ? (
            <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto xl:flex-row xl:overflow-hidden">
              {/* Mobile sessions drawer (below lg) */}
              {mobileSessionsOpen ? (
                <div className="fixed inset-0 z-40 lg:hidden">
                  <button
                    type="button"
                    aria-label="Close sessions"
                    className="absolute inset-0 bg-[var(--overlay)]"
                    onClick={() => setMobileSessionsOpen(false)}
                  />
                  <div className="absolute inset-y-0 left-0 shadow-[var(--sh-overlay)] bg-[var(--bg)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] animate-enter-x">
                    <SessionsSidebar
                      variant="sessions"
                      sessions={sessions}
                      agents={agentPrincipals}
                      selectedId={selectedRunId ?? selectedSessionId}
                      onSelect={handleSelectSession}
                      onNewTask={handleNewTask}
                      connectionLabel={connectionState}
                      connectionTone={
                        identityError || agent.connectionError
                          ? "error"
                          : launchBlocked || !agent.identified
                            ? "pending"
                            : "ok"
                      }
                      setupDone={setupDone}
                      setupTotal={SETUP_TOTAL_STEPS}
                      onOpenSetup={() => {
                        setMobileSessionsOpen(false);
                        openFirstRun();
                      }}
                      isMobileDrawer={true}
                      onToggleCollapse={() => setMobileSessionsOpen(false)}
                    />
                  </div>
                </div>
              ) : null}

              {/* CENTER: conversation timeline + composer */}
              <main
                className={`group/thread flex min-h-full min-w-0 shrink-0 flex-col bg-[var(--bg)] xl:min-h-0 ${conversationMode === "chat" ? "flex-[1_0_auto] xl:flex-1 xl:overflow-y-auto" : "flex-1 overflow-hidden"}`}
                aria-busy={busy}
              >
                {botPage !== "chat" ? (
                  <BotThreadlessState
                    name={chatAgent.name}
                    slug={activeEmployee?.slug}
                    role={chatAgent.role}
                    agentId={chatAgent.id}
                    mascotPreset={chatAgent.mascotPreset}
                    look={chatAgent.look}
                    avatar={chatAgent.avatar}
                    busy={threadLinkPending}
                    state={botPage}
                    message={botPageMessage ?? undefined}
                    onStart={() => void startSidebarAgentThread(activeEmployee)}
                  />
                ) : (
                  <>
                <AgentChatHeader
                  sideQuestion={sessionCustomAgentId && selectedSessionId !== "default" && !teamWorkspaceId ? { employeeId: sessionCustomAgentId, threadId: selectedSessionId } : undefined}
                  agent={chatAgent}
                  thread={selectedSessionId !== "default" && activeWebSession ? {
                    name: activeWebSession.name,
                    state: chat.isStreaming || chat.status === "streaming" || chat.status === "submitted"
                      ? "working"
                      : pendingApprovals.length + threadStoredApprovals.length > 0 ? "waiting" : "idle",
                  } : undefined}
                  participants={[{ id: "you", name: "You" }, { id: chatAgent.id, name: chatAgent.name }]}
                  panelOpen={agentDetailsOpen}
                  onTogglePanel={() => setAgentDetailsOpen((open) => !open)}
                  // Only offer task details when this thread is backed by a real run.
                  onOpenTaskDetails={chatDetailsRunId ? () => {
                    applyWorkSelection({ view: "board", task: chatDetailsRunId, taskKind: "run", tab: "steps" }, "push");
                    setMainView("work");
                  } : undefined}
                  workspaceLabel={teamWorkspace?.name ?? "Personal"}
                  actions={[
                    ...(sessionsCollapsed ? [{ label: "Show sidebar", onSelect: toggleSessionsCollapsed }] : []),
                    { label: "Start shared conversation", onSelect: () => { setNotice("Choose a team workspace, then start a shared conversation. Your private messages are not copied."); openView("team"); } },
                    { label: "Edit agent", onSelect: () => openView("custom-agents") },
                  ]}
                />
                {showEmployeeOnboarding ? <div className="max-h-[65vh] shrink-0 overflow-y-auto"><EmployeeOnboarding onSelect={setupEmployee} onSkip={dismissEmployeeOnboarding} /></div> : null}
                {!threadHasWork && sessionApiAvailable && activeWebSession && selectedSessionId !== "default" ? <div className="shrink-0 px-4 py-2"><ThreadTitleEditor key={selectedSessionId} sessionId={selectedSessionId} name={activeWebSession.name} onRenamed={(renamed) => setWebSessions((current) => applyThreadRename(current, renamed))} /></div> : null}
                {/* Keep the existing session actions on nonempty threads. */}
                <div className={`${threadHasWork ? "flex" : "hidden"} border-b border-[var(--border-1)] bg-[var(--card)]/60 px-3 sm:px-5 xl:px-6 py-2.5 items-center justify-between gap-3 shrink-0`}>
                  <div className="flex items-center gap-2.5 min-w-0">
                    {/* Desktop sidebar toggle button */}
                    <Tooltip
                      content={sessionsCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                      shortcut="⌘B"
                      side="bottom"
                    >
                      <button
                        type="button"
                        onClick={toggleSessionsCollapsed}
                        aria-label={sessionsCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                        aria-expanded={!sessionsCollapsed}
                        className="hidden lg:flex w-7 h-7 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] items-center justify-center transition-colors shrink-0"
                      >
                        <svg
                          aria-hidden="true"
                          className="w-4 h-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          {sessionsCollapsed ? (
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={1.8}
                              d="M13 5l7 7-7 7M5 5l7 7-7 7"
                            />
                          ) : (
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={1.8}
                              d="M11 19l-7-7 7-7m8 14l-7-7 7-7"
                            />
                          )}
                        </svg>
                      </button>
                    </Tooltip>

                    {/* Mobile open sessions button */}
                    <Tooltip content="Open sessions drawer" side="bottom">
                      <button
                        type="button"
                        onClick={() => setMobileSessionsOpen(true)}
                        aria-label="Open sessions"
                        className="lg:hidden w-7 h-7 touch:w-11 touch:h-11 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] text-[var(--muted-foreground-2)] hover:text-[var(--fg)] flex items-center justify-center transition-colors shrink-0"
                      >
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
                            strokeWidth={1.8}
                            d="M9 4H5a1 1 0 00-1 1v14a1 1 0 001 1h4M15 4h4a1 1 0 011 1v14a1 1 0 01-1 1h-4M12 4v16"
                          />
                        </svg>
                      </button>
                    </Tooltip>

                    <Tooltip content="Shiba Coding Agent" side="bottom">
                      <span className="shrink-0 cursor-default">
                        <ShibaMark className="size-6" decorative />
                      </span>
                    </Tooltip>
<ConversationWorkspaceHeading
                      title={appToolsWork && conversationMode === "work" ? activeWebSession?.name ?? "New app task" : liveSession ? liveSession.title : "New coding task"}
                      mode={conversationMode}
                      appToolsWork={appToolsWork}
                      executionTargetKind={executionTargetKind}
                      runTarget={runTarget}
                      repoUrl={repoUrl}
                      artifactWorkspaceName={artifactWorkspaceName}
                      machineName={localComputers.find((computer) => computer.machineId === selectedLocalMachineId)?.hostname}
                    />
                    {threadHasWork && sessionApiAvailable && activeWebSession && selectedSessionId !== "default" ? (
                      <ThreadTitleEditor
                        key={selectedSessionId}
                        sessionId={selectedSessionId}
                        name={activeWebSession.name}
                        onRenamed={(renamed) => setWebSessions((current) => applyThreadRename(current, renamed))}
                      />
                    ) : null}
                    <span
                      className={conversationMode === "chat"
                        ? "text-[10px] font-mono font-bold uppercase tracking-wider border border-[var(--primary)]/40 text-[var(--primary)] px-2 py-0.5 shrink-0"
                        : `text-[10px] font-mono font-bold uppercase tracking-wider border px-2 py-0.5 shrink-0 ${statusChipClass(liveSession?.status ?? "ready")}`}
                    >
                      {conversationMode === "chat" ? "Chat only" : statusLabel(liveSession?.status ?? "ready")}
                    </span>
                  </div>

                  <div className="hidden md:flex items-center gap-4 text-xs font-mono text-[var(--muted-foreground-2)] shrink-0">
                    <Tooltip content="Tool runs currently in flight" side="bottom">
                      <span className="cursor-default">
                        <span className="text-[var(--muted-foreground-2)]">Active</span>{" "}
                        <span className="text-[var(--primary)] font-bold">{toolRuns.length}</span>
                      </span>
                    </Tooltip>
                    <Tooltip content="Actions waiting for human approval" side="bottom">
                      <span className="cursor-default">
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
                {pendingApprovalCount > 0 ||
                approvalAnnouncement ? (
                  <div className="bg-[var(--card)] border-b border-[var(--border-1)] px-3 sm:px-5 xl:px-6 py-3 flex items-center justify-between gap-3 shadow-[var(--sh-card)] z-10 shrink-0">
                    <p
                      className="text-sm font-medium text-[var(--fg)]"
                      role="status"
                      aria-live="polite"
                    >
                      {pendingApprovalCount > 0 ? (
                        <span className="flex items-center gap-2 text-[var(--warning-fg)]">
                          <span className="w-2.5 h-2.5 rounded-full bg-[var(--warning-fg)] animate-pulse" />
                          {hasSignInApproval && pendingApprovalCount === 1
                            ? "Saved sign-in waiting for your approval."
                            : `${pendingApprovalCount} ${hasSignInApproval ? "request" : "task"}${pendingApprovalCount === 1 ? "" : "s"} waiting for your approval.`}
                        </span>
                      ) : (
                        <span className="text-[var(--success-fg)] flex items-center gap-2">
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
                        className="text-xs text-[var(--destructive-fg)] bg-[var(--destructive-soft)] p-3 rounded-[var(--radius-button)] border border-[color-mix(in_oklch,var(--destructive)_30%,transparent)] flex items-start gap-2"
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
                      <div className="text-xs text-[var(--destructive-fg)] bg-[var(--destructive-soft)] p-3 rounded-[var(--radius-button)] border border-[color-mix(in_oklch,var(--destructive)_30%,transparent)] flex items-start gap-2">
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

                <details className="mx-3 mt-3 shrink-0 rounded-[var(--radius-card)] border border-[var(--border-1)] bg-[var(--card)]/70 px-3 py-2 sm:mx-5 xl:mx-8">
                  <summary className="cursor-pointer select-none text-xs font-medium text-[var(--muted-foreground-1)]">
                    Task history · {taskHistoryItems.length}
                  </summary>
                  <div className="mt-3 max-h-[35vh] overflow-y-auto">
                    <TaskHistory
                      tasks={taskHistoryItems}
                      loading={taskHistoryLoading}
                      error={taskHistoryError}
                      onRetry={retryTaskHistory}
                      onCancel={cancelTaskHistory}
                      onSelectRun={openRunInAnalytics}
                    />
                  </div>
                </details>

                {/* TIMELINE (scrollable) — hidden on the empty-state hero */}
                <div
                  className={`min-h-0 px-3 sm:px-5 xl:px-8 py-5 ${conversationMode === "chat" ? "flex-auto xl:flex-1 xl:overflow-y-auto xl:overscroll-contain" : "flex-1 overflow-y-auto overscroll-contain"} ${threadHasWork ? "" : "hidden"}`}
                >
                  {conversationMode === "chat" ? <RemoteAgentStream stream={realtimeRemoteStream} /> : null}
                  {privateDataEnabled && chatAgentName && conversationMode !== "chat" ? <UiBlockQuestions key={chatAgentName} runId={chatAgentName} sessionId={selectedSessionId} /> : null}
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
                      }}
                    />
                  ) : null}
                  {reviewThreadId ? (
                    <div className="mt-4 flex flex-col gap-3">
                      <RunProgressCard
                        run={reviewRun}
                        sessionId={selectedSessionId}
                        onCancel={retainedReviewRun ? cancelRun : undefined}
                        cancelling={cancellingRunId === reviewRun?.runId}
                        publicationApprovals={storedApprovals}
                        onReviewPublication={(approvalId) => {
                          applyWorkSelection({ view: "board", task: approvalId, taskKind: "approval", tab: "approval" }, "push");
                          setMainView("work");
                        }}
                      />
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

                {privateDataEnabled && !threadLinkPending && conversationMode === "chat" ? (
                  <BrowserPanel key={orchestratorName} sessionId={selectedSessionId} />
                ) : null}

                {/* COMPOSER — hero when the session is empty, docked once the run is going */}
                <div
                  className={
                    chat.messages.length === 0 && !reviewThreadId
                      ? `flex flex-col min-h-0 ${conversationMode === "chat" ? "flex-auto xl:flex-1" : "flex-1"}`
                      : "border-t border-[var(--border-1)] bg-[var(--card)]/60 px-3 sm:px-5 xl:px-8 pt-3 sm:pt-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-[max(1rem,env(safe-area-inset-bottom))] shrink-0"
                  }
                >
                  {conversationMode === "chat" ? (
                    <ConversationRoomPresence
                      status={realtimeStatus}
                      viewers={realtimeViewers}
                      viewerId={realtimeViewerId}
                    />
                  ) : null}
                  <ConversationModeSwitch
                    value={conversationMode}
                    onChange={setConversationMode}
                    disabled={chat.isStreaming || chat.status === "streaming" || chat.status === "submitted"}
                  />
                  {firstRunProgress?.draftTask ? <section aria-label="Saved first task draft" className="mx-3 mt-3 rounded-[var(--radius-panel)] border border-[var(--border-1)] bg-[var(--card)] p-3 text-xs text-[var(--fg)]">
                    <strong>{firstRunProgress.draftTask.preparedAt ? "First task draft saved" : "First task setup saved"}</strong>
                    <p className="mt-1 break-words">{firstRunProgress.draftTask.goal || "Continue shaping your first outcome."}</p>
                    <div className="mt-2 flex flex-wrap gap-3"><button type="button" onClick={openFirstRun} className="text-[var(--primary)]">Review setup draft</button>{preparedOnboardingSelection ? <button type="button" onClick={() => applyOnboardingDraft(preparedOnboardingSelection)} className="text-[var(--primary)]">Use first task draft</button> : null}</div>
                    <p className="mt-2 text-[var(--muted-foreground-2)]">Saved brief only. Employee configuration and access are checked before work starts.</p>
                    {firstRunProgress.draftTask.employeeTemplateId && !firstRunProgress.draftTask.employeeId ? <button type="button" className="mt-2 text-[var(--primary)]" onClick={() => { setInitialEmployeeTemplateId(firstRunProgress.draftTask?.employeeTemplateId ?? null); openView("custom-agents"); }}>Configure suggested employee</button> : null}
                  </section> : null}
                  {composerVisible && selectedOnboardingDraftRef ? <div role="group" aria-label="Selected first-task goal" className="mx-3 mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--fg)]"><span>First-task goal · v{selectedOnboardingDraftRef.version}{!activeOnboardingRef ? " · saved version needs review" : ""}</span><button type="button" onClick={() => setSelectedOnboardingDraftRef(null)} className="text-[var(--primary)]">Remove first-task goal link</button></div> : null}
                  {pendingOnboardingDraft ? <section role="alertdialog" aria-modal="false" aria-label="Replace unsent task" className="mx-3 mt-3 border border-[var(--border-1)] bg-[var(--card)] p-3 text-xs text-[var(--fg)]"><p>Replace the unsent task with your saved first task draft?</p><div className="mt-2 flex gap-3"><button type="button" onClick={() => setPendingOnboardingDraft(null)}>Keep current task</button><button type="button" onClick={() => applyOnboardingDraft(pendingOnboardingDraft, true)}>Replace with saved draft</button></div></section> : null}
                  {conversationMode === "chat" && chat.messages.length > 0 ? (
                    <div className="flex justify-end px-3 sm:px-5 xl:px-8 pt-2">
                      <button
                        type="button"
                        onClick={() => setShowClearModal(true)}
                        disabled={clearing || isSubmitting}
                        className="text-[10px] font-mono text-[var(--muted-foreground-3)] hover:text-[var(--fg)] disabled:opacity-50"
                      >
                        Clear conversation
                      </button>
                    </div>
                  ) : null}
                  {conversationMode === "chat" ? (
                    <div className={
                      chat.messages.length === 0 && !reviewThreadId
                        ? "flex min-h-0 flex-auto flex-col items-center [justify-content:safe_center] gap-5 px-3 sm:px-5 xl:flex-1 xl:overflow-y-auto xl:px-8 py-5"
                        : "shrink-0 px-3 sm:px-5 xl:px-8 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
                    }>
                      {chat.messages.length === 0 ? (
                        <div className="contents group-has-[[data-browser-expanded]]/thread:hidden"><AgentChatEmptyState agent={chatAgent} onOpenToolPolicy={teamWorkspaceId ? undefined : () => openView("employee-tools")} /></div>
                      ) : null}
                      {privateDataEnabled && chatAgentName && !busy && !chat.error &&
                        (chat.messages.length === 0 || chat.messages.at(-1)?.role === "assistant") ? (
                        <ChatSuggestions agentName={chatAgentName} refreshKey={chat.messages.at(-1)?.id ?? "empty"} busy={busy} hidden={!composerVisible || task.trim() !== ""} onPick={pickSuggestion} />
                      ) : null}
                      <AgentComposerShell
                        key={composerScope}
                        agentName={employeeName}
                        agents={mentionableAgents}
                        value={composerVisible ? task : ""}
                        onChange={setTask}
                        onPrepareWork={() => setConversationMode("work")}
                        onSubmit={(event, create) => submitTask(event, { create })}
                        onVideoHandoff={composerVisible && videoHandoffScope === composerScope ? consumeVideoHandoff : undefined}
                        onStop={() => { void chat.stop(); }}
                        onRetry={() => { void chat.regenerate(); }}
                        busy={!composerVisible || isSubmitting || clearing || threadLinkPending}
                        streaming={chat.isStreaming || chat.isRecovering || chat.status === "streaming" || chat.status === "submitted"}
                        failed={Boolean(chat.error)}
                        lookups={chatLookups}
                        onToggleLookup={(id) => setChatLookupIds((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id])}
                      />
                    </div>
                  ) : (
                  <TaskComposer
                    onRepeat={privateDataEnabled && !teamWorkspaceId && !appToolsWork && runTarget === "sandbox" && !useCloudComputer ? () => {
                      const normalizedRepoUrl = normalizeRepositoryInput(repoUrl);
                      if (executionTargetKind === "repository" && !normalizedRepoUrl) { setNotice(REPOSITORY_INPUT_ERROR); return; }
                      const deliverables = parseArtifactDeliverables(artifactDeliverables);
                      if (executionTargetKind === "artifact-workspace" && !deliverables.success) { setNotice("Choose valid deliverable paths before creating a routine."); return; }
                      const fields = executionTargetKind === "repository"
                        ? buildExecutionTargetFields({ kind: "repository", repoUrl: normalizedRepoUrl ?? repoUrl.trim(), baseBranch: baseBranch.trim() || "main" })
                        : buildExecutionTargetFields({ kind: "artifact-workspace", workspaceName: artifactWorkspaceName, expectedDeliverables: deliverables.data ?? [] });
                      setRepeatSource({ prompt: task.trim(), executionTarget: fields.executionTarget, customAgentId: customAgentId || undefined });
                    } : undefined}
                    blockedReason={onboardingExecutionIssue ?? (useCloudComputer && envVars.some((entry) => entry.name.trim() !== "") ? "Remove the environment variables or turn off the cloud computer before sending." : null)}
                    appToolsWork={appToolsWork}
                    onAppToolsWorkChange={(value) => {
                      setAppToolsWork(value);
                      if (value) setComputerDraftScope(null);
                    }}
                    appToolsWorkIssue={appToolsWorkIssue(appToolsContext)}
                    onOpenEmployeeTools={() => openView("employee-tools")}
                    repoUrl={repoUrl}
                    task={composerVisible ? task : ""}
                    baseBranch={baseBranch}
                    publishPullRequest={publishPullRequest}
                    reviewAfterPublish={reviewAfterPublish}
                    harness={harness}
                    busy={busy}
                    repoSuggestions={repoSuggestions}
                    skills={selectableSkills}
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
                        setPublishPullRequest(false);
                        setRunSetup(false);
                      }
                    }}
                    artifactWorkspaceName={artifactWorkspaceName}
                    onArtifactWorkspaceNameChange={setArtifactWorkspaceName}
                    artifactDeliverables={artifactDeliverables}
                    onArtifactDeliverablesChange={setArtifactDeliverables}
                    runTarget={runTarget}
                    onRunTargetChange={(value) => {
                      taskRouteChosen.current = true;
                      setRunTarget(value);
                      if (value === "local") setComputerDraftScope(null);
                    }}
                    computer={useCloudComputer}
                    onComputerChange={teamWorkspaceId ? undefined : (enabled) => setComputerDraftScope(enabled ? composerScope : null)}
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
                    attachments={attachments}
                    attachmentsUploading={attachmentsUploading}
                    onAttachFiles={attachFiles}
                    onRemoveAttachment={removeAttachment}
                    onHarnessChange={(value) => { taskRouteChosen.current = true; setHarness(value); }}
                    customAgents={customAgentPickerOptions}
                    customAgentId={customAgentId}
                    projects={projectContexts}
                    projectContextId={projectContextId}
                    onProjectContextChange={setProjectContextId}
                    onApplyProjectDefaults={(project) => {
                      if (project.defaultCustomAgentId) setCustomAgentId(project.defaultCustomAgentId);
                      if (project.defaultHarness) { taskRouteChosen.current = true; setHarness(project.defaultHarness); }
                    }}
                    customAgentsLoading={customAgentsLoading}
                    onCustomAgentChange={setCustomAgentId}
                    routing={{
                      codingModel,
                      connectionId,
                      onCodingModelChange: (value) => { taskRouteChosen.current = true; setCodingModel(value); },
                      onConnectionChange: (value) => { taskRouteChosen.current = true; setConnectionId(value); },
                      reasoningEffort,
                      onReasoningEffortChange: setReasoningEffort,
                      modelSuggestions: codingModelSuggestions,
                      connections: modelConnections,
                    }}
                    envVars={envVars}
                    onEnvVarsChange={setEnvVars}
                    variant={threadHasWork ? "docked" : "hero"}
                    agentName={employeeName}
                    examplePrompts={employeeExamples(activeEmployee)}
                    onSubmit={submitTask}
                    onClear={() => setShowClearModal(true)}
                  />
                  )}
                </div>
                  </>
                )}
              </main>
              {agentDetailsOpen ? (
                <AgentDetailsPanel
                  key={customAgentId || "shiba"}
                  agent={activeEmployee}
                  directoryLoading={customAgentsLoading && Boolean(customAgentId)}
                  workspaceName={teamWorkspace?.name}
                  ownerName={orchestratorName ?? undefined}
                  editing={!teamWorkspaceId && !restrictedTeamMember}
                  modelEdit={botModelEdit}
                  runtime={{
                    harness: activeEmployee?.config.harness ?? harness,
                    sandboxProvider: activeEmployee?.config.sandboxProvider,
                    localAvailable: localRunAvailable,
                    paired: pairedLocalComputers,
                    loading: localComputersLoading,
                    error: localComputersError,
                  }}
                  runs={botRunRows}
                  pendingApprovals={botPendingApprovals}
                  runOutputs={botRunOutputs}
                  runsScope={botRunsScope}
                  onOpenRun={openRunInAnalytics}
                  onOpenApprovals={() => setMainView("approvals")}
                  onManageTools={activeEmployee ? () => openEmployeeToolPolicy(activeEmployee.id) : undefined}
                  onConfigSave={activeEmployee ? (edit) => saveBotConfigEdit(activeEmployee.id, edit) : undefined}
                  onLibrarySave={activeEmployee ? (deliverables) => saveBotLibrary(activeEmployee.id, deliverables) : undefined}
                  onClose={() => setAgentDetailsOpen(false)}
                  onEdit={() => {
                    if (customAgentId) setInitialEmployeeId(customAgentId);
                    openView("custom-agents");
                  }}
                />
              ) : null}
            </div>
          ) : mainView === "activity" ? (
            // Remount on session switch so the previous session's spine never
            // renders as the new one's while its first fetch is in flight.
            <div className="flex-1 overflow-y-auto">
              <ActivityReportView
                key={selectedSessionId}
                sessionId={selectedSessionId}
                sessionApiAvailable={sessionApiAvailable}
                onNavigate={openView}
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
              selectedRun={retainedRuns.find((run) => run.runId === analyticsRunId) ?? allRuns.find((run) => run.runId === analyticsRunId)}
              error={runsError}
              sessionId={selectedSessionId}
              sessionApiAvailable={sessionApiAvailable}
              onNavigate={openView}
              onOpenSettings={(section) => { setSettingsSection(section); openView("settings"); }}
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
              onOpenInWork={(runId) => {
                applyWorkSelection({ view: "board", task: runId, taskKind: "run", tab: "diff" }, "push");
                setMainView("work");
              }}
              onOpenEvidence={(runId) => {
                applyWorkSelection({ view: "board", task: runId, taskKind: "run", tab: "steps" }, "push");
                setMainView("work");
              }}
              publicationApprovals={storedApprovals}
              onOpenApproval={(approvalId) => {
                applyWorkSelection({ view: "board", task: approvalId, taskKind: "approval", tab: "approval" }, "push");
                setMainView("work");
              }}
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
              claimConflicts={claimConflicts}
              orchestratorName={orchestratorName}
              onRefresh={refreshRuns}
              reviewAfterPublishById={reviewAfterPublishById}
              onOpenInWork={(approval) => {
                applyWorkSelection({ view: "board", task: approval.approvalId, taskKind: "approval", tab: "approval" }, "push");
                setMainView("work");
              }}
              onInspectRunDiff={(runId) => {
                applyWorkSelection({ view: "board", task: runId, taskKind: "run", tab: "diff" }, "push");
                setMainView("work");
              }}
              onOpenRunEvidence={(runId) => {
                applyWorkSelection({ view: "board", task: runId, taskKind: "run", tab: "steps" }, "push");
                setMainView("work");
              }}
              liveHarness
            />
          ) : mainView === "memory" ? (
            <MemoryTab
              activeView={memoryView}
              onSelectView={setMemoryView}
              sidebarCollapsed={sessionsCollapsed}
              scope={scope}
              onCountsChange={handleMemoryCountsChange}
              onNavigate={openView}
            />
          ) : mainView === "files" ? (
            <FilesView appPreviewOwner={privateDataEnabled && authMode === "access" ? orchestratorName?.trim().toLowerCase() : undefined} onNavigate={(view) => { if (view === "memory") setMemoryView("sources"); openView(view); }} />
          ) : mainView === "notes" ? (
            <NotesEditor workspaceId={teamWorkspaceId || null} onNavigate={(view) => { if (view === "memory") setMemoryView("sources"); openView(view); }} />
          ) : mainView === "projects" ? (
            <ProjectsView onNavigate={openView} />
          ) : mainView === "outputs" ? (
            <OutputsView onNavigate={openView} onOpenEvidence={(runId) => {
              applyWorkSelection({ view: "board", task: runId, taskKind: "run", tab: "steps" }, "push");
              setMainView("work");
            }} />
          ) : mainView === "automations" ? (
            <AutomationsView initialDraft={automationDraft} onDraftSaved={() => setAutomationDraft(null)} scope={scope} sidebarCollapsed={sessionsCollapsed} onToggleSidebar={toggleSessionsCollapsed} selectedAutomationId={selectedAutomationId} onSelectAutomation={setSelectedAutomationId} onAutomationsChange={setAutomationList} />
          ) : mainView === "swarm" ? (
            <SwarmDeskView
              runs={retainedRuns}
              onOpenRun={(runId) => {
                applyWorkSelection({ view: "board", task: runId, taskKind: "run", tab: "steps" }, "push");
                setMainView("work");
              }}
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
                setMainView("threads");
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
          ) : mainView === "collaboration" ? (
            <CollaborationView key={`legacy:${orchestratorName}:${teamWorkspaceId || "personal"}`} workspaceId={teamWorkspaceId || undefined} initialRoomId={sharedRoomId} initialHandoffId={sharedHandoffId} initialEmployeeId={sharedEmployeeId} incomingMention={incomingRoomMention} onMentionConsumed={(id) => setRoomMention((current) => current?.id === id ? undefined : current)} incomingTaskDraft={currentSlackTask ?? undefined} onTaskDraftConsumed={(id) => setIncomingSlackTask((current) => current?.id === id ? null : current)} onRoomChange={(id) => { setSharedRoomId(id); }} onOpenNotificationPreferences={teamWorkspaceId ? undefined : () => { setSettingsSection("notifications"); openView("settings"); }}
              renderApproval={(handoff) => teamWorkspaceId && handoff.senderActorId === `human:${orchestratorName?.trim().toLowerCase()}` ? <RoomApprovalReview workspaceId={teamWorkspaceId} workspaceName={teamWorkspace?.name} roomId={handoff.roomId} handoffId={handoff.handoffId} actorId={orchestratorName?.trim().toLowerCase() ?? null} /> : null}
              renderExecution={(handoff) => <RoomExecutionPanel key={`${handoff.handoffId}:${handoff.runId}:${handoff.execution?.approvalStatus}`} workspaceId={teamWorkspaceId || undefined} roomId={handoff.roomId} handoffId={handoff.handoffId} runId={handoff.runId} />} />
          ) : mainView === "team" ? (
            <TeamWorkspaceView actorId={signedIn ? orchestratorName?.trim().toLowerCase() ?? null : null} workspaceId={teamWorkspaceId || undefined} invitationToken={invitationToken}
              onOpenAgents={() => openView("custom-agents")} onOpenToolPolicy={teamWorkspaceId ? undefined : () => openView("employee-tools")}
              onInvitationAccepted={(id) => { setInvitationToken(""); void teamDirectory.refresh().then(() => teamDirectory.selectWorkspace(id)); }}
              onSelectWorkspace={(id) => { roomRoute.clear(); void teamDirectory.refresh().then(() => teamDirectory.selectWorkspace(id)); }} onChanged={() => { void teamDirectory.refresh(); }}
              onOpenChat={() => openView("threads")} onOpenWork={() => openView("work")} onOpenApps={() => openView("integrations")} />
          ) : mainView === "providers" ? (
            restrictedTeamMember ? <section className="m-4 border border-[var(--border-1)] bg-[var(--card)] p-6 text-sm text-[var(--fg)]" aria-label="Personal provider setup unavailable"><h1 className="text-xl font-medium">Personal provider setup needs an explicit account grant</h1><p className="mt-3 max-w-xl text-[var(--muted-foreground-2)]">Your invitation gives you team collaboration access. Connecting Claude or Codex and launching employee execution are unavailable for invited accounts until an owned provider and its billing permissions are verified. A deployment operator can request approved work and share its results in your team room.</p><p className="mt-3 max-w-xl text-[var(--muted-foreground-2)]">Your account will not fall back to a deployment credential. You can continue using shared chat, selected context, workspace membership and permitted employee recipes.</p></section> : <ProvidersView onProviderStateChanged={refreshProviderReadiness} onOpenSettings={(section) => { setSettingsSection(section); openView("settings"); }} />
          ) : mainView === "skills" ? (
            <SkillsView key={`${orchestratorName}:${teamWorkspaceId || "personal"}`} workspaceId={teamWorkspaceId || undefined} actorId={orchestratorName ?? undefined} workspaceRole={teamWorkspace?.membership.role} onNavigate={openView} />
          ) : mainView === "spaces" ? (
            <SpacesView />
          ) : mainView === "custom-agents" ? (
            <div className="flex min-h-0 flex-1 flex-col">
              {firstRunProgress?.draftTask ? <section aria-label="Return to first task setup" className="border-b border-[var(--border-1)] bg-[var(--card)] px-4 py-3 text-xs text-[var(--fg)]"><p>Configure and save an employee here. Then choose its saved version for your first task.</p><button type="button" className="mt-2 text-[var(--primary)]" onClick={() => { void updateFirstRunProgress({ action: "save-draft", draftTask: { currentStep: "employee" } }).then(() => { openFirstRun(); setJourneyStage("employee"); }).catch(() => setNotice("Setup could not be opened. Retry from your saved first task draft.")); }}>Choose saved employee in setup</button></section> : null}
            {workspaceEmployee ? (
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
                <button type="button" className="m-4 mb-0 min-h-11 self-start border border-[var(--border-1)] px-3 text-xs" onClick={() => setWorkspaceEmployee(null)}>Back to employees</button>
                <EmployeeWorkspace
                  key={workspaceEmployee.id}
                  employee={workspaceEmployee}
                  employees={customAgentRecords}
                  actorId={orchestratorName ?? undefined}
                  workspaceId={teamWorkspaceId || undefined}
                  onOpenConversation={teamWorkspaceId ? undefined : openBotPanel}
                  onOpenToolPolicy={teamWorkspaceId ? undefined : openEmployeeToolPolicy}
                  onOpenOutputs={teamWorkspaceId ? undefined : () => openView("outputs")}
                />
              </div>
            ) : (
            <CustomAgentsView
              key={`${orchestratorName}:${teamWorkspaceId || "personal"}`}
              onOpenWorkspace={setWorkspaceEmployee}
              workspaceId={teamWorkspaceId || undefined}
              actorId={orchestratorName ?? undefined}
              draftScope={orchestratorName ? `${orchestratorName}:${teamWorkspaceId || "personal"}` : undefined}
              onStartThread={async (profile) => { await handleStartAgentThread(profile); }}
              initialTemplateId={initialEmployeeTemplateId}
              onInitialTemplateApplied={() => setInitialEmployeeTemplateId(null)}
              initialAgentId={initialEmployeeId}
              onInitialAgentApplied={() => setInitialEmployeeId(null)}
              connections={modelConnections}
              modelSuggestions={agentsDirectory.state.kind === "data" ? agentsDirectory.state.data.agents.map((agent) => agent.defaultModel).filter((model): model is string => typeof model === "string" && model.includes("/")) : []}
              threads={visibleWebSessions}
              threadsLoading={!sessionsLoaded}
              threadsUnavailable={sessionsLoaded && !sessionApiAvailable}
              sharedTasks={teamWorkspaceId ? sharedWork.tasks : []}
              sharedTasksLoading={Boolean(teamWorkspaceId && sharedWork.loading)}
              onCreateSharedTask={teamWorkspaceId ? (title, patch) => sharedWork.create(title, patch) : undefined}
              onUpdateSharedTask={teamWorkspaceId ? (id, patch) => { void sharedWork.update(id, patch); } : undefined}
              onOpenSharedTask={teamWorkspaceId ? (task) => {
                applyWorkSelection({ view: workViewMode, task: task.id, tab: "steps" }, "push");
                setMainView("work");
              } : undefined}
              onOpenToolPolicy={openEmployeeToolPolicy}
              onOpenThread={(id) => { void handleSelectSession(id); }}
            />
            )}
            </div>
          ) : mainView === "chief-of-staff" ? (
            <ChiefOfStaffView
              employees={workEmployees}
              loading={customAgentsLoading}
              error={customAgentsError}
              onRetry={refreshCustomAgents}
              onOpenChief={teamWorkspaceId ? undefined : () => { void handleSelectSession("default"); openView("threads"); }}
              onOpenApprovals={teamWorkspaceId ? undefined : () => setMainView("approvals")}
              onOpenOutputs={teamWorkspaceId ? undefined : () => openView("outputs")}
              onOpenEmployee={teamWorkspaceId ? undefined : (id) => { const record = customAgentRecords.find((item) => item.id === id); if (!record) return; openView("custom-agents"); setWorkspaceEmployee(record); }}
            />
          ) : mainView === "employee-tools" ? (
            <EmployeeToolPolicyView initialEmployeeId={toolPolicyIntent?.scope === toolPolicyScope ? toolPolicyIntent.employeeId : null} />
          ) : mainView === "agents" ? (
            <AgentsView />
          ) : mainView === "integrations" ? (
            <IntegrationsView onNavigate={openView} onAdoptSlackTask={adoptSlackTask} onOpenSlackHandoff={openSlackHandoff} actorId={orchestratorName ?? undefined} nativeSession={authMode === "better-auth"} workspaceId={teamWorkspaceId || undefined} workspaceName={teamWorkspace?.name} workspaceRole={teamWorkspace?.membership.role} allowPersonalScope={!restrictedTeamMember} onPersonalScope={() => teamDirectory.selectWorkspace("")} onChooseWorkspace={() => openView("team")} />
          ) : mainView === "remote" ? (
            <RemoteAccessView />
          ) : mainView === "settings" ? (
            <SettingsPage
              key={orchestratorName ?? "signed-out"}
              withPanel={false}
              showSectionSwitcher={sessionsCollapsed}
              onOpenPersonalWorkspace={teamWorkspaceId ? () => teamDirectory.selectWorkspace("") : undefined}
              personalDataBlocked={!privateDataEnabled}
              providersBlocked={restrictedTeamMember}
              section={settingsSection}
              onSectionChange={setSettingsSection}
              onBack={closeSettings}
              onNavigate={openView}
              onSignOut={authMode === "better-auth" ? handleSignOut : undefined}
              scope={scope}
              onScopeChange={handleScopeChange}
              actorId={orchestratorName?.trim().toLowerCase() ?? null}
              workspaceId={teamWorkspaceId || undefined}
              slackWorkspaceId={teamWorkspace?.membership.role === "owner" ? teamWorkspaceId || undefined : undefined}
              slackActorId={orchestratorName ?? undefined}
              invitationToken={invitationToken}
              onInvitationAccepted={(id) => { setInvitationToken(""); void teamDirectory.refresh().then(() => teamDirectory.selectWorkspace(id)); }}
              onSelectWorkspace={(id) => { roomRoute.clear(); void teamDirectory.refresh().then(() => teamDirectory.selectWorkspace(id)); }}
              onChanged={() => { void teamDirectory.refresh(); }}
              onOpenChat={() => openView("threads")}
              onOpenWork={() => openView("work")} onOpenApps={() => openView("integrations")}
            />
          ) : null}
          </MainCard>

          {/* CLEAR HISTORY CONFIRMATION MODAL */}
          {showClearModal && privateDataEnabled ? (
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
          {privateDataEnabled ? <FirstRunWizard
            open={showLegacyFirstRun && privateDataEnabled}
            onClose={() => setShowLegacyFirstRun(false)}
            progress={authMode === "better-auth" ? firstRunProgress : null}
            onRefresh={authMode === "better-auth" ? refreshFirstRunProgress : undefined}
            onResume={authMode === "better-auth" ? resumeFirstRunProgress : undefined}
            onStepChange={authMode === "better-auth" ? saveFirstRunStep : undefined}
            onDismiss={authMode === "better-auth" ? dismissFirstRunProgress : undefined}
            onNavigate={openView}
            onStartEmployeeSetup={(template) => {
              setInitialEmployeeTemplateId(template.id);
              setShowLegacyFirstRun(false);
              openView("custom-agents");
            }}
            onOpenModels={() => {
              setSettingsSection("models");
              openView("settings");
            }}
            onOpenChecklist={() => setShowOnboardingModal(true)}
            onOpenEnvironments={() => {
              setSettingsSection("environments");
              openView("settings");
            }}
          /> : null}

          {privateDataEnabled ? <OnboardingModal
            isOpen={showOnboardingModal && privateDataEnabled}
            onClose={() => setShowOnboardingModal(false)}
            onOpenInbox={() => setMainView("inbox")}
            onSelectStarterTask={(repo, t, h) => {
              setRepoUrl(repo);
              setTask(t);
              taskRouteChosen.current = true;
              setHarness(h);
            }}
          /> : null}

          <ShortcutsDialog open={showShortcutsModal} onClose={() => setShowShortcutsModal(false)} />
          <CommandPalette
            open={commandMenuOpen}
            onClose={() => setCommandMenuOpen(false)}
            workspaceId={teamWorkspaceId || null}
            roomThreadOpen={Boolean(sharedRoomId && (mainView === "collaboration" || (mainView === "threads" && teamWorkspaceId)))}
            settings={Object.entries(SETTINGS_SECTION_LABELS).map(([id, item]) => ({ id, label: item.label }))}
            extraActions={[
              ...(teamWorkspaceId ? [{ id: "connect-app", label: "Connect app", run: () => { setSettingsSection("integrations"); openView("settings"); } }] : []),
              ...APP_NAV_ITEMS.map((item) => ({ id: `nav-${item.id}`, label: `Go to ${item.label}`, run: () => openView(item.id) })),
              { id: "toggle-sessions", label: "Toggle sessions sidebar", run: toggleActiveSidebar },
              { id: "setup-guide", label: "Open setup guide", run: openFirstRun },
            ]}
            onNewTask={() => { void handleNewTask(); }}
            newTaskBlockedReason={taskCreationBlocker ?? undefined}
            onNewChannel={() => openView("threads")}
            onOpenBot={(bot, focusComposer) => {
              if (bot.roomId) setSharedRoomId(bot.roomId);
              openView("threads");
              if (focusComposer) window.setTimeout(() => document.querySelector<HTMLTextAreaElement>("[data-testid='task-composer'] textarea, [data-testid='chat-composer'] textarea")?.focus(), 0);
            }}
            onOpenChat={(hit) => { setSharedRoomId(hit.roomId); openView("threads"); }}
            onOpenTask={(hit) => {
              const next = updateWorkSearch(new URLSearchParams(window.location.search), { view: "list", task: hit.taskId, taskKind: "run", tab: "steps" });
              router.history.push(`${pathForView("work")}?${next.toString()}`);
              openView("work");
            }}
            onOpenKnowledge={() => openView("files")}
            onOpenSettings={(section) => { setSettingsSection(section); openView("settings"); }}
            onOpenNeedsYou={() => openView("work")}
            onToggleTheme={toggleTheme}
            onOpenShortcuts={() => setShowShortcutsModal(true)}
            onInsertAgentMention={(agentId) => { if (sharedRoomId) setRoomMention({ id: crypto.randomUUID(), roomId: sharedRoomId, agentId, scope: sharedRoomScope }); }}
            onSearchAll={(q) => {
              const next = new URLSearchParams(window.location.search);
              next.set("q", q);
              router.history.push(`${pathForView("work")}?${next.toString()}`);
              openView("work");
            }}
            onMessageAbout={(bot, q) => {
              setTask(q);
              if (bot.roomId) setSharedRoomId(bot.roomId);
              openView("threads");
            }}
          />
        </div>
      </div>
    </AppShell>
  );
}
