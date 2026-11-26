import { useEffect, useId, useRef, useState, type JSX } from "react";
import {
  AGENT_AVATAR_COATS,
  AGENT_AVATAR_VARIANTS,
  avatarLook,
  avatarVariant,
  normalizeAgentAvatar,
  shuffledAvatar,
  type AgentAvatarChoice,
  type AgentAvatarCoat,
} from "@shiba/shared";
import { AgentMascot } from "./AgentMascot";

const ACC_LABEL: Record<string, string> = {
  none: "No glyph", pen: "Pen", wrench: "Wrench", coffee: "Cup", loupe: "Loupe", megaphone: "Megaphone",
  clipboard: "Clipboard", compass: "Compass", headset: "Headset", chart: "Chart", list: "List", bag: "Bag", check: "Check",
};

function luminance(color: string): number {
  const value = Number.parseInt(color.slice(1), 16);
  const channel = (raw: number) => {
    const unit = raw / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((value >> 16) & 255) + 0.7152 * channel((value >> 8) & 255) + 0.0722 * channel(value & 255);
}

const contrast = (a: string, b: string) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
};

/** Readable text on a coat: whichever of the ink and paper colours contrasts more. */
export function textOnCoat(color: string): string {
  return contrast(color, "#222320") >= contrast(color, "#fafafa") ? "#222320" : "#fafafa";
}

function deepen(color: string, amount: number): string {
  const value = Number.parseInt(color.slice(1), 16);
  const channel = (raw: number) => Math.round(raw * (1 - amount)).toString(16).padStart(2, "0");
  return `#${channel((value >> 16) & 255)}${channel((value >> 8) & 255)}${channel(value & 255)}`;
}

/**
 * The name pill's tone: the coat itself when its text clears 4.5:1, otherwise
 * the same hue deepened just enough. A mid-tone coat such as dusk cannot carry
 * 12px text at any text colour, and a washed-out pill would hide the name.
 */
export function pillTone(color: string): { background: string; color: string } {
  for (let step = 0; step <= 10; step += 1) {
    const background = deepen(color, step * 0.06);
    const text = textOnCoat(background);
    if (contrast(background, text) >= 4.5) return { background, color: text };
  }
  return { background: "#222320", color: "#fafafa" };
}

