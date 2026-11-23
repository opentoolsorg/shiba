import { EmployeeRoutines } from "./RoutinesView";
import { EmployeeAccessSettings } from "./EmployeeAccessSettings";
import { useCallback, useEffect, useId, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { ChevronRight, Plus, ShieldCheck } from "lucide-react";
import { pathForView } from "../app-navigation";
import { LoadErrorState } from "./LoadErrorState";
import { EmptyState, SkeletonLines, StatusNotice } from "./surface";
import { agentThreads, type WebThread } from "../agent-threads";
import { formatTimeAgo } from "../ui-helpers";
import { AGENT_MASCOT_ACCS, AGENT_MASCOT_EYES, AGENT_MASCOT_SHAPES, CUSTOM_AGENT_MASCOT_PRESETS, defaultLookFor, formLook, normalizeMascotColor, sanitizeCustomAgentSlug, type CustomAgentConfig, type CustomAgentRoleTemplateId, type AgentAvatarChoice } from "@shiba/shared";
import { AgentLookStyler } from "./AgentLookStyler";
import { codingModelOptions, type ConnectionOption } from "../live-status";
import { EMPLOYEE_TEMPLATES, employeeRole, employeeRoleLabel, type EmployeeTemplate } from "../employee-templates";
import { AgentAvatar as MascotAvatar } from "./AgentAvatar";
import { BotAvatarEditor } from "./BotAvatarEditor";
import { AgentTemplatesCatalog } from "./AgentTemplatesCatalog";
import { AgentAvatar } from "./AgentExperience";
import type { AgentTemplate, EmployeeAccessLevel } from "@shiba/shared";
import { PrimaryBotPicker } from "./collab/PrimaryBotPicker";
import { teamWorkspaceHeaders } from "../team-workspaces-client";

const FIELD =
  "bg-[var(--panel)] border border-[var(--border-1)] rounded-[var(--radius-button)] text-[var(--fg)] px-2.5 py-1.5 text-xs focus:outline-none focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)]/40 placeholder-[var(--muted-foreground-3)]/60 transition-colors w-full";

const SANDBOX_PROVIDERS = ["cloudflare", "docker-local", "computesdk", "e2b"] as const;

const OVERLINE = "font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]";
const BTN =
  "min-h-11 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] px-3 text-xs font-medium text-[var(--fg)] hover:bg-[var(--card-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)] disabled:opacity-50";
const BTN_PRIMARY =
  "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[var(--radius-button)] border border-[var(--primary)] bg-[var(--primary)] px-4 text-xs font-medium text-[var(--primary-text)] hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-50";
const STAGE = "flex flex-col gap-4 border-t border-[var(--border-1)] pt-5";
const ROLE_FILTER_ALL = "all";

/** Every interactive task and scheduled automation requires human approval. */
const INTERACTIVE_APPROVAL = "Interactive tasks need your approval of the exact task before anything runs.";
const AUTOMATION_APPROVAL = "Automated runs also require human approval.";

/** The tool-policy page is a personal-scope view, so a team workspace gets an honest note instead of a link. */
function ToolPolicyNote({ workspaceId, onOpenToolPolicy }: { workspaceId?: string; onOpenToolPolicy?: () => void }): JSX.Element {
  if (workspaceId) return <p>Employee tool policy is currently available for personal employee profiles only.</p>;
  if (onOpenToolPolicy) return <button type="button" onClick={onOpenToolPolicy} className="inline-flex min-h-11 items-center text-[var(--primary)] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]">Review employee tool policy</button>;
  return <a href={pathForView("employee-tools")} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-[var(--primary)] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]">Review employee tool policy (opens in a new tab)</a>;
}

export interface CustomAgentWire {
  id: string;
  slug: string;
  version: number;
  archivedAt?: number;
  config: CustomAgentConfig;
}

const EMPTY_FORM = {
  slug: "",
  name: "",
  emoji: "",
  mascotPreset: "",
  lookShape: "",
  lookColor: "",
  lookEyes: "",
  lookAcc: "",
  roleTemplateId: "",
  instructions: "",
  harness: "opencode",
  codingModel: "",
  connectionId: "",
  sandboxProvider: "",
  defaultRepoUrl: "",
  expectedDeliverables: "",
};

function readRoleDraft(scope?: string): typeof EMPTY_FORM {
  if (!scope) return EMPTY_FORM;
  try {
    const draft = JSON.parse(localStorage.getItem(`shiba-role-draft-v1:${scope}`) ?? "null");
    if (draft && Object.keys(EMPTY_FORM).every((key) => key === "roleTemplateId" || key === "mascotPreset" || key.startsWith("look") || typeof draft[key] === "string")) {
      return {
        ...Object.fromEntries(Object.keys(EMPTY_FORM).map((key) => [key, draft[key]])),
        mascotPreset: CUSTOM_AGENT_MASCOT_PRESETS.includes(draft.mascotPreset) ? draft.mascotPreset : "",
        lookShape: (AGENT_MASCOT_SHAPES as readonly string[]).includes(draft.lookShape) ? draft.lookShape : "",
        lookColor: normalizeMascotColor(draft.lookColor) ?? "",
        lookEyes: (AGENT_MASCOT_EYES as readonly string[]).includes(draft.lookEyes) ? draft.lookEyes : "",
        lookAcc: (AGENT_MASCOT_ACCS as readonly string[]).includes(draft.lookAcc) ? draft.lookAcc : "",
        roleTemplateId: EMPLOYEE_TEMPLATES.some((template) => template.id === draft.roleTemplateId) ? draft.roleTemplateId : "",
      } as typeof EMPTY_FORM;
    }
  } catch { /* Storage unavailable or invalid: keep the editor usable. */ }
  return EMPTY_FORM;
}

const hasDraft = (form: typeof EMPTY_FORM) => Object.entries(EMPTY_FORM).some(([key, value]) => form[key as keyof typeof EMPTY_FORM] !== value);

export interface CustomAgentsViewProps {
  onStartThread?: (agent: CustomAgentWire) => Promise<void>;
  threads?: WebThread[];
  threadsLoading?: boolean;
  threadsUnavailable?: boolean;
  onOpenThread?: (id: string) => void;
  connections?: ConnectionOption[];
  modelSuggestions?: string[];
  initialTemplateId?: EmployeeTemplate["id"] | null;
  onInitialTemplateApplied?: () => void;
  /** Opens this saved employee for editing once the directory has loaded. */
  initialAgentId?: string | null;
  onInitialAgentApplied?: () => void;
  draftScope?: string;
  workspaceId?: string;
  actorId?: string;
  onOpenToolPolicy?: () => void;
}

/** Keep drafts and async callbacks in the account/workspace that created them. */
export function CustomAgentsView(props: CustomAgentsViewProps): JSX.Element {
  const scope = JSON.stringify([props.actorId?.trim().toLowerCase() ?? "", props.workspaceId ?? "", props.draftScope ?? ""]);
  const current = useRef({ scope, generation: 0 });
  if (current.current.scope !== scope) current.current = { scope, generation: current.current.generation + 1 };
  const generation = current.current.generation;
  return <ScopedCustomAgentsView key={generation} {...props} isCurrent={() => current.current.generation === generation} />;
}

