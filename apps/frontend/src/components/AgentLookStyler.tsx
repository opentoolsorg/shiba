import type { JSX } from "react";
import {
  AGENT_MASCOT_ACCS,
  AGENT_MASCOT_EYES,
  AGENT_MASCOT_FURS,
  AGENT_MASCOT_SHAPES,
  resolveAgentMascotLook,
  type AgentMascotAcc,
  type AgentMascotEyes,
  type AgentMascotLook,
  type AgentMascotShape,
  type CustomAgentMascotPreset,
} from "@shiba/shared";
import type { EmployeeRole } from "../employee-templates";
import { AgentMascot } from "./AgentMascot";

const chip = "inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded border px-2.5 text-xs text-[var(--fg)] focus-within:outline focus-within:outline-2 focus-within:outline-[var(--ring)]";

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function AgentLookStyler({ id, role, preset, shape, color, eyes, acc, onCustomize, onAutomatic }: {
  id: string;
  role?: EmployeeRole;
  preset?: CustomAgentMascotPreset;
  shape: string;
  color: string;
  eyes: string;
  acc: string;
  onCustomize: (look: AgentMascotLook) => void;
  onAutomatic: () => void;
}): JSX.Element {
  const custom = Boolean(shape || color || eyes || acc);
  const preview = resolveAgentMascotLook({
    id,
    role,
    preset: custom ? undefined : preset,
    look: custom ? { shape, color, eyes, acc } : undefined,
  });
  const pick = (patch: Partial<AgentMascotLook>) => onCustomize({ ...preview, ...patch });
  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 text-xs font-medium text-[var(--fg)]">Shiba mascot</legend>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex shrink-0 flex-col items-center gap-1">
          <span className="inline-flex size-24">
            <AgentMascot look={preview} live />
          </span>
          <p className="text-[11px] text-[var(--muted-foreground-2)]">{custom ? "Custom face" : "Automatic face"}</p>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <label className={`${chip} w-fit ${custom ? "border-[var(--border-1)] bg-[var(--panel)]" : "border-[var(--primary)] bg-[var(--secondary)]"}`}>
            <input type="radio" name="mascot-mode" value="" checked={!custom} onChange={onAutomatic} className="accent-[var(--primary)]" />
            Automatic
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">Shape</span>
            <div className="flex flex-wrap gap-1.5">
              {AGENT_MASCOT_SHAPES.map((option) => (
                <label key={option} className={`${chip} ${custom && preview.shape === option ? "border-[var(--primary)] bg-[var(--secondary)]" : "border-[var(--border-1)] bg-[var(--panel)]"}`}>
                  <input type="radio" name="mascot-shape" value={option} checked={custom && shape === option} onChange={() => pick({ shape: option as AgentMascotShape })} className="accent-[var(--primary)]" />
                  {titleCase(option)}
                </label>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">Fur</span>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Fur">
              {AGENT_MASCOT_FURS.map((fur) => (
                <label key={fur.id} className={`inline-flex size-11 cursor-pointer items-center justify-center rounded border ${custom && preview.color === fur.hex ? "border-[var(--primary)]" : "border-[var(--border-1)]"}`} title={fur.label}>
                  <input type="radio" name="mascot-fur" value={fur.hex} checked={custom && color === fur.hex} aria-label={fur.label} onChange={() => pick({ color: fur.hex })} className="sr-only" />
                  <span className="size-6 rounded-sm border border-black/10" style={{ background: fur.hex }} />
                </label>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">Eyes</span>
            <div className="flex flex-wrap gap-1.5">
              {AGENT_MASCOT_EYES.map((option) => (
                <label key={option} className={`${chip} ${custom && preview.eyes === option ? "border-[var(--primary)] bg-[var(--secondary)]" : "border-[var(--border-1)] bg-[var(--panel)]"}`}>
                  <input type="radio" name="mascot-eyes" value={option} checked={custom && eyes === option} onChange={() => pick({ eyes: option as AgentMascotEyes })} className="accent-[var(--primary)]" />
                  {titleCase(option)}
                </label>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">Accessory</span>
            <div className="flex flex-wrap gap-1.5">
              {AGENT_MASCOT_ACCS.map((option) => (
                <label key={option} className={`${chip} ${custom && preview.acc === option ? "border-[var(--primary)] bg-[var(--secondary)]" : "border-[var(--border-1)] bg-[var(--panel)]"}`}>
                  <input type="radio" name="mascot-acc" value={option} checked={custom && acc === option} onChange={() => pick({ acc: option as AgentMascotAcc })} className="accent-[var(--primary)]" />
                  {titleCase(option)}
                </label>
              ))}
            </div>
          </div>
        </div>
      </div>
    </fieldset>
  );
}
