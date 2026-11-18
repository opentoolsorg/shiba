import { useId, useRef, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

export const QUIET_BUTTON =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg px-2 text-[var(--muted-foreground-2)] hover:bg-[var(--secondary)] hover:text-[var(--fg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]";

export const FIELD_CLASS =
  "min-h-9 w-full border border-[var(--border-1)] bg-[var(--card)] px-2 text-xs text-[var(--fg)] placeholder:text-[var(--muted-foreground-2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]";

/**
 * One settings row that expands in place, like the profile drawer it mirrors.
 * A real button with aria-expanded/aria-controls so Tab, Enter and Space behave,
 * and the summary stays readable when collapsed.
 */
export function Disclosure({ label, summary, id, open, onOpenChange, children }: {
  label: string;
  summary?: string;
  id?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const generated = useId();
  const panelId = `bot-disclosure-${id ?? generated}`;
  return (
    <div className="border-b border-[var(--border-1)] last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => onOpenChange(!open)}
        className="group flex min-h-11 w-full items-center gap-3 rounded-lg px-1 py-2 text-left text-sm hover:bg-[var(--secondary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
      >
        <span className="shrink-0">{label}</span>
        {summary && !open ? (
          <span className="ml-auto min-w-0 flex-1 truncate text-right text-[11px] text-[var(--muted-foreground-2)]">{summary}</span>
        ) : null}
        <ChevronRight
          aria-hidden="true"
          className={`ml-auto size-3.5 shrink-0 text-[var(--icon-muted)] motion-safe:transition-transform motion-safe:duration-150 ${open ? "rotate-90" : ""}`}
        />
      </button>
      <div id={panelId} hidden={!open} className="pb-4">
        {children}
      </div>
    </div>
  );
}

export type BotPanelTab = "details" | "library" | "computer";

export const BOT_TABS: readonly { id: BotPanelTab; label: string }[] = [
  { id: "details", label: "Details" },
  { id: "library", label: "Library" },
  { id: "computer", label: "Computer" },
];

/** Segmented tab strip: one control, three targets, arrow-key roving focus. */
export function BotTabList({ active, onChange }: { active: BotPanelTab; onChange: (tab: BotPanelTab) => void }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (delta: number) => {
    const index = BOT_TABS.findIndex((tab) => tab.id === active);
    const nextIndex = (index + delta + BOT_TABS.length) % BOT_TABS.length;
    const next = BOT_TABS[nextIndex];
    if (!next) return;
    onChange(next.id);
    refs.current[nextIndex]?.focus();
  };
  return (
    <div role="tablist" aria-label="Agent details tabs" className="flex gap-1 border-b border-[var(--border-1)] pb-2">
      {BOT_TABS.map((tab, index) => {
        const selected = active === tab.id;
        return (
          <button
            key={tab.id}
            ref={(element) => { refs.current[index] = element; }}
            type="button"
            role="tab"
            id={`agent-tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`agent-panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") { event.preventDefault(); move(1); }
              if (event.key === "ArrowLeft") { event.preventDefault(); move(-1); }
              if (event.key === "Home") { event.preventDefault(); onChange("details"); refs.current[0]?.focus(); }
              if (event.key === "End") { event.preventDefault(); onChange("computer"); refs.current[2]?.focus(); }
            }}
            className={`min-h-9 flex-1 rounded-md px-2 text-[13px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] ${
              selected
                ? "bg-[var(--card)] text-[var(--fg)] shadow-[inset_0_0_0_1px_var(--border-1)]"
                : "text-[var(--muted-foreground-2)] hover:bg-[var(--secondary)] hover:text-[var(--fg)]"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

export type BotNoticeTone = "ok" | "err" | "busy";

/** One status line per panel action, announced rather than only coloured. */
export function BotNotice({ notice }: { notice: { tone: BotNoticeTone; text: string } | null }) {
  if (!notice) return null;
  return (
    <p
      role={notice.tone === "err" ? "alert" : "status"}
      className={`px-1 text-[11px] leading-relaxed ${notice.tone === "err" ? "text-[var(--destructive)]" : "text-[var(--muted-foreground-2)]"}`}
    >
      {notice.text}
    </p>
  );
}

/** A load or empty state that says which one it is, so an empty list is never a mystery. */
export function BotSectionState({ tone = "info", children, retry }: { tone?: "info" | "error"; children: ReactNode; retry?: () => void }) {
  return (
    <div className={`flex flex-wrap items-center gap-2 border border-dashed border-[var(--border-1)] px-3 py-4 text-[11px] ${tone === "error" ? "text-[var(--destructive)]" : "text-[var(--muted-foreground-2)]"}`}>
      <p role={tone === "error" ? "alert" : "status"} className="min-w-0 flex-1">{children}</p>
      {retry ? <button type="button" onClick={retry} className="underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]">Retry</button> : null}
    </div>
  );
}

export const formatBytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
