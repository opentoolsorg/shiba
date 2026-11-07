import type { JSX, ReactNode } from "react";
import { Shuffle } from "lucide-react";
import {
  AGENT_MASCOT_ACCS,
  AGENT_MASCOT_EYES,
  AGENT_MASCOT_FURS,
  AGENT_MASCOT_SHAPES,
  AGENT_MASCOT_STARTER_LOOKS,
  randomMascotLook,
  resolveAgentMascotLook,
  type AgentMascotAcc,
  type AgentMascotEyes,
  type AgentMascotLook,
  type AgentMascotShape,
  type CustomAgentMascotPreset,
} from "@shiba/shared";
import type { EmployeeRole } from "../employee-templates";
import { AgentMascot } from "./AgentMascot";

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function LookTile({ label, selected, onPick, children }: {
  label: string;
  selected: boolean;
  onPick: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      title={label}
      onClick={onPick}
      className={`inline-flex size-12 shrink-0 cursor-pointer items-center justify-center rounded border p-1 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)] ${
        selected ? "border-[var(--primary)] bg-[var(--secondary)]" : "border-[var(--border-1)] bg-[var(--panel)] hover:border-[var(--border-2)]"
      }`}
    >
      {children}
    </button>
  );
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
  const base = { color: preview.color, eyes: preview.eyes, acc: preview.acc };

  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 text-xs font-medium text-[var(--fg)]">Avatar</legend>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex shrink-0 flex-col items-center gap-2">
          <span className="inline-flex size-28 rounded-lg border border-[var(--border-1)] bg-[var(--panel)] p-2">
            <AgentMascot look={preview} live />
          </span>
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            <button
              type="button"
              className={`min-h-11 rounded border px-2.5 text-xs ${custom ? "border-[var(--border-1)] bg-[var(--panel)]" : "border-[var(--primary)] bg-[var(--secondary)]"}`}
              onClick={onAutomatic}
            >
              Automatic
            </button>
            <button
              type="button"
              className="inline-flex min-h-11 items-center gap-1 rounded border border-[var(--border-1)] bg-[var(--panel)] px-2.5 text-xs hover:border-[var(--border-2)]"
              onClick={() => onCustomize(randomMascotLook())}
            >
              <Shuffle className="size-3.5 shrink-0 opacity-80" aria-hidden />
              Shuffle
            </button>
          </div>
          <p className="text-center text-[11px] text-[var(--muted-foreground-2)]">
            {custom ? "Custom avatar" : "Matched to name and role"}
          </p>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">Starters</span>
            <div className="flex flex-wrap gap-1.5">
              {AGENT_MASCOT_STARTER_LOOKS.map((starter) => {
                const active = custom
                  && preview.shape === starter.look.shape
                  && preview.color === starter.look.color
                  && preview.eyes === starter.look.eyes
                  && preview.acc === starter.look.acc;
                return (
                  <LookTile key={starter.id} label={starter.label} selected={active} onPick={() => onCustomize(starter.look)}>
                    <span className="inline-flex size-10">
                      <AgentMascot look={starter.look} />
                    </span>
                  </LookTile>
                );
              })}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">Shape</span>
            <div className="flex flex-wrap gap-1.5">
              {AGENT_MASCOT_SHAPES.map((option) => (
                <LookTile
                  key={option}
                  label={titleCase(option)}
                  selected={custom && preview.shape === option}
                  onPick={() => pick({ shape: option as AgentMascotShape })}
                >
                  <span className="inline-flex size-10">
                    <AgentMascot look={{ ...base, shape: option }} />
                  </span>
                </LookTile>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">Color</span>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Fur color">
              {AGENT_MASCOT_FURS.map((fur) => (
                <button
                  key={fur.id}
                  type="button"
                  role="radio"
                  aria-checked={custom && preview.color === fur.hex}
                  aria-label={fur.label}
                  title={fur.label}
                  onClick={() => pick({ color: fur.hex })}
                  className={`inline-flex size-11 cursor-pointer items-center justify-center rounded border focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)] ${
                    custom && preview.color === fur.hex ? "border-[var(--primary)]" : "border-[var(--border-1)]"
                  }`}
                >
                  <span className="size-6 rounded-sm border border-black/10" style={{ background: fur.hex }} />
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">Expression</span>
            <div className="flex flex-wrap gap-1.5">
              {AGENT_MASCOT_EYES.map((option) => (
                <LookTile
                  key={option}
                  label={titleCase(option)}
                  selected={custom && preview.eyes === option}
                  onPick={() => pick({ eyes: option as AgentMascotEyes })}
                >
                  <span className="inline-flex size-10">
                    <AgentMascot look={{ ...base, shape: preview.shape, eyes: option }} />
                  </span>
                </LookTile>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">Accessory</span>
            <div className="flex flex-wrap gap-1.5">
              {AGENT_MASCOT_ACCS.map((option) => (
                <LookTile
                  key={option}
                  label={titleCase(option)}
                  selected={custom && preview.acc === option}
                  onPick={() => pick({ acc: option as AgentMascotAcc })}
                >
                  <span className="inline-flex size-10">
                    <AgentMascot look={{ ...base, shape: preview.shape, acc: option }} />
                  </span>
                </LookTile>
              ))}
            </div>
          </div>
        </div>
      </div>
    </fieldset>
  );
}
