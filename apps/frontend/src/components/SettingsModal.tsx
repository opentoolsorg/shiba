/**
 * SettingsModal — Thin modal wrapper around SettingsPage.
 * Closes on Esc, backdrop click, or the ✕ button.
 * Kept exported so existing callers continue working before full rewiring.
 */
import { type JSX, useEffect, useRef, useState } from "react";
import type { AppNavView } from "./AppNavRail";
import type { SettingsSectionId } from "./settings-sections";
import { SettingsPage, SettingsPanel, type SettingsPageSectionId } from "./SettingsPage";

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
  /** Reports section switches so the app can reopen where the user left off. */
  onSectionChange?: (section: SettingsSectionId) => void;
}

export function SettingsModal({
  isOpen,
  onClose,
  onNavigate,
  onOpenSessions,
  onFocusRestore,
  onSignOut,
  initialSection = "account",
  onSectionChange,
}: SettingsModalProps): JSX.Element | null {
  const [section, setSection] = useState<SettingsPageSectionId>(initialSection);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onFocusRestoreRef = useRef(onFocusRestore);
  onFocusRestoreRef.current = onFocusRestore;
  const wasOpenRef = useRef(false);

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

  const handleSectionSelect = (nextSection: string) => {
    setSection(nextSection as SettingsPageSectionId);
    if (nextSection !== "team" && nextSection !== "remote") {
      onSectionChange?.(nextSection as SettingsSectionId);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/40 backdrop-blur-xs">
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        className="absolute inset-0 size-full cursor-default bg-transparent"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="relative z-10 flex h-[85dvh] max-h-[820px] w-full max-w-5xl overflow-hidden rounded-xl border border-[#e4e4e7] dark:border-zinc-800 bg-[#f4f4f5]/80 dark:bg-[#0c0c0e] shadow-2xl animate-enter gap-2 p-2"
      >
        <SettingsPanel
          active={section}
          onSelect={handleSectionSelect}
          onBack={onClose}
        />
        <div className="flex-1 min-w-0 h-full flex flex-col">
          <SettingsPage
            section={section}
            onSectionChange={handleSectionSelect}
            onBack={onClose}
            onNavigate={onNavigate}
            onOpenSessions={onOpenSessions}
            onFocusRestore={onFocusRestore}
            onSignOut={onSignOut}
          />
        </div>
      </div>
    </div>
  );
}
