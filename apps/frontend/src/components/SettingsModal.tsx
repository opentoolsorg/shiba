/**
 * SettingsModal — Kosuke-style settings popup: a grouped left nav
 * (YOUR ACCOUNT / WORKSPACE / FEATURES) beside a scrollable content pane that mounts
 * the REAL section bodies from SettingsView — no duplicated internals.
 * Closes on Esc, backdrop click, or the ✕ button.
 */
import { type JSX, useEffect, useId, useRef, useState } from "react";
import type { AppNavView } from "./AppNavRail";
import {
  SETTINGS_SECTION_LABELS,
  SettingsSectionBody,
  type SettingsSectionId,
} from "./SettingsView";

/** Settings sections plus direct links to real first-class feature views. */
const sectionItems = (...sections: SettingsSectionId[]) => sections.map((section) => ({ section }));

const SETTINGS_NAV_GROUPS: {
  heading: string;
  items: (
    | { section: SettingsSectionId }
    | { view: AppNavView; label: string; blurb: string; openSessions?: boolean }
  )[];
}[] = [
  { heading: "Your account", items: sectionItems("account", "appearance") },
  {
    heading: "Workspace",
    items: [
      { view: "providers", label: "AI providers", blurb: "Connect and manage provider accounts" },
      ...sectionItems("models", "repositories", "environments"),
    ],
  },
  {
    heading: "Features",
    items: [
      { section: "automations" },
      { section: "mailbox" },
      {
        view: "tasks",
        label: "Tasks & sessions",
        blurb: "Create tasks and return to live sessions",
        openSessions: true,
      },
      { view: "dashboard", label: "Dashboard", blurb: "Overview and at-a-glance stats" },
      { view: "memory", label: "Memory", blurb: "Long-term agent memory" },
    ],
  },
  {
    heading: "Deployment",
    items: [
      { view: "agents", label: "API keys & MCP", blurb: "Manage principals and tokens" },
      ...sectionItems("experimental", "deployment"),
    ],
  },
];

export interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Deep-link out of the modal into a full view (Agents & MCP, …). */
  onNavigate?: (view: AppNavView) => void;
  onOpenSessions?: () => void;
  onFocusRestore?: () => void;
  /** Better-auth sign-out; the Account section shows its button only with auth:"better-auth". */
  onSignOut?: () => Promise<void>;
  initialSection?: SettingsSectionId;
}

export function SettingsModal({
  isOpen,
  onClose,
  onNavigate,
  onOpenSessions,
  onFocusRestore,
  onSignOut,
  initialSection = "account",
}: SettingsModalProps): JSX.Element | null {
  const [section, setSection] = useState<SettingsSectionId>(initialSection);
  const titleId = useId();
  const descriptionId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onFocusRestoreRef = useRef(onFocusRestore);
  onFocusRestoreRef.current = onFocusRestore;
  const navigationId = useId();
  const contentId = useId();
  const wasOpenRef = useRef(false);

  // Reset the active section each time the modal opens; remember the
  // opening element so focus can return to it on close.
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      wasOpenRef.current = true;
      restoreFocusRef.current = document.activeElement as HTMLElement | null;
      setSection(initialSection);
      closeRef.current?.focus();
    } else if (!isOpen) {
      wasOpenRef.current = false;
    }
  }, [isOpen, initialSection]);

  // Esc closes; Tab is trapped inside the dialog (WAI-ARIA modal pattern).
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const items = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.getClientRects().length > 0);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const active = document.activeElement as HTMLElement | null;
      if (!root.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      const opener = restoreFocusRef.current;
      if (opener?.isConnected && opener !== document.body && opener !== document.documentElement) {
        opener.focus();
      } else {
        onFocusRestoreRef.current?.();
      }
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex overflow-y-auto p-3 sm:p-6">
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        className="absolute inset-0 size-full cursor-default bg-[var(--overlay)]"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="relative z-10 m-auto flex h-[82dvh] max-h-[780px] w-full max-w-4xl flex-col overflow-hidden rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] shadow-[var(--sh-overlay)]"
      >
        {/* Header — title + close, like Kosuke's dialog chrome. */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border-1)] bg-[var(--panel)] px-4 py-3">
          <div>
            <h2 id={titleId} className="text-base font-semibold text-[var(--fg)]">
              Settings
            </h2>
            <p id={descriptionId} className="text-[11px] text-[var(--muted-foreground-2)]">
              Deployment-aware settings and shortcuts to full feature experiences.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] font-mono text-sm text-[var(--muted-foreground-2)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--fg)] sm:size-8"
          >
            ✕
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          {/* Left nav — grouped sidebar on sm+, horizontal strip on phones. */}
          <nav
            aria-label="Settings navigation"
            className="flex shrink-0 gap-2 overflow-x-auto border-b border-[var(--border-1)] bg-[var(--bg)] px-2.5 py-2 sm:w-52 sm:flex-col sm:gap-0 sm:overflow-x-visible sm:overflow-y-auto sm:border-b-0 sm:border-r sm:py-3"
          >
            {SETTINGS_NAV_GROUPS.map((group) => (
              <fieldset
                key={group.heading}
                aria-labelledby={`${navigationId}-${group.heading}`}
                className="m-0 flex w-max shrink-0 gap-0.5 border-[var(--warning-fg)] p-0 sm:mb-3 sm:block sm:w-auto sm:last:mb-0"
              >
                <legend
                  id={`${navigationId}-${group.heading}`}
                  className="sr-only px-2.5 pb-1.5 text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground-2)] sm:not-sr-only"
                >
                  {group.heading}
                </legend>
                <div className="flex w-max gap-0.5 sm:w-auto sm:flex-col">
                  {group.items.map((item) => {
                    const isSection = "section" in item;
                    const sectionId = isSection ? item.section : undefined;
                    const entry = isSection ? SETTINGS_SECTION_LABELS[item.section] : item;
                    if (!isSection && !onNavigate) return null;
                    const isActive = Boolean(sectionId && section === sectionId);
                    const itemKey = sectionId ?? ("view" in item ? item.view : "");
                    return (
                      <button
                        key={itemKey}
                        type="button"
                        onClick={() => {
                          if (isSection) setSection(item.section);
                          else {
                            onNavigate?.(item.view);
                            if (item.openSessions) onOpenSessions?.();
                          }
                        }}
                        aria-current={isActive ? "page" : undefined}
                        aria-controls={isSection ? contentId : undefined}
                        className={
                          "min-h-11 shrink-0 rounded-[var(--radius-button)] px-2.5 py-2 text-left transition-colors duration-100 sm:w-full sm:shrink " +
                          (isActive
                            ? "bg-[var(--primary)] text-white shadow-[var(--sh-card)]"
                            : "text-[var(--fg)] hover:bg-[var(--secondary)]")
                        }
                      >
                        <span className="block whitespace-nowrap text-[13px] font-medium">
                          {entry.label}
                          {!isSection ? " ↗" : ""}
                        </span>
                        <span
                          className={
                            "mt-0.5 hidden truncate text-[10px] leading-snug sm:block " +
                            (isActive ? "text-white/80" : "text-[var(--muted-foreground-2)]")
                          }
                        >
                          {entry.blurb}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            ))}
          </nav>

          {/* Content pane — the real section bodies. */}
          <div
            id={contentId}
            aria-live="polite"
            key={section}
            className="min-w-0 flex-1 overflow-y-auto bg-[var(--bg)] p-4 sm:p-6"
          >
            <div className="mx-auto max-w-2xl">
              <SettingsSectionBody
                section={section}
                onNavigate={onNavigate}
                onSignOut={onSignOut}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