const TABS = [
  { id: "shapes", label: "Shapes" },
  { id: "icons", label: "Icons" },
  { id: "upload", label: "Upload" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const FOCUS_RING = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]";
const QUIET = `inline-flex min-h-11 items-center justify-center border border-[var(--border-1)] bg-[var(--card)] px-3 text-xs font-medium text-[var(--fg)] hover:bg-[var(--secondary)] disabled:opacity-40 ${FOCUS_RING}`;
const PRIMARY = `inline-flex min-h-11 items-center justify-center bg-[var(--primary)] px-3.5 text-xs font-semibold text-[var(--primary-text)] hover:bg-[var(--primary-soft-hover)] disabled:opacity-40 ${FOCUS_RING}`;

export interface BotAvatarEditorProps {
  name: string;
  current?: AgentAvatarChoice;
  /** True while the parent is saving; the controls lock. */
  busy?: boolean;
  error?: string | null;
  onSave: (choice: AgentAvatarChoice) => void;
  onCancel: () => void;
}

/**
 * Bot avatar editor: gallery, glyphs, coats, shuffle and a live preview. The
 * avatar itself is parameterised SVG, so every choice is a variant id and a
 * coat — no image files, no uploaded markup.
 */
export function BotAvatarEditor({ name, current, busy = false, error = null, onSave, onCancel }: BotAvatarEditorProps): JSX.Element {
  const base = useId();
  const [draft, setDraft] = useState<AgentAvatarChoice>(() => normalizeAgentAvatar(current) ?? { kind: "variant", variant: "classic", color: "#c4a574" });
  const [tab, setTab] = useState<TabId>("shapes");
  const [shuffleSeed, setShuffleSeed] = useState(0);
  const firstControl = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    firstControl.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.stopPropagation();
        onCancel();
        return;
      }
      // aria-modal promises a trap, so Tab cycles inside the dialog and never
      // wanders into the page behind it.
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((node) => node.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      // Focus may also be on the page behind the dialog; the trap pulls it back
      // in rather than letting Tab walk on from wherever it happens to be.
      if (!active || !dialog.current.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  const variantChoice = draft.kind === "variant" ? draft : undefined;
  const look = avatarLook(variantChoice);
  const preview = look ?? avatarLook({ kind: "variant", variant: "classic", color: "#c4a574" })!;
  const coat = variantChoice?.color ?? "#c4a574";
  const pill = pillTone(coat);
  const iconVariants = AGENT_AVATAR_VARIANTS.filter((variant) => variant.acc !== "none");

  const pickVariant = (id: string) => setDraft({ kind: "variant", variant: id as AgentAvatarCoat extends never ? never : (typeof AGENT_AVATAR_VARIANTS)[number]["id"], color: coat });
  const pickCoat = (color: AgentAvatarCoat) => setDraft({ kind: "variant", variant: variantChoice?.variant ?? "classic", color });

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[var(--overlay)] p-0 sm:items-center sm:p-6" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${base}-title`}
        className="flex max-h-[92dvh] w-full max-w-lg flex-col overflow-y-auto border border-[var(--border-1)] bg-[var(--card)] text-[var(--fg)] shadow-[var(--sh-sheet)] transition-none"
      >
        <header className="flex items-start justify-between gap-3 border-b border-[var(--border-1)] px-4 py-3">
          <div className="min-w-0">
            <h2 id={`${base}-title`} className="text-balance text-[15px] font-semibold leading-tight">Edit avatar</h2>
            <p className="mt-1 text-pretty text-[11px] leading-snug text-[var(--muted-foreground-2)] [overflow-wrap:anywhere]">Choose how {name || "this bot"} looks everywhere it appears.</p>
          </div>
          <button ref={firstControl} type="button" className={QUIET} onClick={onCancel} disabled={busy}>Cancel</button>
        </header>

        <div className="flex flex-col gap-4 px-4 py-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
            <div className="size-16 shrink-0">
              <AgentMascot look={preview} expression={preview.eyes} label={`${name || "Bot"} avatar preview`} />
            </div>
            <div className="min-w-0 flex-1">
              <span className="inline-flex max-w-full items-center px-3 py-1.5 text-xs font-semibold" style={{ background: pill.background, color: pill.color }}>
                <span className="truncate">{name || "Untitled bot"}</span>
              </span>
              <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted-foreground-2)]">
                {variantChoice ? ACC_LABEL[avatarVariant(variantChoice.variant)?.acc ?? "none"] ?? "Mark" : "Uploaded portrait"}
                {" · "}
                {AGENT_AVATAR_COATS.indexOf(coat as AgentAvatarCoat) >= 0 ? `Coat ${AGENT_AVATAR_COATS.indexOf(coat as AgentAvatarCoat) + 1} of ${AGENT_AVATAR_COATS.length}` : "Custom colour"}
              </p>
            </div>
          </div>

          <div role="tablist" aria-label="Avatar sources" className="flex gap-1 border-b border-[var(--border-1)] pb-1">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={tab === entry.id}
                aria-controls={`${base}-${entry.id}`}
                className={`min-h-11 px-3 text-xs font-medium ${tab === entry.id ? "bg-[var(--secondary)] text-[var(--fg)]" : "text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--secondary)]/60"} ${FOCUS_RING}`}
                onClick={() => setTab(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>

          {tab === "shapes" ? (
            <div id={`${base}-shapes`} role="tabpanel" aria-label="Shapes" className="grid grid-cols-4 gap-2 sm:grid-cols-6">
              {AGENT_AVATAR_VARIANTS.map((variant) => {
                const selected = variantChoice?.variant === variant.id;
                return (
                  <button
                    key={variant.id}
                    type="button"
                    aria-pressed={selected}
                    title={variant.label}
                    onClick={() => pickVariant(variant.id)}
                    className={`flex min-h-11 items-center justify-center border p-1 ${selected ? "border-[var(--primary)] bg-[var(--secondary)]" : "border-[var(--border-1)] bg-[var(--card)] hover:bg-[var(--secondary)]"} ${FOCUS_RING}`}
                  >
                    <span className="flex size-9 items-center justify-center">
                      <AgentMascot look={{ shape: variant.shape, color: coat, eyes: variant.eyes, acc: variant.acc }} live={false} />
                    </span>
                    <span className="sr-only">{variant.label}</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {tab === "icons" ? (
            <div id={`${base}-icons`} role="tabpanel" aria-label="Icons" className="grid grid-cols-4 gap-2 sm:grid-cols-6">
              {iconVariants.map((variant) => {
                const selected = variantChoice?.variant === variant.id;
                return (
                  <button
                    key={variant.id}
                    type="button"
                    aria-pressed={selected}
                    title={`${ACC_LABEL[variant.acc] ?? variant.label} glyph`}
                    onClick={() => pickVariant(variant.id)}
                    className={`flex min-h-11 flex-col items-center justify-center gap-1 border p-1 ${selected ? "border-[var(--primary)] bg-[var(--secondary)]" : "border-[var(--border-1)] bg-[var(--card)] hover:bg-[var(--secondary)]"} ${FOCUS_RING}`}
                  >
                    <span className="flex size-7 items-center justify-center" style={{ background: coat }}>
                      <AgentMascot look={{ shape: variant.shape, color: coat, eyes: variant.eyes, acc: variant.acc }} live={false} />
                    </span>
                    <span className="text-[9px] text-[var(--muted-foreground-2)]">{ACC_LABEL[variant.acc]}</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {tab === "upload" ? (
            <div id={`${base}-upload`} role="tabpanel" aria-label="Upload" className="border border-dashed border-[var(--border-1)] px-3 py-4 text-[11px] leading-relaxed text-[var(--muted-foreground-2)]">
              <p className="font-medium text-[var(--fg)]">Uploaded portraits are not available yet.</p>
              <p className="mt-1">A portrait has to be re-encoded and checked before a bot can wear it, and that service is not switched on in this workspace. Use a shape and coat instead — they render everywhere without a network request.</p>
            </div>
          ) : null}

          <div>
            <p className="mb-1.5 text-[11px] font-medium text-[var(--muted-foreground-2)]">Coat</p>
            <div role="group" aria-label="Coat" className="flex flex-wrap gap-1.5">
              {AGENT_AVATAR_COATS.map((color, index) => {
                const selected = coat === color;
                return (
                  <button
                    key={color}
                    type="button"
                    aria-pressed={selected}
                    aria-label={`Coat ${index + 1}`}
                    onClick={() => pickCoat(color)}
                    className={`flex size-11 items-center justify-center border ${selected ? "border-[var(--primary)] bg-[var(--secondary)]" : "border-transparent hover:border-[var(--border-1)]"} ${FOCUS_RING}`}
                  >
                    <span className="size-[26px] border border-[var(--border-1)]" style={{ background: color }} />
                  </button>
                );
              })}
            </div>
          </div>

          {error ? <p role="alert" className="text-[11px] text-[var(--destructive)]">{error}</p> : null}
        </div>

        <footer className="sticky bottom-0 flex items-center justify-between gap-2 border-t border-[var(--border-1)] bg-[var(--card)] px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            className={QUIET}
            disabled={busy}
            onClick={() => {
              const seed = `${shuffleSeed}-${name}`;
              setShuffleSeed((value) => value + 1);
              setDraft(shuffledAvatar(seed, draft));
            }}
          >
            Shuffle
          </button>
          <div className="flex items-center gap-2">
            <button type="button" className={QUIET} disabled={busy} onClick={onCancel}>Cancel</button>
            <button type="button" className={PRIMARY} disabled={busy} onClick={() => onSave(draft)}>{busy ? "Saving…" : "Save avatar"}</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
