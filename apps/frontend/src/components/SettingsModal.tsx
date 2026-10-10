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

/** Nav groups — Kosuke's YOUR ACCOUNT / WORKSPACE split over the real sections. */
const SETTINGS_NAV_GROUPS: { heading: string; sections: SettingsSectionId[] }[] = [
  { heading: "Your account", sections: ["account", "appearance"] },
  {
    heading: "Workspace",
    sections: ["providers", "models", "memory", "environments"],
  },
  { heading: "Features", sections: ["automations", "mailbox", "repositories"] },
  { heading: "Deployment", sections: ["guidance", "experimental", "deployment"] },
];

export interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Deep-link out of the modal into a full view (Agents & MCP, …). */
  onNavigate?: (view: AppNavView) => void;
  /** Better-auth sign-out; the Account section shows its button only with auth:"better-auth". */
  onSignOut?: () => void;
  initialSection?: SettingsSectionId;
}

export function SettingsModal({
  isOpen,
  onClose,
  onNavigate,
  onSignOut,
  initialSection = "account",
}: SettingsModalProps): JSX.Element | null {
  const [section, setSection] = useState<SettingsSectionId>(initialSection);
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // Reset the active section each time the modal opens; remember the
  // opening element so focus can return to it on close.
  useEffect(() => {
    if (isOpen) {
      restoreFocusRef.current = document.activeElement as HTMLElement | null;
      setSection(initialSection);
      closeRef.current?.focus();
    }
  }, [isOpen, initialSection]);

  // Esc closes; Tab is trapped inside the dialog (WAI-ARIA modal pattern).
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const items = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
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
      restoreFocusRef.current?.focus();
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex overflow-y-auto bg-black/60 p-3 sm:p-6"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="m-auto flex h-[82dvh] max-h-[780px] w-full max-w-4xl flex-col overflow-hidden rounded-none border border-[#e0ded5] bg-[#fffef8] shadow-[3px_3px_0_var(--paper-shadow)]"
      >
        {/* Header — title + close, like Kosuke's dialog chrome. */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#e0ded5] bg-[#f1efe6] px-4 py-3">
          <div>
            <h2 id={titleId} className="text-base font-semibold text-[#222320]">
              Settings
            </h2>
            <p className="text-[11px] text-[#6a6f63]">
              Deployment configuration and operator surfaces — live reads, not stubs.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="flex size-8 shrink-0 items-center justify-center rounded-none border border-[#e0ded5] bg-[#fffef8] font-mono text-sm text-[#6a6f63] transition-colors hover:bg-[#e0ded5] hover:text-[#222320]"
          >
            ✕
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          {/* Left nav — grouped sidebar on sm+, horizontal strip on phones. */}
          <nav
            aria-label="Settings sections"
            className="flex shrink-0 gap-2 overflow-x-auto border-b border-[#e0ded5] bg-[#f6f4ed] px-2.5 py-2 sm:w-52 sm:flex-col sm:gap-0 sm:overflow-x-visible sm:overflow-y-auto sm:border-b-0 sm:border-r sm:py-3"
          >
            {SETTINGS_NAV_GROUPS.map((group) => (
              <div key={group.heading} className="flex gap-0.5 sm:mb-3 sm:block sm:last:mb-0">
                <div className="hidden px-2.5 pb-1.5 text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[#6a6f63] sm:block">
                  {group.heading}
                </div>
                <div className="flex gap-0.5 sm:flex-col">
                  {group.sections.map((id) => {
                    const entry = SETTINGS_SECTION_LABELS[id];
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setSection(id)}
                        aria-current={section === id ? "location" : undefined}
                        className={
                          "shrink-0 rounded-none px-2.5 py-2 text-left transition-colors duration-100 sm:w-full sm:shrink " +
                          (section === id
                            ? "bg-[#0000a8] text-white shadow-[2px_2px_0_var(--paper-shadow)]"
                            : "text-[#222320] hover:bg-[#e0ded5]")
                        }
                      >
                        <span className="block whitespace-nowrap text-[13px] font-medium">
                          {entry.label}
                        </span>
                        <span
                          className={
                            "mt-0.5 hidden truncate text-[10px] leading-snug sm:block " +
                            (section === id ? "text-white/80" : "text-[#6a6f63]")
                          }
                        >
                          {entry.blurb}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>

          {/* Content pane — the real section bodies. */}
          <div className="min-w-0 flex-1 overflow-y-auto bg-[#f6f4ed] p-4 sm:p-6">
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