function ScopedCustomAgentsView({
  onStartThread,
  threads = [],
  threadsLoading = false,
  threadsUnavailable = false,
  onOpenThread,
  onOpenToolPolicy,
  connections = [],
  modelSuggestions = [],
  initialTemplateId = null,
  onInitialTemplateApplied,
  initialAgentId = null,
  onInitialAgentApplied,
  draftScope,
  workspaceId,
  isCurrent,
}: CustomAgentsViewProps & { isCurrent: () => boolean }): JSX.Element {
  const alive = useRef(true);
  const currentScope = useRef(isCurrent);
  currentScope.current = isCurrent;
  const isActive = useCallback(() => alive.current && currentScope.current(), []);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const [agents, setAgents] = useState<CustomAgentWire[] | null>(null);
  const [callerLevels, setCallerLevels] = useState<Record<string, EmployeeAccessLevel>>({});
  const canManage = (id: string) => !workspaceId || callerLevels[id] === "manage";
  useEffect(() => {
    if (!workspaceId || !agents) return;
    let cancelled = false;
    setCallerLevels({});
    void Promise.all(agents.map(async (agent) => {
      try {
        const response = await fetch(`/api/governance/employees/${encodeURIComponent(agent.id)}/access`, { headers: teamWorkspaceHeaders(workspaceId) });
        if (!response.ok) return [agent.id, "none"] as const;
        const body = await response.json() as { level: EmployeeAccessLevel };
        return [agent.id, body.level] as const;
      } catch { return [agent.id, "none"] as const; }
    })).then((levels) => { if (!cancelled && isActive()) setCallerLevels(Object.fromEntries(levels)); });
    return () => { cancelled = true; };
  }, [agents, workspaceId, isActive]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [directoryQuery, setDirectoryQuery] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const selectedAgent = agents?.find((agent) => agent.id === selectedAgentId);
  const [roleFilter, setRoleFilter] = useState(ROLE_FILTER_ALL);
  const rosterQuery = directoryQuery.trim().toLocaleLowerCase();
  // Only roles that saved employees actually carry are offered; a role is a label, not a department or reporting line.
  const rosterRoles = [...new Set((agents ?? []).map((agent) => employeeRole(agent.slug, agent.config.roleTemplateId)))];
  const rosterRolesKey = rosterRoles.join("\0");
  useEffect(() => {
    if (agents && roleFilter !== ROLE_FILTER_ALL && !rosterRolesKey.split("\0").includes(roleFilter)) {
      setRoleFilter(ROLE_FILTER_ALL);
    }
  }, [agents, roleFilter, rosterRolesKey]);
  const visibleAgents = agents?.filter((agent) => (roleFilter === ROLE_FILTER_ALL || employeeRole(agent.slug, agent.config.roleTemplateId) === roleFilter)
    && [agent.config.name, agent.slug, agent.config.harness,
    agent.config.codingModel ?? "", employeeRoleLabel(employeeRole(agent.slug, agent.config.roleTemplateId))]
    .some((value) => value.toLocaleLowerCase().includes(rosterQuery)));
  const [form, setForm] = useState(() => readRoleDraft(draftScope));
  const [draftStorageAvailable, setDraftStorageAvailable] = useState(true);
  const [expectedVersion, setExpectedVersion] = useState<number | undefined>(undefined);
  const [avatarEditorFor, setAvatarEditorFor] = useState<CustomAgentWire | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [startingAgentId, setStartingAgentId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [editingConfig, setEditingConfig] = useState<CustomAgentConfig | null>(null);
  const [conflict, setConflict] = useState(false);
  const directoryRequest = useRef(0);
  const startingThread = useRef(false);
  const savingAgent = useRef(false);
  const [pendingTemplate, setPendingTemplate] = useState<EmployeeTemplate | null>(null);
  const appliedInitialTemplate = useRef<EmployeeTemplate["id"] | null>(null);
  const templateTrigger = useRef<HTMLButtonElement | null>(null);
  const keepDraftButton = useRef<HTMLButtonElement | null>(null);
  const profileSection = useRef<HTMLElement | null>(null);
  const profileTrigger = useRef<HTMLButtonElement | null>(null);
  const focusProfile = useRef(false);
  useEffect(() => {
    if (!focusProfile.current || !selectedAgentId) return;
    focusProfile.current = false;
    profileSection.current?.scrollIntoView?.({ block: "start" });
    profileSection.current?.focus({ preventScroll: true });
  }, [selectedAgentId]);
  const nameInput = useRef<HTMLInputElement | null>(null);
  const [focusNameRequest, setFocusNameRequest] = useState(0);
  const focusName = useCallback(() => setFocusNameRequest((request) => request + 1), []);
  useEffect(() => {
    if (!focusNameRequest || showArchived) return;
    nameInput.current?.scrollIntoView?.({ block: "center", behavior: "auto" });
    nameInput.current?.focus({ preventScroll: true });
  }, [focusNameRequest, showArchived]);
  const templateTitleId = useId();
  const templateDescriptionId = useId();
  const roleHelpId = useId();
  const stageRoleId = useId();
  const stageBoundariesId = useId();
  const stageReviewId = useId();
  const reviewRoleSlug = sanitizeCustomAgentSlug(form.slug.trim() || form.name.trim()) ?? "";
  const reviewRole = employeeRoleLabel(employeeRole(reviewRoleSlug, (form.roleTemplateId as CustomAgentRoleTemplateId) || undefined));
  const reviewDeliverables = form.expectedDeliverables.split(/\r?\n/).filter((value) => value.trim()).length;
  const reviewConnection = form.connectionId
    ? connections.find((connection) => connection.id === form.connectionId)?.label ?? "Saved connection (unavailable)"
    : null;
  // A saved avatar wins over the look controls, so an edit must preview it rather than the look.
  const savedAvatar = editingId ? editingConfig?.avatar : undefined;

  useEffect(() => {
    if (!draftScope || editingId) return;
    try {
      const key = `shiba-role-draft-v1:${draftScope}`;
      if (hasDraft(form)) localStorage.setItem(key, JSON.stringify(form));
      else localStorage.removeItem(key);
      setDraftStorageAvailable(true);
    } catch { setDraftStorageAvailable(false); }
  }, [draftScope, editingId, form]);

  useEffect(() => {
    if (pendingTemplate) keepDraftButton.current?.focus();
  }, [pendingTemplate]);

  const keepCurrentDraft = () => {
    setPendingTemplate(null);
    setNotice(null);
    templateTrigger.current?.focus();
  };

  const applyTemplate = useCallback((template: EmployeeTemplate) => {
    if (editingId || busy) return;
    setForm((current) => ({
      ...current,
      slug: template.slug,
      name: template.config.name,
      emoji: template.config.emoji ?? "",
      roleTemplateId: template.id,
      instructions: template.config.instructions,
      expectedDeliverables: template.config.expectedDeliverables?.join("\n") ?? "",
    }));
    setPendingTemplate(null);
    setConflict(false);
    focusName();
    setNotice({ tone: "ok", text: `${template.label} role loaded as an editable draft. Review it before creating a bot.` });
  }, [editingId, busy, focusName]);

  const chooseTemplate = (template: EmployeeTemplate, trigger: HTMLButtonElement) => {
    if (editingId || busy) return;
    templateTrigger.current = trigger;
    if ([form.slug, form.name, form.emoji, form.instructions, form.expectedDeliverables].some((value) => value.trim())) {
      setPendingTemplate(template);
      return;
    }
    applyTemplate(template);
  };

  const startThread = async (agent: CustomAgentWire) => {
    if (!isActive() || !onStartThread || startingThread.current) return;
    startingThread.current = true;
    setStartingAgentId(agent.id);
    setNotice(null);
    try {
      await onStartThread(agent);
    } catch (error) {
      if (isActive()) setNotice({ tone: "err", text: error instanceof Error ? error.message : "Could not start a thread." });
    } finally {
      if (isActive()) { startingThread.current = false; setStartingAgentId(null); }
    }
  };

  const refresh = useCallback(() => {
    if (!isActive()) return;
    const request = ++directoryRequest.current;
    setLoadError(null);
    fetch(showArchived ? "/api/custom-agents?archived=true" : "/api/custom-agents", { headers: teamWorkspaceHeaders(workspaceId) })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Bots could not be loaded (${r.status}).`);
        return (await r.json()) as { agents?: CustomAgentWire[] };
      })
      .then((body) => { if (isActive() && request === directoryRequest.current) setAgents(body.agents ?? []); })
      .catch((error: unknown) => {
        if (isActive() && request === directoryRequest.current) setLoadError(error instanceof Error ? error.message : "Bots could not be loaded.");
      });
  }, [showArchived, workspaceId, isActive]);

  useEffect(() => { setAgents(null); refresh(); return () => { directoryRequest.current++; }; }, [refresh]);

  useEffect(() => {
    if (!initialTemplateId || appliedInitialTemplate.current === initialTemplateId || editingId || busy) return;
    const template = EMPLOYEE_TEMPLATES.find((item) => item.id === initialTemplateId);
    if (!template) return;
    appliedInitialTemplate.current = initialTemplateId;
    if (hasDraft(form)) setPendingTemplate(template);
    else applyTemplate(template);
    onInitialTemplateApplied?.();
  }, [initialTemplateId, editingId, busy, applyTemplate, onInitialTemplateApplied, form]);

  const resetForm = (discardDraft = false) => {
    setPendingTemplate(null);
    setEditingId(null);
    setForm(discardDraft ? EMPTY_FORM : readRoleDraft(draftScope));
    setExpectedVersion(undefined);
    setEditingConfig(null);
    setConflict(false);
  };

  const startEdit = (agent: CustomAgentWire) => {
    if (!canManage(agent.id)) return;
    focusName();
    setPendingTemplate(null);
    setEditingId(agent.id);
    setExpectedVersion(agent.version);
    setEditingConfig(agent.config);
    setConflict(false);
    setForm({
      slug: agent.slug,
      name: agent.config.name,
      emoji: agent.config.emoji ?? "",
      mascotPreset: agent.config.mascotPreset ?? "",
      lookShape: agent.config.look?.shape ?? "",
      lookColor: agent.config.look?.color ?? "",
      lookEyes: agent.config.look?.eyes ?? "",
      lookAcc: agent.config.look?.acc ?? "",
      roleTemplateId: agent.config.roleTemplateId ?? (employeeRole(agent.slug) === "custom" ? "" : employeeRole(agent.slug)),
      instructions: agent.config.instructions,
      harness: agent.config.harness,
      codingModel: agent.config.codingModel ?? "",
      connectionId: agent.config.connectionId ?? "",
      sandboxProvider: agent.config.sandboxProvider ?? "",
      defaultRepoUrl: agent.config.defaultRepoUrl ?? "",
      expectedDeliverables: agent.config.expectedDeliverables?.join("\n") ?? "",
    });
  };

  const appliedInitialAgent = useRef<string | null>(null);
  // startEdit only sets component state; it is intentionally not a dependency.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!initialAgentId || appliedInitialAgent.current === initialAgentId || !agents) return;
    const agent = agents.find((item) => item.id === initialAgentId);
    if (workspaceId && agent && !callerLevels[agent.id]) return;
    appliedInitialAgent.current = initialAgentId;
    if (agent) { setSelectedAgentId(agent.id); startEdit(agent); }
    onInitialAgentApplied?.();
  }, [initialAgentId, agents, onInitialAgentApplied, callerLevels, workspaceId]);

  /** Avatar saves only the avatar: it patches the bot's own saved version, so a
   *  half-filled form can never ride along, and a version conflict is reported. */
  async function saveAvatar(agent: CustomAgentWire, choice: AgentAvatarChoice) {
    setAvatarBusy(true);
    setAvatarError(null);
    try {
      const response = await fetch(`/api/custom-agents/${encodeURIComponent(agent.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...teamWorkspaceHeaders(workspaceId) },
        body: JSON.stringify({ config: { ...agent.config, avatar: choice }, expectedVersion: agent.version }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; agent?: CustomAgentWire };
      if (response.status === 409) {
        // Pull the fresh version so the same draft can be saved again, and say
        // that the retry will keep the one field this dialog owns.
        const latest = await fetch(`/api/custom-agents/${encodeURIComponent(agent.id)}`, { headers: teamWorkspaceHeaders(workspaceId) })
          .then((reply) => reply.json() as Promise<{ agent?: CustomAgentWire }>)
          .catch(() => ({}) as { agent?: CustomAgentWire });
        if (latest.agent) setAvatarEditorFor(latest.agent);
        setAvatarError(latest.agent
          ? `This bot changed since you opened it. The latest version (v${latest.agent.version}) is loaded — save again to keep your avatar and leave their changes intact.`
          : "This bot changed since you opened it. Reload the latest version, then pick the avatar again.");
        return;
      }
      if (!response.ok || !body.agent) {
        setAvatarError(body.error ?? `Could not save the avatar (${response.status}).`);
        return;
      }
      const saved = body.agent;
      setAgents((current) => (current ?? []).map((entry) => (entry.id === saved.id ? saved : entry)));
      setSelectedAgentId(saved.id);
      setAvatarEditorFor(null);
      setNotice({ tone: "ok", text: "Avatar updated." });
      refresh();
    } catch {
      setAvatarError("Could not reach the workspace. Try again.");
    } finally {
      setAvatarBusy(false);
    }
  }

  const saveAgent = async () => {
    if (!isActive() || savingAgent.current || busy) return;
    if (editingId && !canManage(editingId)) return;
    if (pendingTemplate) {
      setNotice({ tone: "err", text: "Keep your current draft or confirm its replacement before saving." });
      return;
    }
    const slug = sanitizeCustomAgentSlug(form.slug.trim() || form.name.trim());
    const name = form.name.trim();
    const instructions = form.instructions.trim();
    const expectedDeliverables = form.expectedDeliverables.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    if (!name || !instructions) {
      setNotice({ tone: "err", text: "Name and instructions are required." });
      return;
    }
    if (!slug) {
      setNotice({ tone: "err", text: "Choose a slug of 1–48 letters, numbers, or hyphens in Advanced settings." });
      return;
    }
    if (expectedDeliverables.length > 8) {
      setNotice({ tone: "err", text: "Use at most 8 required deliverable paths, one per line." });
      return;
    }
    savingAgent.current = true;
    setBusy(true);
    setNotice(null);
    const look = formLook(form.lookShape, form.lookColor, form.lookEyes, form.lookAcc);
    const config: CustomAgentConfig = {
      ...editingConfig,
      name,
      instructions,
      harness: form.harness.trim() || "opencode",
      ...(EMPLOYEE_TEMPLATES.some((template) => template.id === form.roleTemplateId) ? { roleTemplateId: form.roleTemplateId as CustomAgentConfig["roleTemplateId"] } : {}),
      ...(form.emoji.trim() ? { emoji: form.emoji.trim() } : {}),
      ...(CUSTOM_AGENT_MASCOT_PRESETS.some((preset) => preset === form.mascotPreset) ? { mascotPreset: form.mascotPreset as CustomAgentConfig["mascotPreset"] } : {}),
      ...(look ? { look } : {}),
      ...(form.codingModel.trim() ? { codingModel: form.codingModel.trim() } : {}),
      ...(form.connectionId.trim() ? { connectionId: form.connectionId.trim() } : {}),
      ...(form.sandboxProvider ? { sandboxProvider: form.sandboxProvider as CustomAgentConfig["sandboxProvider"] } : {}),
      ...(form.defaultRepoUrl.trim() ? { defaultRepoUrl: form.defaultRepoUrl.trim() } : {}),
      ...(expectedDeliverables.length ? { expectedDeliverables } : {}),
    };
    // Clearing an optional field must clear its old value while other saved
    // settings survive an edit of the visible fields.
    for (const key of ["emoji", "mascotPreset", "roleTemplateId", "codingModel", "connectionId", "sandboxProvider", "defaultRepoUrl", "expectedDeliverables"] as const) {
      if (!form[key].trim()) delete config[key];
    }
    if (!look) delete config.look;
    try {
      const response = editingId
        ? await fetch(`/api/custom-agents/${encodeURIComponent(editingId)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", ...teamWorkspaceHeaders(workspaceId) },
            body: JSON.stringify({ config, expectedVersion }),
          })
        : await fetch("/api/custom-agents", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...teamWorkspaceHeaders(workspaceId) },
            body: JSON.stringify({ slug, config }),
          });
      const body = (await response.json().catch(() => ({}))) as { error?: string; agent?: CustomAgentWire };
      if (!isActive()) return;
      if (!response.ok || !body.agent) {
        setConflict(response.status === 409);
        setNotice({ tone: "err", text: response.status === 409
          ? "This bot changed since you opened it. Your draft is preserved. Reload the latest version before saving."
          : body.error ?? `Save failed (${response.status}).` });
      } else {
        const saved = body.agent;
        setAgents((current) => {
          const rest = (current ?? []).filter((agent) => agent.id !== saved.id);
          return [saved, ...rest];
        });
        setNotice({ tone: "ok", text: editingId ? "Bot updated." : "Bot created." });
        resetForm(!editingId);
        refresh();
      }
    } catch {
      if (isActive()) setNotice({ tone: "err", text: "Save failed: the backend could not be reached." });
    } finally {
      if (isActive()) { savingAgent.current = false; setBusy(false); }
    }
  };

  const changeLifecycle = async (agent: CustomAgentWire, action: "archive" | "restore") => {
    if (!isActive() || busy || !canManage(agent.id)) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/custom-agents/${encodeURIComponent(agent.id)}/${action}`, {
        method: "POST", headers: { "content-type": "application/json", ...teamWorkspaceHeaders(workspaceId) }, body: JSON.stringify({}),
      });
      const body = await response.json().catch(() => ({})) as { error?: string; agent?: CustomAgentWire };
      if (!isActive()) return;
      if (!response.ok || !body.agent) throw new Error(body.error ?? `Could not ${action} bot (${response.status}).`);
      setAgents((current) => (current ?? []).filter((item) => item.id !== agent.id));
      if (editingId === agent.id) resetForm();
      setNotice({ tone: "ok", text: action === "archive" ? "Bot archived. Its conversation history is preserved." : "Bot restored." });
      refresh();
    } catch (error) {
      if (isActive()) setNotice({ tone: "err", text: error instanceof Error ? error.message : "Bot could not be updated." });
    } finally { if (isActive()) setBusy(false); }
  };

  const reloadEditingAgent = async () => {
    if (!isActive() || !editingId || busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/custom-agents/${encodeURIComponent(editingId)}`, { headers: teamWorkspaceHeaders(workspaceId) });
      const body = await response.json() as { agent?: CustomAgentWire; error?: string };
      if (!isActive()) return;
      if (!response.ok || !body.agent) throw new Error(body.error ?? "Bot could not be reloaded.");
      startEdit(body.agent);
      setNotice({ tone: "ok", text: "Latest bot loaded. Review it before saving." });
    } catch (error) { if (isActive()) setNotice({ tone: "err", text: error instanceof Error ? error.message : "Bot could not be reloaded." }); }
    finally { if (isActive()) setBusy(false); }
  };

  const deleteAgent = async (id: string) => {
    if (!isActive() || busy || !canManage(id)) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/custom-agents/${encodeURIComponent(id)}`, { method: "DELETE", headers: teamWorkspaceHeaders(workspaceId) });
      if (!isActive()) return;
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        if (!isActive()) return;
        setNotice({ tone: "err", text: body.error ?? `Delete failed (${response.status}).` });
      } else {
        setAgents((current) => (current ?? []).filter((agent) => agent.id !== id));
        setConfirmDeleteId(null);
        if (editingId === id) resetForm();
        setNotice({ tone: "ok", text: "Bot deleted." });
        refresh();
      }
    } catch {
      if (isActive()) setNotice({ tone: "err", text: "Delete failed: the backend could not be reached." });
    } finally {
      if (isActive()) setBusy(false);
    }
  };

  const onFormKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void saveAgent();
    }
  };

  return (
    <div className="employee-directory flex h-full min-w-0 flex-1 flex-col overflow-hidden border border-[var(--border-1)] bg-[var(--bg)] text-[var(--fg)]">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--border-1)] bg-[var(--card)] px-4 py-2">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[13px]">
          <span className="text-[var(--muted-foreground-2)]">
            {workspaceId ? "Workspace" : "Personal"}
          </span>
          <ChevronRight className="size-3.5 text-[var(--muted-foreground-3)]" aria-hidden="true" />
          <span className="text-[var(--muted-foreground-2)]">Agents</span>
          <ChevronRight className="size-3.5 text-[var(--muted-foreground-3)]" aria-hidden="true" />
          <span className="font-medium text-[var(--fg)]" aria-current="page">
            {showArchived ? "Archived" : "All"}
          </span>
        </nav>
        <div className="flex flex-wrap items-center gap-2">
          <span className="hidden items-center gap-1.5 text-xs text-[var(--muted-foreground-2)] sm:inline-flex">
            <ShieldCheck className="size-4" aria-hidden="true" />Interactive runs require approval
          </span>
          <button type="button" disabled={busy} className={BTN} onClick={() => { resetForm(); setShowArchived(false); focusName(); }}>New bot</button>
          <div className="flex gap-1" role="group" aria-label="Bot directory">
            {[false, true].map((archived) => (
              <button
                key={String(archived)}
                type="button"
                aria-pressed={showArchived === archived}
                disabled={busy}
                onClick={() => {
                  if (archived === showArchived) return;
                  setAgents(null);
                  setRoleFilter(ROLE_FILTER_ALL);
                  resetForm();
                  setShowArchived(archived);
                }}
                className={`${BTN} aria-pressed:bg-[var(--secondary)] aria-pressed:text-[var(--fg)] text-[var(--muted-foreground-2)]`}
              >
                {archived ? "Archived bots" : "Active bots"}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4 lg:p-8">
        <div className="max-w-6xl mx-auto flex flex-col gap-6">
          <section aria-label="Employee directory" className="flex flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <p className={OVERLINE}>Team / Saved employees</p>
                <h1 className="mt-1 font-[family-name:var(--font-display)] text-2xl font-semibold tracking-tight text-[var(--fg)]">Your employee roster</h1>
                <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--muted-foreground-2)]">Find a saved employee, inspect its defaults, or launch a dedicated thread. Interactive tasks require approval before execution.</p>
              </div>
              {!showArchived ? (
                <button type="button" disabled={busy} className={BTN_PRIMARY} onClick={() => { resetForm(); focusName(); }}>
                  <Plus className="size-4" aria-hidden="true" />Hire employee
                </button>
              ) : null}
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex min-w-0 flex-1 basis-64 flex-col gap-1 text-xs text-[var(--muted-foreground-2)]">
                Search employees
                <input type="search" value={directoryQuery} onChange={(event) => setDirectoryQuery(event.target.value)}
                  placeholder="Name, role, harness or model" className={`${FIELD} min-h-11 text-sm`} />
              </label>
              {rosterRoles.length > 1 || roleFilter !== ROLE_FILTER_ALL ? (
                <label className="flex flex-col gap-1 text-xs text-[var(--muted-foreground-2)]">
                  Filter by role
                  <select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)} className={`${FIELD} min-h-11 text-sm`}>
                    <option value={ROLE_FILTER_ALL}>All roles</option>
                    {rosterRoles.map((role) => <option key={role} value={role}>{employeeRoleLabel(role)}</option>)}
                  </select>
                </label>
              ) : null}
            </div>
            {agents && agents.length > 0 ? (
              <p className="text-xs text-[var(--muted-foreground-2)]">
                {visibleAgents?.length ?? 0} of {agents.length} {showArchived ? "archived" : "saved"} employees
              </p>
            ) : null}
          </section>
          {workspaceId ? (
            <PrimaryBotPicker
              workspaceId={workspaceId}
              agents={(agents ?? []).filter((agent) => !agent.archivedAt).map((agent) => ({
                slug: agent.slug,
                name: agent.config.name,
              }))}
            />
          ) : null}
          {selectedAgent ? (
            <section ref={profileSection} tabIndex={-1} aria-label={`${selectedAgent.config.name} overview`} className="rounded-[var(--radius-card)] border border-[var(--border-1)] bg-[var(--card)] p-5 shadow-[var(--sh-card)]">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex min-w-0 items-center gap-3">
                  <AgentAvatar agentId={selectedAgent.id} name={selectedAgent.config.name} mascotPreset={selectedAgent.config.mascotPreset} look={selectedAgent.config.look} avatar={selectedAgent.config.avatar} slug={selectedAgent.slug} role={employeeRole(selectedAgent.slug, selectedAgent.config.roleTemplateId)} large />
                  <div className="min-w-0"><p className={OVERLINE}>Saved profile · v{selectedAgent.version}</p><h2 className="break-words font-[family-name:var(--font-display)] text-xl font-semibold tracking-tight">{selectedAgent.config.name}</h2><p className="text-xs text-[var(--muted-foreground-2)]">{employeeRoleLabel(employeeRole(selectedAgent.slug, selectedAgent.config.roleTemplateId))}</p><button type="button" disabled={!canManage(selectedAgent.id)} onClick={() => { setAvatarError(null); setAvatarEditorFor(selectedAgent); }} className="mt-1 min-h-9 rounded-[var(--radius-button)] border border-[var(--border-1)] px-2 text-[11px] hover:bg-[var(--card-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)] disabled:opacity-50">Edit avatar</button></div>
                </div>
                <button type="button" className={BTN} onClick={() => { setSelectedAgentId(null); profileTrigger.current?.focus(); }}>Close profile</button>
              </div>
              <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <div className="flex min-w-0 flex-col gap-5">
                  <dl className="grid gap-3 text-xs sm:grid-cols-2">
                    <div><dt className="text-[var(--muted-foreground-2)]">Harness</dt><dd className="break-words font-mono">{selectedAgent.config.harness}</dd></div>
                    <div><dt className="text-[var(--muted-foreground-2)]">Model</dt><dd className="break-words font-mono">{selectedAgent.config.codingModel || "Workspace default"}</dd></div>
                    <div><dt className="text-[var(--muted-foreground-2)]">Sandbox</dt><dd>{selectedAgent.config.sandboxProvider || "Organization default"}</dd></div>
                    <div><dt className="text-[var(--muted-foreground-2)]">Repository</dt><dd className="break-all">{selectedAgent.config.defaultRepoUrl || "Choose when starting work"}</dd></div>
                    {selectedAgent.config.expectedDeliverables?.length ? <div className="sm:col-span-2"><dt className="text-[var(--muted-foreground-2)]">Required deliverables</dt><dd className="break-all font-mono">{selectedAgent.config.expectedDeliverables.join(", ")}</dd></div> : null}
                  </dl>
                  <div>
                    <h3 className="text-xs font-medium">Instructions</h3>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm text-[var(--muted-foreground-2)]">{selectedAgent.config.instructions}</p>
                  </div>
                  <div>
                    <h3 className="text-xs font-medium">How work runs</h3>
                    <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-5 text-xs leading-relaxed text-[var(--muted-foreground-2)]">
                      <li>Describe the task in a dedicated thread.</li>
                      <li>{INTERACTIVE_APPROVAL}</li>
                      <li>The employee runs approved work inside the approved repository scope.</li>
                      <li>Results and any required deliverables return to the thread.</li>
                    </ol>
                    <p className="mt-2 text-xs leading-relaxed text-[var(--muted-foreground-2)]">{AUTOMATION_APPROVAL}</p>
                  </div>
                </div>
                <aside aria-label="Boundaries" className="flex h-fit flex-col gap-2 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--panel)] p-4 text-xs leading-relaxed text-[var(--muted-foreground-2)]">
                  <h3 className="flex items-center gap-1.5 text-xs font-medium text-[var(--fg)]"><ShieldCheck className="size-4" aria-hidden="true" />Boundaries</h3>
                  <p>Saving a profile grants no tool or app access. A model connection only provides model access; it does not grant tool permissions or spending authority.</p>
                  <ToolPolicyNote workspaceId={workspaceId} onOpenToolPolicy={onOpenToolPolicy} />
                </aside>
              </div>
              {!workspaceId ? <EmployeeRoutines key={selectedAgent.id} employeeId={selectedAgent.id} /> : null}
              {workspaceId ? <EmployeeAccessSettings key={selectedAgent.id} workspaceId={workspaceId} employeeId={selectedAgent.id} onAccessChange={(level) => setCallerLevels((current) => ({ ...current, [selectedAgent.id]: level }))} /> : null}
              {!showArchived ? <button type="button" disabled={busy || !canManage(selectedAgent.id)} onClick={() => startEdit(selectedAgent)} className={`${BTN} mt-4`}>Edit profile</button> : null}
            </section>
          ) : null}
          {loadError ? <LoadErrorState message={loadError} onRetry={refresh} /> : null}
      {avatarEditorFor ? (
        <BotAvatarEditor
          name={avatarEditorFor.config.name}
          current={avatarEditorFor.config.avatar}
          busy={avatarBusy}
          error={avatarError}
          onCancel={() => { setAvatarEditorFor(null); setAvatarError(null); }}
          onSave={(choice) => void saveAvatar(avatarEditorFor, choice)}
        />
      ) : null}

          {agents === null && !loadError ? (
            <div role="status" aria-busy="true" aria-label="Loading bots">
              <SkeletonLines rows={4} />
            </div>
          ) : null}

          {agents && agents.length === 0 ? (
            <EmptyState
              title={showArchived ? "No archived bots" : "No bots"}
              detail={showArchived ? "Archived bots appear here and can be restored." : "Choose New bot to save an employee, then launch it to open a thread."}
            />
          ) : null}

          {agents && agents.length > 0 && visibleAgents?.length === 0 ? (
            <div className="rounded-[var(--radius-card)] border border-dashed border-[var(--border-2)] p-5 text-sm text-[var(--muted-foreground-2)]">
              <p>No employees match your search.</p>
              <button type="button" onClick={() => { setDirectoryQuery(""); setRoleFilter(ROLE_FILTER_ALL); }} className={`${BTN} mt-2`}>Clear employee search</button>
            </div>
          ) : null}
          {agents && agents.length > 0 ? (
            <ul aria-label="Saved employees" className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {visibleAgents?.map((agent) => (
                <li
                  key={agent.id}
                  className="flex min-w-0 flex-col justify-between gap-4 rounded-[var(--radius-card)] border border-[var(--border-1)] bg-[var(--card)] p-5 shadow-[var(--sh-card)]"
                >
                  <div className="min-w-0">
                    <div className="mb-3 flex items-center gap-3"><AgentAvatar agentId={agent.id} name={agent.config.name} mascotPreset={agent.config.mascotPreset} look={agent.config.look} avatar={agent.config.avatar} slug={agent.slug} role={employeeRole(agent.slug, agent.config.roleTemplateId)} /><span className="text-xs font-medium text-[var(--muted-foreground-2)]">{employeeRoleLabel(employeeRole(agent.slug, agent.config.roleTemplateId))}</span></div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button type="button" onClick={(event) => { profileTrigger.current = event.currentTarget; focusProfile.current = true; setSelectedAgentId(agent.id); }} aria-label={`View profile ${agent.config.name}`}
                        className="min-h-11 break-words text-left font-[family-name:var(--font-display)] text-lg font-semibold leading-snug text-[var(--fg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]">{agent.config.name}</button>
                      <span className="break-all text-[11px] font-mono text-[var(--muted-foreground-2)]">
                        {agent.slug}
                        {` · v${agent.version}`}
                      </span>
                    </div>
                    <div className="text-[11px] text-[var(--muted-foreground-2)] mt-0.5 line-clamp-2">
                      {agent.config.instructions}
                    </div>
                    <div className="break-words text-[10px] font-mono text-[var(--muted-foreground-3)] mt-1">
                      Runs on {agent.config.harness}
                      {agent.config.codingModel ? ` · ${agent.config.codingModel}` : " · Default model"}
                      {agent.config.sandboxProvider ? ` · ${agent.config.sandboxProvider}` : ""}
                    </div>
                    <p className="mt-1 break-all text-xs text-[var(--muted-foreground-2)]">Repository: {agent.config.defaultRepoUrl || "Choose a project repository when starting work"}</p>
                    {onOpenThread ? (
                      <div className="mt-3 border-t border-[var(--border-1)] pt-2">
                        <h3 className="text-[10px] font-mono text-[var(--muted-foreground-2)]">Threads started with this bot</h3>
                        {threadsLoading ? (
                          <p className="mt-1 text-xs text-[var(--muted-foreground-2)]">Loading threads…</p>
                        ) : threadsUnavailable ? (
                          <p className="mt-1 text-xs text-[var(--warning-fg)]">Thread history is unavailable. Try refreshing the page.</p>
                        ) : agentThreads(threads, agent.id).length === 0 ? (
                          <p className="mt-1 text-xs text-[var(--muted-foreground-2)]">No threads yet.</p>
                        ) : (
                          <ul aria-label={`${agent.config.name} threads`} className="mt-1 flex flex-col gap-1">
                            {agentThreads(threads, agent.id).map((thread) => (
                              <li key={thread.id}>
                                <button type="button" onClick={() => onOpenThread(thread.id)} className="flex w-full items-center gap-2 rounded-[var(--radius-button)] py-1 text-left text-xs text-[var(--fg)] hover:text-[var(--primary)]">
                                  <span className="truncate">{thread.name}</span>
                                  <span className="shrink-0 text-[10px] text-[var(--muted-foreground-3)]">{formatTimeAgo(thread.updatedAt)}</span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-2">
                    {onStartThread && !showArchived ? (
                      <button
                        type="button"
                        disabled={startingAgentId !== null || busy || (Boolean(workspaceId) && !["chat", "manage"].includes(callerLevels[agent.id] ?? "none"))}
                        onClick={() => void startThread(agent)}
                        aria-label={`Launch bot ${agent.config.name}`}
                        className="min-h-11 rounded-[var(--radius-button)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)] text-[11px] border border-[var(--primary)] text-[var(--primary)] px-2 py-1 disabled:opacity-50"
                      >
                        {startingAgentId === agent.id ? "Launching…" : "Launch bot"}
                      </button>
                    ) : null}
                    <button type="button" disabled={busy || !canManage(agent.id)} onClick={() => void changeLifecycle(agent, showArchived ? "restore" : "archive")}
                      aria-label={`${showArchived ? "Restore" : "Archive"} bot ${agent.config.name}`}
                      className="min-h-11 rounded-[var(--radius-button)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)] text-[11px] border border-[var(--border-1)] px-2 py-1 disabled:opacity-50">
                      {showArchived ? "Restore bot" : "Archive bot"}
                    </button>
                    {!showArchived ? <button
                      type="button"
                      disabled={busy || !canManage(agent.id)}
                      onClick={() => startEdit(agent)}
                      className="min-h-11 rounded-[var(--radius-button)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)] text-[11px] border border-[var(--border-1)] px-2 py-1"
                    >
                      Edit bot
                    </button> : null}
                    {confirmDeleteId === agent.id ? (
                      <button
                        type="button"
                        disabled={busy || !canManage(agent.id)}
                        onClick={() => void deleteAgent(agent.id)}
                        className="min-h-11 rounded-[var(--radius-button)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)] text-[11px] border border-[var(--destructive)]/40 text-[var(--destructive)] px-2 py-1"
                      >
                        Confirm delete bot
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy || !canManage(agent.id)}
                        onClick={() => setConfirmDeleteId(agent.id)}
                        className="min-h-11 rounded-[var(--radius-button)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)] text-[11px] border border-[var(--destructive)]/40 text-[var(--destructive)] px-2 py-1"
                      >
                        Delete bot
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          {notice ? <StatusNotice tone={notice.tone}>{notice.text}</StatusNotice> : null}

          <AgentTemplatesCatalog workspaceId={workspaceId} onUse={async (template: AgentTemplate, savedConfig?: CustomAgentConfig) => {
            if (!isActive()) return;
            const response = await fetch("/api/custom-agents", { method: "POST", headers: { "Content-Type": "application/json", ...teamWorkspaceHeaders(workspaceId) }, body: JSON.stringify({ slug: savedConfig ? `${template.id.slice(0, 39)}-${crypto.randomUUID().slice(0, 8)}` : template.id, config: savedConfig ?? { name: template.name, look: defaultLookFor(template.id, template.roleTemplateId), instructions: template.instructions, harness: template.harness ?? "opencode", ...(template.roleTemplateId ? { roleTemplateId: template.roleTemplateId } : {}), ...(template.expectedDeliverables ? { expectedDeliverables: template.expectedDeliverables } : {}), ...(template.appearance ? { emoji: template.appearance } : {}) } }) });
            const body = await response.json().catch(() => ({})) as { error?: string };
            if (!isActive()) return;
            if (!response.ok) throw new Error(body.error ?? `Could not add template (${response.status}).`);
            refresh();
          }} />

          {!showArchived ? (
            <form
              className={`rounded-[var(--radius-card)] border border-[var(--border-1)] bg-[var(--card)] p-5 flex flex-col gap-5 shadow-[var(--sh-card)] ${editingId ? "" : "w-full max-w-3xl self-center"}`}
              aria-busy={busy}
              onSubmit={(event) => {
                event.preventDefault();
                void saveAgent();
              }}
              onKeyDown={onFormKeyDown}
            >
              <div className="flex items-center justify-between gap-2 border-b border-[var(--border-1)] pb-3">
                <div className="flex items-center gap-2.5">
                  <MascotAvatar id={editingId ?? (form.slug || form.name || "new-agent")} name={form.name || "New agent"} mascotPreset={(form.mascotPreset as CustomAgentConfig["mascotPreset"]) || undefined} look={formLook(form.lookShape, form.lookColor, form.lookEyes, form.lookAcc)} avatar={savedAvatar} role={employeeRole(form.slug || form.name, (form.roleTemplateId as CustomAgentRoleTemplateId) || undefined)} size={32} decorative />
                  <div>
                    <h2 className="text-sm font-semibold text-[var(--fg)]">
                      {editingId ? "Edit bot" : "New bot"}
                    </h2>
                    <p className="text-[11px] text-[var(--muted-foreground-2)]">
                      {editingId ? "Update your custom agent settings" : "Create a custom agent with standing instructions"}
                    </p>
                  </div>
                </div>
                {editingId ? (
                  <button type="button" onClick={() => resetForm()} className="text-xs text-[var(--primary)] hover:underline">
                    Cancel edit
                  </button>
                ) : hasDraft(form) ? (
                  <button type="button" disabled={busy} onClick={() => resetForm(true)} className="text-xs text-[var(--primary)] hover:underline">
                    Discard draft
                  </button>
                ) : null}
              </div>

              {!editingId && draftScope ? (
                <p role="status" className="text-xs text-[var(--muted-foreground-2)]">
                  {draftStorageAvailable ? "Draft saved only on this browser for your account. Return here after setup or reload to continue." : "Browser storage is unavailable. Keep this page open to retain your draft."}
                </p>
              ) : null}

              <section aria-labelledby={stageRoleId} className="flex flex-col gap-4">
              <div>
                {!editingId ? <p className={OVERLINE}>Step 1 of 3</p> : null}
                <h3 id={stageRoleId} className="text-base font-semibold text-[var(--fg)]">Define the role</h3>
                <p className="mt-1 text-xs text-[var(--muted-foreground-2)]">Start with a clear responsibility. The employee prepares work; people keep approval authority.</p>
              </div>
              <fieldset disabled={busy || (editingId !== null && !canManage(editingId))} className="min-w-0">
              <AgentLookStyler
                id={form.slug || form.name || "new-agent"}
                role={employeeRole(form.slug || form.name, (form.roleTemplateId as CustomAgentRoleTemplateId) || undefined)}
                preset={(form.mascotPreset as CustomAgentConfig["mascotPreset"]) || undefined}
                shape={form.lookShape}
                color={form.lookColor}
                eyes={form.lookEyes}
                acc={form.lookAcc}
                onStarterPick={focusName}
                onAutomatic={() => setForm((current) => ({ ...current, mascotPreset: "", lookShape: "", lookColor: "", lookEyes: "", lookAcc: "" }))}
                onCustomize={(next) => setForm((current) => ({ ...current, mascotPreset: "", lookShape: next.shape, lookColor: next.color, lookEyes: next.eyes, lookAcc: next.acc }))}
              />
              </fieldset>
              {savedAvatar ? <p className="text-xs text-[var(--muted-foreground-2)]">This employee has a saved avatar, which takes precedence over the look above. Change it with Edit avatar on the saved profile.</p> : null}

              <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
                Name
                <input
                  type="text"
                  ref={nameInput}
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Research partner"
                  className={FIELD}
                />
              </label>

              <div className="flex flex-col gap-1">
                <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
                  Role
                  <select
                    value={form.roleTemplateId}
                    disabled={busy}
                    aria-describedby={roleHelpId}
                    onChange={(e) => setForm((f) => ({ ...f, roleTemplateId: e.target.value }))}
                    className={FIELD}
                  >
                    <option value="">Custom (role may be inferred from slug)</option>
                    {EMPLOYEE_TEMPLATES.map((template) => <option key={template.id} value={template.id}>{template.label}</option>)}
                  </select>
                </label>
                <p id={roleHelpId} className="text-xs text-[var(--muted-foreground-2)]">Role labels grant no tools or access. Recognized slugs may still receive a role label.</p>
              </div>

              <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
                Instructions
                <textarea
                  value={form.instructions}
                  onChange={(e) => setForm((f) => ({ ...f, instructions: e.target.value }))}
                  placeholder="Finds evidence and challenges assumptions."
                  rows={4}
                  className={`${FIELD} resize-y min-h-[88px]`}
                />
              </label>

              {workspaceId ? (
                <p className="text-xs text-[var(--muted-foreground-2)]">After you save this employee, manage who can use it under Access on its saved profile.</p>
              ) : null}

              {pendingTemplate ? (
                <div role="alertdialog" aria-modal="false" aria-labelledby={templateTitleId} aria-describedby={templateDescriptionId}
                  onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); keepCurrentDraft(); } }}
                  className="rounded-[var(--radius-button)] border border-[var(--border-2)] bg-[var(--panel)] p-3">
                  <h3 id={templateTitleId} className="text-sm font-semibold text-[var(--fg)]">Replace this draft with the {pendingTemplate.label} role?</h3>
                  <p id={templateDescriptionId} className="mt-1 text-xs text-[var(--muted-foreground-2)]">This replaces the name, slug, mark, instructions, and required deliverables in this unsaved draft. Your harness, model, connection, sandbox, and repository stay selected.</p>
                  <div className="mt-3 flex flex-wrap gap-3 text-xs">
                    <button ref={keepDraftButton} type="button" onClick={keepCurrentDraft}>Keep current draft</button>
                    <button type="button" onClick={() => applyTemplate(pendingTemplate)} className="text-[var(--primary)]">Replace draft</button>
                  </div>
                </div>
              ) : null}

              <details className="border-t border-[var(--border-1)] pt-3">
                <summary className="cursor-pointer text-xs font-semibold text-[var(--fg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]">Use a role template</summary>
                <div className="mt-3 flex flex-col gap-3">
                  <fieldset className="flex flex-col gap-2">
                    <legend className="mb-1 text-xs font-semibold text-[var(--fg)]">Start from a role</legend>
                    <p className="text-xs text-[var(--muted-foreground-2)]">
                      Role templates fill an editable bot draft. Tasks produce files in an approved repository. External posting needs a supported connection and separate approval.
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {EMPLOYEE_TEMPLATES.map((template) => (
                        <button key={template.id} type="button" aria-label={template.label} disabled={busy || editingId !== null}
                          onClick={(event) => chooseTemplate(template, event.currentTarget)}
                          className="rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--bg)] p-3 text-left disabled:opacity-50">
                          <MascotAvatar id={template.id} name={template.label} role={template.id} size={36} decorative className="mb-2" />
                          <span className="block text-xs font-medium text-[var(--fg)]">{template.label}</span>
                          <span className="mt-1 block text-[11px] text-[var(--muted-foreground-2)]">{template.description}</span>
                        </button>
                      ))}
                    </div>
                    {editingId ? <p className="text-xs text-[var(--muted-foreground-2)]">Role templates start new bots. Finish or cancel editing before choosing a role.</p> : null}
                  </fieldset>
                </div>
              </details>
              </section>

              <section aria-labelledby={stageBoundariesId} className={STAGE}>
              <div>
                {!editingId ? <p className={OVERLINE}>Step 2 of 3</p> : null}
                <h3 id={stageBoundariesId} className="text-base font-semibold text-[var(--fg)]">Set boundaries</h3>
              </div>
              <div className="flex gap-3 rounded-[var(--radius-card)] border border-[var(--border-1)] bg-[var(--panel)] p-4">
                <ShieldCheck className="mt-0.5 size-5 shrink-0 text-[var(--primary)]" aria-hidden="true" />
                <div className="min-w-0 text-xs leading-relaxed text-[var(--muted-foreground-2)]">
                  <p className="text-sm font-medium text-[var(--fg)]">Interactive task approval</p>
                  <p className="mt-1">A profile grants no tool or app access. {INTERACTIVE_APPROVAL}</p>
                  <p className="mt-1">{AUTOMATION_APPROVAL}</p>
                  <div className="mt-1"><ToolPolicyNote workspaceId={workspaceId} onOpenToolPolicy={onOpenToolPolicy} /></div>
                </div>
              </div>

              <details key={editingId ?? "new"} open={editingId ? true : undefined} className="border-t border-[var(--border-1)] pt-3">
                <summary className="cursor-pointer text-xs font-semibold text-[var(--fg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)] flex items-center justify-between">
                  <span>Advanced settings</span>
                  <span className="text-[11px] font-normal text-[var(--muted-foreground-2)]">
                    {form.codingModel ? `${form.codingModel} · Default tool policy` : "Default model · Default tool policy"}
                  </span>
                </summary>
                <div className="mt-3 flex flex-col gap-3">
                  <p className="text-xs text-[var(--muted-foreground-2)]">Optional overrides. Model and sandbox availability are checked before a task is queued. Leave these settings unchanged to use existing defaults.</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
                      Model
                      <input value={form.codingModel} list="custom-agent-models" placeholder="Use the harness default"
                        onChange={(event) => setForm((current) => ({ ...current, codingModel: event.target.value }))} className={FIELD} />
                      <datalist id="custom-agent-models">
                        {codingModelOptions(modelSuggestions, connections, form.connectionId).map((model) => <option key={model} value={model} />)}
                      </datalist>
                    </label>
                    <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
                      Model connection
                      <select value={form.connectionId} onChange={(event) => setForm((current) => ({ ...current, connectionId: event.target.value }))} className={FIELD}>
                        <option value="">Use deployment default</option>
                        {form.connectionId && !connections.some((connection) => connection.id === form.connectionId)
                          ? <option value={form.connectionId}>Saved connection (unavailable)</option> : null}
                        {connections.filter((connection) => connection.status === "ready").map((connection) => <option key={connection.id} value={connection.id}>{connection.label}</option>)}
                      </select>
                    </label>
                  </div>
                  {editingConfig?.toolScopes?.length ? <button type="button" onClick={() => setEditingConfig((current) => current ? { ...current, toolScopes: [] } : current)} className="text-xs text-[var(--warning-fg)] text-left">
                    Custom tool grants are unsupported. Use default tool permissions to save this profile.
                  </button> : null}
                  <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
                    Slug
                    <input
                      type="text"
                      value={form.slug}
                      disabled={Boolean(editingId)}
                      onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
                      placeholder="security-reviewer"
                      className={FIELD}
                    />
                  </label>
                  <p className="text-xs text-[var(--muted-foreground-2)]">Slug is generated from the name when left blank. Choose a unique slug if that name is already in use.</p>
                  <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
                    Mark
                    <input
                      type="text"
                      value={form.emoji}
                      onChange={(e) => setForm((f) => ({ ...f, emoji: e.target.value }))}
                      placeholder="Optional short mark"
                      className={FIELD}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
                    Required deliverables
                    <textarea aria-label="Required deliverables" value={form.expectedDeliverables} onChange={(event) => setForm((current) => ({ ...current, expectedDeliverables: event.target.value }))}
                      placeholder={"reports/summary.md\nreports/sources.json"} rows={3} className={`${FIELD} resize-y`} />
                  </label>
                  <p className="text-xs text-[var(--muted-foreground-2)]">Optional: one repository path per line, up to 8 .md, .txt, .json, or .csv files. Presence and format checks confirm returned files; they do not guarantee accuracy or quality.</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
                      Harness
                      <input
                        type="text"
                        value={form.harness}
                        onChange={(e) => setForm((f) => ({ ...f, harness: e.target.value }))}
                        className={FIELD}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
                      Sandbox
                      <select
                        value={form.sandboxProvider}
                        onChange={(e) => setForm((f) => ({ ...f, sandboxProvider: e.target.value }))}
                        className={FIELD}
                      >
                        <option value="">Org default</option>
                        {SANDBOX_PROVIDERS.map((id) => (
                          <option key={id} value={id}>{id}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
                    Default repository
                    <input
                      type="url"
                      value={form.defaultRepoUrl}
                      onChange={(e) => setForm((f) => ({ ...f, defaultRepoUrl: e.target.value }))}
                      placeholder="https://github.com/owner/repo"
                      className={`${FIELD} font-mono`}
                    />
                  </label>
                </div>
              </details>

              </section>

              <section aria-labelledby={stageReviewId} className={STAGE}>
              <div>
                {!editingId ? <p className={OVERLINE}>Step 3 of 3</p> : null}
                <h3 id={stageReviewId} className="text-base font-semibold text-[var(--fg)]">{editingId ? "Review changes" : "Review the hire"}</h3>
              </div>
              <dl className="grid grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
                <dt className="text-[var(--muted-foreground-2)]">Employee</dt><dd className="break-words">{form.name.trim() || "Not named yet"} · {reviewRole}</dd>
                <dt className="text-[var(--muted-foreground-2)]">Runs on</dt><dd className="break-words font-mono">{form.harness.trim() || "opencode"} · {form.codingModel.trim() || "default model"}</dd>
                <dt className="text-[var(--muted-foreground-2)]">Connection</dt><dd className="break-words">{reviewConnection || "Deployment default"}</dd>
                <dt className="text-[var(--muted-foreground-2)]">Sandbox</dt><dd>{form.sandboxProvider || "Organization default"}</dd>
                <dt className="text-[var(--muted-foreground-2)]">Repository</dt><dd className="break-all">{form.defaultRepoUrl.trim() || "Chosen when starting work"}</dd>
                <dt className="text-[var(--muted-foreground-2)]">Deliverables</dt><dd>{reviewDeliverables ? `${reviewDeliverables} required path${reviewDeliverables === 1 ? "" : "s"}` : "None required"}</dd>
                <dt className="text-[var(--muted-foreground-2)]">Approval</dt><dd>Interactive tasks and automated runs require human approval.</dd>
              </dl>
              <p className="text-xs text-[var(--muted-foreground-2)]">Creating a profile does not start a thread, computer, or run. Tool access is not granted by the profile.</p>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--border-1)]">
                <button
                  type="button"
                  onClick={() => resetForm(!editingId)}
                  className={BTN}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy || (editingId !== null && !canManage(editingId)) || pendingTemplate !== null || !form.name.trim() || !form.instructions.trim()}
                  aria-label={editingId ? "Save changes" : "Create bot"}
                  className={BTN_PRIMARY}
                >
                  {busy ? "Saving…" : editingId ? "Save changes" : "Create bot"}
                </button>
              </div>
              </section>
              {conflict ? <button type="button" disabled={busy} onClick={() => void reloadEditingAgent()} className="self-start text-xs text-[var(--primary)]">Reload latest bot</button> : null}
            </form>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Picker options are isolated by the verified account and selected workspace. */
export function useCustomAgentOptions(enabled = true, workspaceId?: string, actorId?: string): {
  agents: CustomAgentWire[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  /** Replace one record with the server's answer, so its version stays current. */
  applyAgent: (agent: CustomAgentWire) => void;
} {
  const scope = enabled ? JSON.stringify([actorId?.trim().toLowerCase() ?? "", workspaceId ?? ""]) : "";
  const current = useRef({ scope, generation: 0 });
  const requestSequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  if (current.current.scope !== scope) {
    current.current = { scope, generation: current.current.generation + 1 };
    requestSequence.current++;
  }
  const generation = current.current.generation;
  const [state, setState] = useState<{
    scope: string; generation: number; agents: CustomAgentWire[]; loading: boolean; error: string | null;
  }>({ scope, generation, agents: [], loading: enabled, error: null });

  const refresh = useCallback(() => {
    if (!enabled || current.current.scope !== scope || current.current.generation !== generation) return;
    controller.current?.abort();
    const requestController = new AbortController();
    controller.current = requestController;
    const request = ++requestSequence.current;
    const active = () => !requestController.signal.aborted && request === requestSequence.current &&
      current.current.scope === scope && current.current.generation === generation;
    setState((previous) => ({ scope, generation,
      agents: previous.scope === scope && previous.generation === generation ? previous.agents : [],
      loading: true, error: null }));
    void fetch("/api/custom-agents", { headers: teamWorkspaceHeaders(workspaceId), signal: requestController.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        return (await response.json()) as { agents?: CustomAgentWire[] };
      })
      .then((body) => {
        if (active()) setState({ scope, generation, agents: body.agents ?? [], loading: false, error: null });
      })
      .catch(() => {
        if (active()) setState({ scope, generation, agents: [], loading: false, error: "unavailable" });
      });
  }, [enabled, scope, generation, workspaceId]);

  useEffect(() => {
    if (enabled) refresh();
    return () => { controller.current?.abort(); requestSequence.current++; };
  }, [refresh, enabled]);

  // A saved record replaces its own row instead of waiting for the next list
  // fetch: a second edit must carry the version the first save returned.
  const applyAgent = useCallback((agent: CustomAgentWire) => {
    setState((previous) => previous.scope !== scope || previous.generation !== generation
      ? previous
      : { ...previous, agents: previous.agents.map((item) => item.id === agent.id ? agent : item) });
  }, [scope, generation]);

  const visible = enabled && state.scope === scope && state.generation === generation;
  return {
    agents: visible ? state.agents : [], loading: enabled && (!visible || state.loading),
    error: visible ? state.error : null, refresh, applyAgent,
  };
}
