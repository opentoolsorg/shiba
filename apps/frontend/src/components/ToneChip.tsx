/**
 * ToneChip — the small status pill shared by the Integrations / Settings /
 * Analytics surfaces. Same palette as AgentsView's CHIP_TONES (that map is
 * private to AgentsView; this is the reusable component form).
 */
import type { JSX } from "react";

const TONE_CLASSES = {
  ok: "border-[color-mix(in_oklch,var(--success)_30%,transparent)] bg-[color-mix(in_oklch,var(--success)_12%,transparent)] text-[var(--success)]",
  danger: "border-[color-mix(in_oklch,var(--destructive)_30%,transparent)] bg-[var(--destructive-soft)] text-[var(--destructive)]",
  pending: "border-[color-mix(in_oklch,var(--warning)_30%,transparent)] bg-[var(--warning-subtle)] text-[var(--warning-fg)]",
  navy: "border-[var(--primary)]/30 bg-[var(--primary-soft)] text-[var(--primary)]",
  neutral: "border-[var(--border-2)] bg-[var(--secondary)] text-[var(--muted-foreground-2)]",
} as const;

const TONE_DOTS = {
  ok: "bg-[var(--success)]",
  danger: "bg-[var(--destructive)]",
  pending: "bg-[var(--warning)]",
  navy: "bg-[var(--primary)]",
  neutral: "bg-[var(--muted-foreground-3)]",
} as const;

export type ChipTone = keyof typeof TONE_CLASSES;

export function ToneChip({ tone, label }: { tone: ChipTone; label: string }): JSX.Element {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-[var(--radius-button)] border px-2 py-0.5 text-[11px] font-medium ${TONE_CLASSES[tone]}`}
    >
      <span className={`size-1.5 rounded-full ${TONE_DOTS[tone]}`} />
      {label}
    </span>
  );
}
