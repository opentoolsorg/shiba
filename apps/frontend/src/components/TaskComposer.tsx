import {
  type JSX,
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  Container,
  Cpu,
  Eraser,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  Laptop,
  Plus,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { Tooltip } from "./Tooltip";
import type { SavedSkill } from "../saved";

/** Model-by-purpose routing controls — the picker's values and its option lists. */
export interface ModelRoutingControl {
  codingModel: string;
  connectionId: string;
  onCodingModelChange: (value: string) => void;
  onConnectionChange: (value: string) => void;
  /** Coding-purpose models from /api/model-config (the "auto" floor plus registered connections). */
  modelSuggestions?: string[];
  connections?: { id: string; label: string; status: string; service?: string }[];
}

export interface TaskComposerProps {
  repoUrl: string;
  task: string;
  baseBranch: string;
  publishPullRequest: boolean;
  harness: string;
  /** T63 — desktop "Run on" control. Rendered only when the shell reports a
   *  paired, ready daemon (localRunAvailable). "sandbox" keeps the chat path. */
  runTarget?: "sandbox" | "local";
  onRunTargetChange?: (value: "sandbox" | "local") => void;
  localRunAvailable?: boolean;
  routing: ModelRoutingControl;
  busy: boolean;
  isSubmitting: boolean;
  clearing: boolean;
  onRepoUrlChange: (value: string) => void;
  onTaskChange: (value: string) => void;
  onBaseBranchChange: (value: string) => void;
  onPublishPullRequestChange: (value: boolean) => void;
  onHarnessChange: (value: string) => void;
  onSubmit: (event: SyntheticEvent) => void;
  onClear: () => void;
  /** Saved repos + run-history repos for the URL picker. */
  repoSuggestions?: string[];
  /** Your saved skills — toggle them onto the run. */
  skills?: SavedSkill[];
  selectedSkillIds?: string[];
  onToggleSkill?: (id: string) => void;
  /** "docked" = compact bar under the timeline; "hero" = centered empty-state card. */
  variant?: "docked" | "hero";
}

// Keep the picker simple: the two everyday harnesses. Everything else stays
// reachable — a deployment default, role pin, MCP, or API call naming codex /
// devin / a subscription / an ACP lane still resolves and runs; when such a
// harness is already selected it is appended to the list so the field never
// renders blank.
const HARNESS_OPTIONS: { value: string; label: string; desc: string }[] = [
  { value: "opencode", label: "OpenCode", desc: "Default autonomous coding engine" },
  { value: "claude-code", label: "Claude Code", desc: "Anthropic Claude Code CLI" },
];

// Only these harnesses declare local support — the backend refuses anything
// else at intake (orchestrator.ts), so the local lane pins to this set.
const LOCAL_HARNESS_OPTIONS: { value: string; label: string; desc: string }[] = [
  { value: "opencode", label: "OpenCode", desc: "Default autonomous coding engine" },
  { value: "claude-code", label: "Claude Code", desc: "Anthropic Claude Code CLI" },
  { value: "codex", label: "Codex", desc: "OpenAI Codex CLI" },
];

type PopoverKind = "menu" | "repo" | "branch" | "harness" | "model" | "access" | null;

/** owner/repo from a GitHub URL; falls back to the trimmed raw value. */
function repoSlugOf(repoUrl: string): string {
  const clean = repoUrl
    .trim()
    .replace(/\/git$/, "")
    .replace(/\.git$/, "");
  const parts = clean.split("/").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/") : clean;
}

/** provider/model → the model tail shown on the pill (provider stays visible in the menu). */
function modelTail(model: string): string {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(slash + 1) : model;
}

/**
 * One popover surface anchored to its trigger. Panels open upward — the
 * composer docks at the viewport bottom, so a downward menu would clip.
 * Closes on Escape and on any pointerdown outside its wrapper.
 */
function Popover({
  kind,
  open,
  onClose,
  labelledBy,
  className = "",
  children,
}: {
  kind: Exclude<PopoverKind, null>;
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  className?: string;
  children: ReactNode;
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      ref={ref}
      role="menu"
      aria-labelledby={labelledBy}
      data-popover={kind}
      className={`absolute bottom-full mb-1.5 z-40 bg-[#fffef8] border border-[#d3d2c8] rounded-none shadow-[3px_3px_0_var(--paper-shadow)] overflow-hidden ${className}`}
    >
      {children}
    </div>
  );
}

const pillClass =
  "inline-flex items-center gap-1.5 text-xs text-[#6a6f63] hover:text-[#222320] hover:bg-black/[0.05] border border-transparent hover:border-[#e0ded5] px-2 py-1.5 touch:min-h-11 rounded-none transition-colors cursor-pointer select-none max-w-[220px]";
const pillLabelClass = "truncate font-medium";
const menuRowClass =
  "w-full flex items-center gap-2.5 px-3.5 py-2 text-left text-xs text-[#222320] hover:bg-[#0000a8]/10 transition-colors cursor-pointer";
const menuIconClass = "w-3.5 h-3.5 text-[#6a6f63] shrink-0";
const menuCheckClass = "w-3.5 h-3.5 text-[#1c1cc8] shrink-0";
const sectionLabelClass =
  "text-[10px] font-semibold uppercase tracking-[0.12em] text-[#6a6f63]";
const inputClass =
  "bg-[#f1efe6] border border-[#e0ded5] rounded-none text-[#222320] px-2.5 py-1.5 text-xs focus:outline-none focus:border-[#1c1cc8] focus:ring-1 focus:ring-[#1c1cc8]/40 placeholder-[#6a6f63]/60 transition-colors";

export function TaskComposer({
  repoUrl,
  task,
  baseBranch,
  publishPullRequest,
  harness,
  runTarget = "sandbox",
  onRunTargetChange,
  localRunAvailable = false,
  routing,
  busy,
  isSubmitting,
  clearing,
  onRepoUrlChange,
  onTaskChange,
  onBaseBranchChange,
  onPublishPullRequestChange,
  onHarnessChange,
  onSubmit,
  onClear,
  repoSuggestions = [],
  skills = [],
  selectedSkillIds = [],
  onToggleSkill,
  variant = "docked",
}: TaskComposerProps): JSX.Element {
  const sendDisabled = busy || task.trim() === "" || repoUrl.trim() === "";
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const hero = variant === "hero";

  const [open, setOpen] = useState<PopoverKind>(null);
  const [menuView, setMenuView] = useState<"root" | "skills">("root");
  const [repoFilter, setRepoFilter] = useState("");
  const [repoUrlDraft, setRepoUrlDraft] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [modelDraft, setModelDraft] = useState("");
  const [branchDraft, setBranchDraft] = useState("");
  const baseId = useId();
  const idFor = (name: string) => `${baseId}-${name}`;

  const toggle = useCallback(
    (kind: Exclude<PopoverKind, null>) => {
      setOpen((current) => {
        const next = current === kind ? null : kind;
        if (next !== null) {
          // Fresh drafts each open; the skills submenu always re-enters at root.
          if (next !== "menu") setMenuView("root");
          if (next === "repo") {
            setRepoFilter("");
            setRepoUrlDraft(repoUrl.startsWith("https://") ? "" : repoUrl);
          }
          if (next === "model") {
            setModelFilter("");
            setModelDraft("");
          }
          if (next === "branch") {
            setBranchDraft(baseBranch);
          }
        }
        return next;
      });
    },
    [repoUrl, baseBranch],
  );
  const close = useCallback(() => setOpen(null), []);

  // Auto-grow the task field up to ~192px, then scroll. Runs after every
  // render — the controlled value is already flushed, and three DOM writes
  // are cheaper than tracking which state could resize the box.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
  });

  const handleSubmit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (sendDisabled) return;
    setOpen(null);
    onSubmit(event);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      handleSubmit(event);
    }
  };

  const harnessBase = runTarget === "local" ? LOCAL_HARNESS_OPTIONS : HARNESS_OPTIONS;
  const harnessOptions =
    harness !== "" && !harnessBase.some((h) => h.value === harness)
      ? [...harnessBase, { value: harness, label: harness, desc: "Deployment-pinned harness" }]
      : harnessBase;
  const currentHarness = harnessOptions.find((h) => h.value === harness);
  const connections = routing.connections ?? [];
  const currentConnection = connections.find((c) => c.id === routing.connectionId);
  const modelSuggestions = routing.modelSuggestions ?? [];

  const repoSlug = repoSlugOf(repoUrl);
  const repoFilterLower = repoFilter.trim().toLowerCase();
  const filteredRepos = repoSuggestions.filter((repo) =>
    repoFilterLower === "" ? true : repo.toLowerCase().includes(repoFilterLower),
  );
  const modelFilterLower = modelFilter.trim().toLowerCase();
  const filteredModels = modelSuggestions.filter((model) =>
    modelFilterLower === "" ? true : model.toLowerCase().includes(modelFilterLower),
  );
  const modelKnown = routing.codingModel === "" || modelSuggestions.includes(routing.codingModel);
  const selectedSkills = skills.filter((skill) => selectedSkillIds.includes(skill.id));

  const pickRepo = (url: string) => {
    onRepoUrlChange(url);
    setOpen(null);
  };
  const applyBranch = () => {
    onBaseBranchChange(branchDraft.trim() || "main");
    setOpen(null);
  };
  const applyCustomModel = () => {
    const next = modelDraft.trim();
    if (next) routing.onCodingModelChange(next);
    setOpen(null);
  };

  const chevron = (
    <ChevronDown aria-hidden="true" className="w-3 h-3 text-[#6a6f63]/70 shrink-0" />
  );

  const form = (
    <form
      data-testid="task-composer"
      aria-label="Task composer"
      onSubmit={handleSubmit}
      className={`rounded-none border bg-[#fffef8] flex flex-col shadow-[3px_3px_0_var(--paper-shadow)] relative group focus-within:border-[#0000a8]/40 transition-colors ${hero ? "border-[#c9c8bc] p-4 sm:p-5 gap-3" : "border-[#d3d2c8] p-3 gap-2.5"}`}
    >
      <textarea
        ref={textareaRef}
        value={task}
        onChange={(event) => onTaskChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Describe the task or bug to fix (e.g. 'Fix the broken authentication test in auth.test.ts')…"
        rows={1}
        className={`w-full resize-none bg-transparent text-base lg:text-sm text-[#222320] placeholder-[#6a6f63]/70 focus:outline-none overflow-y-auto leading-relaxed ${hero ? "min-h-[96px] max-h-64" : "min-h-[72px] max-h-48"}`}
        aria-label="Task description"
      />

      {/* Selected skills ride the run — shown as removable chips. */}
      {selectedSkills.length > 0 ? (
        <fieldset className="flex items-center gap-1.5 flex-wrap" aria-label="Attached skills">
          {selectedSkills.map((skill) => (
            <span
              key={skill.id}
              className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-none border bg-[#0000a8]/10 border-[#0000a8]/30 text-[#1c1cc8]"
            >
              <Sparkles aria-hidden="true" className="w-2.5 h-2.5" />
              {skill.name}
              <button
                type="button"
                aria-label={`Remove skill ${skill.name}`}
                onClick={() => onToggleSkill?.(skill.id)}
                className="hover:text-[#222320] cursor-pointer"
              >
                <X aria-hidden="true" className="w-2.5 h-2.5" />
              </button>
            </span>
          ))}
        </fieldset>
      ) : null}

      {/* Toolbar — Devin-style: + menu, repo + branch pills … selectors, send */}
      <div className="flex items-center gap-1 flex-wrap">
        {/* + menu */}
        <div className="relative">
          <Tooltip content="Attach context and options" side="top">
            <button
              type="button"
              id={idFor("menu-button")}
              aria-haspopup="menu"
              aria-expanded={open === "menu"}
              aria-label="More options"
              onClick={() => toggle("menu")}
              className="inline-flex items-center justify-center w-7 h-7 touch:min-h-11 touch:w-11 text-[#6a6f63] hover:text-[#222320] hover:bg-black/[0.05] border border-[#e0ded5] hover:border-[#d3d2c8] rounded-none transition-colors cursor-pointer"
            >
              <Plus aria-hidden="true" className="w-4 h-4" />
            </button>
          </Tooltip>
          <Popover
            kind="menu"
            open={open === "menu"}
            onClose={close}
            labelledBy={idFor("menu-button")}
            className="left-0 w-64"
          >
            {menuView === "root" ? (
              <div className="py-1.5">
                <button
                  type="button"
                  role="menuitem"
                  className={menuRowClass}
                  onClick={() => toggle("repo")}
                >
                  <FolderGit2 aria-hidden="true" className={menuIconClass} />
                  <span className="flex-1">Repositories</span>
                  <span className="font-mono text-[10px] text-[#6a6f63] truncate max-w-[110px]">
                    {repoSlug || "none"}
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={menuRowClass}
                  onClick={() => setMenuView("skills")}
                >
                  <Sparkles aria-hidden="true" className={menuIconClass} />
                  <span className="flex-1">Skills</span>
                  {selectedSkillIds.length > 0 ? (
                    <span className="font-mono text-[10px] text-[#1c1cc8]">
                      {selectedSkillIds.length}
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={menuRowClass}
                  onClick={() => toggle("branch")}
                >
                  <GitBranch aria-hidden="true" className={menuIconClass} />
                  <span className="flex-1">Base branch</span>
                  <span className="font-mono text-[10px] text-[#6a6f63] truncate max-w-[90px]">
                    {baseBranch.trim() || "main"}
                  </span>
                </button>
                <div className="my-1 border-t border-[#e0ded5]" aria-hidden="true" />
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={publishPullRequest}
                  className={menuRowClass}
                  onClick={() => onPublishPullRequestChange(!publishPullRequest)}
                >
                  <GitPullRequest aria-hidden="true" className={menuIconClass} />
                  <span className="flex-1">Create pull request</span>
                  {publishPullRequest ? (
                    <Check aria-hidden="true" className={menuCheckClass} />
                  ) : null}
                </button>
                <div className="my-1 border-t border-[#e0ded5]" aria-hidden="true" />
                <button
                  type="button"
                  role="menuitem"
                  className={menuRowClass}
                  onClick={() => {
                    setOpen(null);
                    onClear();
                  }}
                  disabled={clearing || busy}
                >
                  <Eraser aria-hidden="true" className={menuIconClass} />
                  <span className="flex-1">
                    {clearing ? "Clearing…" : "Clear conversation"}
                  </span>
                </button>
              </div>
            ) : (
              <div className="py-1.5">
                <button type="button" className={menuRowClass} onClick={() => setMenuView("root")}>
                  <ChevronDown
                    aria-hidden="true"
                    className="w-3.5 h-3.5 text-[#6a6f63] rotate-90"
                  />
                  <span className="flex-1 font-medium">Skills</span>
                </button>
                <div className="my-1 border-t border-[#e0ded5]" aria-hidden="true" />
                {skills.length === 0 ? (
                  <p className="px-3.5 py-3 text-[11px] text-[#6a6f63]">
                    No saved skills — add them in the Skills view.
                  </p>
                ) : (
                  skills.map((skill) => {
                    const active = selectedSkillIds.includes(skill.id);
                    return (
                      <button
                        key={skill.id}
                        type="button"
                        role="menuitemcheckbox"
                        aria-checked={active}
                        className={menuRowClass}
                        onClick={() => onToggleSkill?.(skill.id)}
                      >
                        <span
                          aria-hidden="true"
                          className={`w-3.5 h-3.5 border flex items-center justify-center shrink-0 ${active ? "bg-[#0000a8] border-[#0000a8]" : "border-[#d3d2c8]"}`}
                        >
                          {active ? <Check className="w-2.5 h-2.5 text-white" /> : null}
                        </span>
                        <span className="flex-1 truncate">{skill.name}</span>
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </Popover>
        </div>

        {/* Repository pill — Devin's "All repositories" slot, end-to-end via
            saved repos + run history (repoSuggestions). */}
        <div className="relative">
          <Tooltip content="Target GitHub repository (cloned into container)" side="top">
            <button
              type="button"
              id={idFor("repo-button")}
              aria-haspopup="menu"
              aria-expanded={open === "repo"}
              aria-label={`Repository: ${repoSlug || "none selected"}`}
              onClick={() => toggle("repo")}
              className={`${pillClass} ${repoUrl.trim() === "" ? "border-dashed border-[#d3d2c8]" : ""}`}
            >
              <FolderGit2 aria-hidden="true" className="w-3.5 h-3.5 shrink-0" />
              <span className={`${pillLabelClass} font-mono`}>
                {repoSlug || "Select repository"}
              </span>
              {chevron}
            </button>
          </Tooltip>
          <Popover
            kind="repo"
            open={open === "repo"}
            onClose={close}
            labelledBy={idFor("repo-button")}
            className="left-0 w-72"
          >
            <div className="flex items-center gap-2 px-3 py-2 border-b border-[#e0ded5]">
              <Search aria-hidden="true" className="w-3.5 h-3.5 text-[#6a6f63]" />
              <input
                type="text"
                value={repoFilter}
                onChange={(event) => setRepoFilter(event.target.value)}
                placeholder="Search repositories…"
                aria-label="Search repositories"
                className="flex-1 bg-transparent text-xs text-[#222320] placeholder-[#6a6f63]/60 focus:outline-none"
              />
            </div>
            <div className="max-h-56 overflow-y-auto py-1">
              {filteredRepos.length === 0 ? (
                <p className="px-3.5 py-3 text-[11px] text-[#6a6f63]">
                  {repoSuggestions.length === 0
                    ? "No repositories yet — run one or paste a URL below."
                    : "No matches."}
                </p>
              ) : (
                filteredRepos.map((repo) => {
                  const slug = repoSlugOf(repo);
                  const active = repo === repoUrl;
                  return (
                    <button
                      key={repo}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      className={`${menuRowClass} font-mono`}
                      onClick={() => pickRepo(repo)}
                    >
                      <FolderGit2 aria-hidden="true" className={menuIconClass} />
                      <span className="flex-1 truncate">{slug}</span>
                      {active ? <Check aria-hidden="true" className={menuCheckClass} /> : null}
                    </button>
                  );
                })
              )}
            </div>
            <div className="border-t border-[#e0ded5] px-3 py-2.5 flex flex-col gap-2">
              <label htmlFor={idFor("repo-url-input")} className={sectionLabelClass}>
                Use a URL
              </label>
              <div className="flex items-center gap-1.5">
                <input
                  id={idFor("repo-url-input")}
                  type="url"
                  value={repoUrlDraft}
                  onChange={(event) => setRepoUrlDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && repoUrlDraft.trim()) {
                      event.preventDefault();
                      pickRepo(repoUrlDraft.trim());
                    }
                  }}
                  placeholder="https://github.com/owner/repo"
                  className={`${inputClass} flex-1 font-mono`}
                />
                <button
                  type="button"
                  disabled={!repoUrlDraft.trim()}
                  onClick={() => pickRepo(repoUrlDraft.trim())}
                  className="text-xs font-medium px-2 py-1.5 border border-[#e0ded5] text-[#6a6f63] hover:text-[#222320] hover:border-[#d3d2c8] rounded-none transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Use
                </button>
              </div>
            </div>
          </Popover>
        </div>

        {/* Base branch pill */}
        <div className="relative">
          <Tooltip content="Base branch to checkout" side="top">
            <button
              type="button"
              id={idFor("branch-button")}
              aria-haspopup="menu"
              aria-expanded={open === "branch"}
              aria-label={`Base branch: ${baseBranch.trim() || "main"}`}
              onClick={() => toggle("branch")}
              className={`${pillClass} ${(baseBranch.trim() || "main") !== "main" ? "text-[#1c1cc8]" : ""}`}
            >
              <GitBranch aria-hidden="true" className="w-3.5 h-3.5 shrink-0" />
              <span className={`${pillLabelClass} font-mono`}>
                {baseBranch.trim() || "main"}
              </span>
              {(baseBranch.trim() || "main") !== "main" ? (
                <span
                  aria-hidden="true"
                  className="w-1.5 h-1.5 rounded-full bg-[#1c1cc8] shrink-0"
                />
              ) : null}
            </button>
          </Tooltip>
          <Popover
            kind="branch"
            open={open === "branch"}
            onClose={close}
            labelledBy={idFor("branch-button")}
            className="left-0 w-60"
          >
            <div className="px-3 py-2.5 flex flex-col gap-2">
              <label htmlFor={idFor("branch-input")} className={sectionLabelClass}>
                Base branch
              </label>
              <input
                id={idFor("branch-input")}
                type="text"
                value={branchDraft}
                onChange={(event) => setBranchDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    applyBranch();
                  }
                }}
                placeholder="main"
                className={`${inputClass} font-mono w-full`}
              />
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  className="text-[11px] text-[#6a6f63] hover:text-[#222320] cursor-pointer"
                  onClick={() => {
                    onBaseBranchChange("main");
                    setOpen(null);
                  }}
                >
                  Reset to main
                </button>
                <button
                  type="button"
                  className="text-xs font-medium px-2.5 py-1 bg-[#0000a8] text-white hover:bg-[#1c1cc8] rounded-none transition-colors"
                  onClick={applyBranch}
                >
                  Set
                </button>
              </div>
            </div>
          </Popover>
        </div>

        <div className="flex-1" aria-hidden="true" />

        {/* Agent harness — Devin's agent slot */}
        <div className="relative">
          <Tooltip content={currentHarness?.desc ?? "Sandbox coding harness"} side="top">
            <button
              type="button"
              id={idFor("harness-button")}
              aria-haspopup="menu"
              aria-expanded={open === "harness"}
              aria-label={`Agent: ${currentHarness?.label ?? harness}`}
              onClick={() => toggle("harness")}
              className={pillClass}
            >
              <Bot aria-hidden="true" className="w-3.5 h-3.5 shrink-0" />
              <span className={pillLabelClass}>{currentHarness?.label ?? harness}</span>
              {chevron}
            </button>
          </Tooltip>
          <Popover
            kind="harness"
            open={open === "harness"}
            onClose={close}
            labelledBy={idFor("harness-button")}
            className="right-0 w-64"
          >
            <div className="py-1">
              {harnessOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={option.value === harness}
                  className={menuRowClass}
                  onClick={() => {
                    onHarnessChange(option.value);
                    setOpen(null);
                  }}
                >
                  <Bot aria-hidden="true" className={menuIconClass} />
                  <span className="flex-1 min-w-0">
                    <span className="block truncate">{option.label}</span>
                    <span className="block text-[10px] text-[#6a6f63] truncate">
                      {option.desc}
                    </span>
                  </span>
                  {option.value === harness ? (
                    <Check aria-hidden="true" className={menuCheckClass} />
                  ) : null}
                </button>
              ))}
            </div>
          </Popover>
        </div>

        {/* Model — Devin's model pill; "Auto" keeps the deployment default.
            Ready connections ride along as the route section. */}
        <div className="relative">
          <Tooltip
            content={
              routing.codingModel
                ? `Coding model: ${routing.codingModel}${currentConnection ? ` via ${currentConnection.label}` : ""}`
                : "Coding model — deployment default"
            }
            side="top"
          >
            <button
              type="button"
              id={idFor("model-button")}
              aria-haspopup="menu"
              aria-expanded={open === "model"}
              aria-label={`Model: ${routing.codingModel || "auto"}`}
              onClick={() => toggle("model")}
              className={pillClass}
            >
              <Cpu aria-hidden="true" className="w-3.5 h-3.5 shrink-0" />
              <span className={`${pillLabelClass} font-mono`}>
                {routing.codingModel ? modelTail(routing.codingModel) : "Auto"}
              </span>
              {chevron}
            </button>
          </Tooltip>
          <Popover
            kind="model"
            open={open === "model"}
            onClose={close}
            labelledBy={idFor("model-button")}
            className="right-0 w-72"
          >
            <div className="flex items-center gap-2 px-3 py-2 border-b border-[#e0ded5]">
              <Search aria-hidden="true" className="w-3.5 h-3.5 text-[#6a6f63]" />
              <input
                type="text"
                value={modelFilter}
                onChange={(event) => setModelFilter(event.target.value)}
                placeholder="Search models…"
                aria-label="Search models"
                className="flex-1 bg-transparent text-xs text-[#222320] placeholder-[#6a6f63]/60 focus:outline-none"
              />
            </div>
            <div className="max-h-64 overflow-y-auto py-1">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={routing.codingModel === ""}
                className={menuRowClass}
                onClick={() => {
                  routing.onCodingModelChange("");
                  setOpen(null);
                }}
              >
                <Cpu aria-hidden="true" className={menuIconClass} />
                <span className="flex-1">Auto — deployment default</span>
                {routing.codingModel === "" ? (
                  <Check aria-hidden="true" className={menuCheckClass} />
                ) : null}
              </button>
              {filteredModels.length > 0 ? (
                <>
                  <div className="mx-3 my-1 border-t border-[#e0ded5]" aria-hidden="true" />
                  {filteredModels.map((model) => (
                    <button
                      key={model}
                      type="button"
                      role="menuitemradio"
                      aria-checked={model === routing.codingModel}
                      className={`${menuRowClass} font-mono`}
                      onClick={() => {
                        routing.onCodingModelChange(model);
                        setOpen(null);
                      }}
                    >
                      <span className="flex-1 truncate text-left">{model}</span>
                      {model === routing.codingModel ? (
                        <Check aria-hidden="true" className={menuCheckClass} />
                      ) : null}
                    </button>
                  ))}
                </>
              ) : null}
              {connections.length > 0 ? (
                <>
                  <div className="mx-3 my-1 border-t border-[#e0ded5]" aria-hidden="true" />
                  <p className={`px-3.5 pt-1 pb-0.5 ${sectionLabelClass}`}>Route via</p>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={routing.connectionId === ""}
                    className={menuRowClass}
                    onClick={() => routing.onConnectionChange("")}
                  >
                    <span className="flex-1">Auto route</span>
                    {routing.connectionId === "" ? (
                      <Check aria-hidden="true" className={menuCheckClass} />
                    ) : null}
                  </button>
                  {connections.map((connection) => (
                    <button
                      key={connection.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={connection.id === routing.connectionId}
                      className={menuRowClass}
                      onClick={() => routing.onConnectionChange(connection.id)}
                    >
                      <span className="flex-1 truncate">{connection.label}</span>
                      {connection.id === routing.connectionId ? (
                        <Check aria-hidden="true" className={menuCheckClass} />
                      ) : null}
                    </button>
                  ))}
                </>
              ) : null}
            </div>
            <div className="border-t border-[#e0ded5] px-3 py-2.5 flex flex-col gap-2">
              <label htmlFor={idFor("model-input")} className={sectionLabelClass}>
                Custom model
              </label>
              <div className="flex items-center gap-1.5">
                <input
                  id={idFor("model-input")}
                  type="text"
                  value={modelDraft}
                  onChange={(event) => setModelDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && modelDraft.trim()) {
                      event.preventDefault();
                      applyCustomModel();
                    }
                  }}
                  placeholder="provider/model"
                  className={`${inputClass} flex-1 font-mono`}
                />
                <button
                  type="button"
                  disabled={!modelDraft.trim()}
                  onClick={applyCustomModel}
                  className="text-xs font-medium px-2 py-1.5 border border-[#e0ded5] text-[#6a6f63] hover:text-[#222320] hover:border-[#d3d2c8] rounded-none transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Use
                </button>
              </div>
              {!modelKnown ? (
                <p className="text-[10px] text-[#6a6f63]">
                  Current: <span className="font-mono">{routing.codingModel}</span> (custom)
                </p>
              ) : null}
            </div>
          </Popover>
        </div>

        {/* Run on — the deployment's real access boundary: the isolated
            container or, when a daemon is paired, this computer. */}
        {onRunTargetChange ? (
          <div className="relative">
            <Tooltip content="Where the run executes" side="top">
              <button
                type="button"
                id={idFor("access-button")}
                aria-haspopup="menu"
                aria-expanded={open === "access"}
                aria-label={`Run on: ${runTarget === "local" ? "this computer" : "sandbox"}`}
                onClick={() => toggle("access")}
                className={pillClass}
              >
                {runTarget === "local" ? (
                  <Laptop aria-hidden="true" className="w-3.5 h-3.5 shrink-0" />
                ) : (
                  <Container aria-hidden="true" className="w-3.5 h-3.5 shrink-0" />
                )}
                <span className={pillLabelClass}>
                  {runTarget === "local" ? "This computer" : "Sandbox"}
                </span>
                {chevron}
              </button>
            </Tooltip>
            <Popover
              kind="access"
              open={open === "access"}
              onClose={close}
              labelledBy={idFor("access-button")}
              className="right-0 w-64"
            >
              <div className="py-1">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={runTarget === "sandbox"}
                  className={menuRowClass}
                  onClick={() => {
                    onRunTargetChange("sandbox");
                    setOpen(null);
                  }}
                >
                  <Container aria-hidden="true" className={menuIconClass} />
                  <span className="flex-1 min-w-0">
                    <span className="block">Sandbox</span>
                    <span className="block text-[10px] text-[#6a6f63]">
                      Isolated container — approval-gated
                    </span>
                  </span>
                  {runTarget === "sandbox" ? (
                    <Check aria-hidden="true" className={menuCheckClass} />
                  ) : null}
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={runTarget === "local"}
                  disabled={!localRunAvailable}
                  className={`${menuRowClass} disabled:opacity-50 disabled:cursor-not-allowed`}
                  onClick={() => {
                    onRunTargetChange("local");
                    setOpen(null);
                  }}
                >
                  <Laptop aria-hidden="true" className={menuIconClass} />
                  <span className="flex-1 min-w-0">
                    <span className="block">This computer</span>
                    <span className="block text-[10px] text-[#6a6f63]">
                      {localRunAvailable
                        ? "Paired daemon runs the harness locally"
                        : "Pair a computer in Remote Access first"}
                    </span>
                  </span>
                  {runTarget === "local" ? (
                    <Check aria-hidden="true" className={menuCheckClass} />
                  ) : null}
                </button>
              </div>
            </Popover>
          </div>
        ) : null}

        {/* Send — Devin's arrow submit */}
        <Tooltip content="Submit task to coding agent" shortcut="⌘↵" side="top">
          <button
            type="submit"
            disabled={sendDisabled || isSubmitting}
            aria-label={isSubmitting ? "Sending…" : "Send task"}
            className="inline-flex items-center justify-center w-7 h-7 touch:min-h-11 touch:w-11 bg-[#0000a8] hover:bg-[#1c1cc8] text-white rounded-none transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-[2px_2px_0_var(--paper-shadow)] active:translate-y-px"
          >
            <ArrowUp aria-hidden="true" className="w-4 h-4" strokeWidth={2.5} />
          </button>
        </Tooltip>
      </div>

      <div className="flex items-center justify-between gap-3 pt-1 border-t border-black/[0.04]">
        <span className="min-w-0 text-[11px] text-[#6a6f63]/80 font-mono flex items-center gap-1">
          <span className="text-[#0000a8]/80">●</span>
          <span className="truncate">
            approval-gated ·{" "}
            {runTarget === "local" ? "runs on this computer" : "container isolated"}
            {publishPullRequest ? " · opens a PR" : ""}
          </span>
        </span>
        <Tooltip content="Clear task description and reset inputs" side="top">
          <button
            type="button"
            onClick={onClear}
            disabled={clearing || busy}
            className="text-[11px] text-[#6a6f63]/80 hover:text-[#222320] font-mono py-1 px-1.5 touch:min-h-11 rounded-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            {clearing ? "Clearing…" : "Clear"}
          </button>
        </Tooltip>
      </div>
    </form>
  );

  if (!hero) return form;

  const heroRepoSlug = repoSlug || "your repo";
  return (
    <div className="flex-1 min-h-0 overflow-y-auto flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-2xl flex flex-col items-center gap-6">
        <div className="text-center">
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-[#222320]">
            What should we build?
          </h1>
          <p className="mt-2 text-sm text-[#6a6f63]">
            Describe the task — your agent works in an isolated sandbox against{" "}
            <span className="font-mono text-xs">{heroRepoSlug}</span> and can open a PR when it's
            done.
          </p>
        </div>
        {form}
        <p className="text-[11px] text-[#6a6f63]/80 font-mono">
          approval-gated · container isolated · everything lands in Activity
        </p>
      </div>
    </div>
  );
}
