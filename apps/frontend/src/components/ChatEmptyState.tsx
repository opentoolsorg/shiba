import { type ComponentType, type JSX, type ReactNode } from "react";
import {
  AlertTriangle,
  BookOpen,
  FlaskConical,
  Sparkles,
  Zap,
} from "lucide-react";

export interface SuggestionChip {
  label: string;
  task: string;
  description?: string;
  icon?: ComponentType<{ className?: string; strokeWidth?: number; "aria-hidden"?: boolean | "true" }>;
}

export const SHIBA_STARTER_SUGGESTIONS: SuggestionChip[] = [
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

export function deriveFirstName(userName?: string | null): string | null {
  if (!userName || typeof userName !== "string") return null;
  const trimmed = userName.trim();
  if (
    !trimmed ||
    trimmed === "default" ||
    trimmed === "identity-pending" ||
    trimmed === "none"
  ) {
    return null;
  }
  const atIndex = trimmed.indexOf("@");
  const raw = atIndex > 0 ? trimmed.slice(0, atIndex) : trimmed;
  const parts = raw.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return null;
  const first = parts[0];
  if (!first) return null;
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

export interface ChatEmptyStateProps {
  userName?: string | null;
  launchBlocked?: boolean;
  setupDone?: number | null;
  setupTotal?: number;
  onOpenSetup?: () => void;
  onOpenProviders?: () => void;
  blockerNode?: ReactNode;
  onPick: (text: string) => void;
  suggestions?: SuggestionChip[];
  className?: string;
}

/**
 * ChatEmptyState — Centered blank-canvas greeting for the Chat view.
 *
 * - Serif greeting "Hi <FirstName>!" (derived from real identity; if unknown just "Hi!").
 * - Optional blocker card slot (setup or provider missing).
 * - Suggestion chips that prefill the composer with real Shiba starter tasks.
 */
export function ChatEmptyState({
  userName,
  launchBlocked = false,
  setupDone,
  setupTotal = 6,
  onOpenSetup,
  onOpenProviders,
  blockerNode,
  onPick,
  suggestions = SHIBA_STARTER_SUGGESTIONS,
  className = "",
}: ChatEmptyStateProps): JSX.Element {
  const firstName = deriveFirstName(userName);
  const greeting = firstName ? `Hi ${firstName}!` : "Hi!";

  return (
    <div
      className={`flex flex-col items-center justify-center min-h-[420px] h-full w-full px-4 py-8 text-center select-none ${className}`.trim()}
    >
      <div className="flex flex-col items-center max-w-xl w-full">
        {/* Serif greeting */}
        <h1 className="font-serif text-[34px] sm:text-[40px] font-normal tracking-tight text-[#0a0a0a] dark:text-zinc-100 mb-2">
          {greeting}
        </h1>
        <p className="text-[14px] text-[#71717a] dark:text-zinc-400 mb-6">
          What would you like to build or solve with Shiba today?
        </p>

        {/* Optional blocker card slot */}
        {blockerNode ? (
          <div className="w-full mb-6 text-left">{blockerNode}</div>
        ) : launchBlocked ? (
          <div
            role="alert"
            aria-label="Setup required"
            className="w-full mb-6 p-4 rounded-xl border border-amber-300 dark:border-amber-900/60 bg-amber-50/70 dark:bg-amber-950/20 text-left flex flex-col gap-2 shadow-sm"
          >
            <div className="flex items-center gap-2 text-amber-800 dark:text-amber-300">
              <AlertTriangle className="size-4 shrink-0" strokeWidth={2} />
              <span className="text-[13px] font-semibold">
                Setup required to launch tasks
              </span>
              {setupDone !== undefined && setupDone !== null ? (
                <span className="ml-auto text-[11px] font-mono font-medium px-2 py-0.5 rounded-full bg-amber-200/60 dark:bg-amber-900/40 text-amber-900 dark:text-amber-200">
                  Setup {setupDone}/{setupTotal}
                </span>
              ) : null}
            </div>
            <p className="text-[12px] text-amber-700 dark:text-amber-400/90 leading-relaxed">
              Configure an AI model provider or finish environment setup before starting tasks.
            </p>
            <div className="flex items-center gap-2 pt-1">
              {onOpenSetup ? (
                <button
                  type="button"
                  onClick={onOpenSetup}
                  className="h-7 px-3 rounded-lg text-[12px] font-medium bg-amber-800 text-white hover:bg-amber-900 dark:bg-amber-500 dark:text-zinc-950 dark:hover:bg-amber-400 transition-colors"
                >
                  Complete setup
                </button>
              ) : null}
              {onOpenProviders ? (
                <button
                  type="button"
                  onClick={onOpenProviders}
                  className="h-7 px-3 rounded-lg text-[12px] font-medium border border-amber-400/80 dark:border-amber-700/60 text-amber-800 dark:text-amber-300 hover:bg-amber-100/60 dark:hover:bg-amber-900/30 transition-colors"
                >
                  Configure providers
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Suggestion chips */}
        {suggestions.length > 0 ? (
          <div className="flex flex-col items-center gap-2.5 w-full">
            <span className="text-[11px] font-medium uppercase tracking-wider text-[#a1a1aa] dark:text-zinc-500">
              Suggestions
            </span>
            <div
              role="group"
              aria-label="Starter task suggestions"
              className="flex flex-wrap items-center justify-center gap-2 w-full"
            >
              {suggestions.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => onPick(item.task)}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-[#e4e4e7] dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:bg-[#f4f4f5] dark:hover:bg-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700 text-[13px] font-medium text-[#0a0a0a] dark:text-zinc-200 transition-colors shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400"
                  >
                    {Icon ? (
                      <Icon className="size-3.5 text-[#71717a] dark:text-zinc-400 shrink-0" strokeWidth={1.75} />
                    ) : null}
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
