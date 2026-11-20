import { useEffect, useId, useState, type ReactNode } from "react";
import { Check, ExternalLink } from "lucide-react";
import { BotNotice, Disclosure, FIELD_CLASS, QUIET_BUTTON } from "./BotPanel";
import { BOT_TOOL_STATE_LABEL, type BotToolRow } from "../../bot-tools";

export interface BotModelOption {
  id: string;
  label: string;
}

export interface BotModelEdit {
  value: string;
  options: readonly BotModelOption[];
  busy: boolean;
  onChange: (value: string) => void;
}

export interface BotDetailsTabProps {
  editing: boolean;
  modelEdit: BotModelEdit | null;
  instructions: string;
  instructionsSaved: string;
  onInstructionsChange: (value: string) => void;
  onInstructionsSave: () => void;
  notice: { tone: "ok" | "err" | "busy"; text: string } | null;
  saveBusy: boolean;
  toolsRows: readonly BotToolRow[];
  toolsLoading: boolean;
  toolsError: string | null;
  onManageTools?: () => void;
  advanced: readonly { label: string; value: string }[];
  /** Bumped by the hero so "edit description" opens the one instructions field. */
  openInstructionsSignal: number;
}

const STATE_TONE: Record<BotToolRow["state"], string> = {
  on: "border-[var(--border-1)] bg-[var(--secondary)] text-[var(--fg)]",
  off: "border-[var(--border-1)] text-[var(--fg)]",
  ungranted: "border-[var(--border-1)] text-[var(--muted-foreground-2)]",
  workspace: "border-[var(--border-1)] text-[var(--muted-foreground-2)]",
  unavailable: "border-[var(--border-1)] text-[var(--muted-foreground-2)]",
  unknown: "border-[var(--border-1)] text-[var(--muted-foreground-2)]",
};

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="shrink-0 text-[11px] text-[var(--muted-foreground-2)]">{label}</dt>
      <dd className="min-w-0 break-words text-right font-mono text-[11px] text-[var(--fg)]">{value}</dd>
    </div>
  );
}

export function BotToolsList({ rows, onManageTools }: { rows: readonly BotToolRow[]; onManageTools?: () => void }) {
  return (
    <div className="flex flex-col gap-2">
      <ul aria-label="Bot tools" className="divide-y divide-[var(--border-1)] rounded-md border border-[var(--border-1)] bg-[var(--card)]">
        {rows.map((row) => (
          <li key={row.id} className="flex items-start gap-2 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-[var(--fg)]">{row.label}</p>
              <p className="mt-0.5 break-words text-[11px] leading-relaxed text-[var(--muted-foreground-2)]">{row.detail}</p>
            </div>
            <span className={`shrink-0 border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${STATE_TONE[row.state]}`}>
              {BOT_TOOL_STATE_LABEL[row.state]}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-[11px] leading-relaxed text-[var(--muted-foreground-2)]">
        Switching a bot capability on or off is a grant change, and this panel cannot make one: a profile save refuses
        per-bot tool scopes. Employee tool policy is where a capability is bound to an exact app connection, mailbox or
        repository for this bot version.
      </p>
      {onManageTools ? (
        <button type="button" onClick={onManageTools} className={`${QUIET_BUTTON} min-h-9 w-fit gap-1.5 px-2 text-[11px]`}>
          <ExternalLink aria-hidden="true" className="size-3.5" />Open Employee tool policy
        </button>
      ) : null}
    </div>
  );
}

export function BotDetailsTab(props: BotDetailsTabProps) {
  const { editing, modelEdit, instructions, instructionsSaved, onInstructionsChange, onInstructionsSave, notice, saveBusy, toolsRows, toolsLoading, toolsError, onManageTools, advanced, openInstructionsSignal } = props;
  const generated = useId();
  const [openRow, setOpenRow] = useState<string | null>(null);
  useEffect(() => {
    if (openInstructionsSignal > 0) setOpenRow("instructions");
  }, [openInstructionsSignal]);
  const toggle = (id: string) => (open: boolean) => setOpenRow(open ? id : null);
  const dirty = instructions.trim() !== instructionsSaved.trim();

  return (
    <div role="tabpanel" id="agent-panel-details" aria-labelledby="agent-tab-details" className="flex flex-col pt-2">
      <section aria-label="Agent information" className="flex flex-col">
      <Disclosure
        id={`${generated}-model`}
        label="Model"
        summary={modelEdit?.value || "Workspace default"}
        open={openRow === "model"}
        onOpenChange={toggle("model")}
      >
        {modelEdit ? (
          <>
            <label className="block text-[11px] text-[var(--muted-foreground-2)]">
              Coding model
              <select
                aria-label="Coding model"
                className={`${FIELD_CLASS} mt-1`}
                value={modelEdit.value}
                disabled={!editing || modelEdit.busy}
                onChange={(event) => modelEdit.onChange(event.target.value)}
              >
                <option value="">Use the workspace model default</option>
                {modelEdit.options.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
                {modelEdit.value && !modelEdit.options.some((option) => option.id === modelEdit.value) ? (
                  <option value={modelEdit.value}>{modelEdit.value}</option>
                ) : null}
              </select>
            </label>
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted-foreground-2)]">
              {editing
                ? "Saved on this bot and frozen into the next approval it queues."
                : "You cannot edit this bot."}
            </p>
          </>
        ) : (
          <p className="text-[11px] text-[var(--muted-foreground-2)]">The workspace's model default resolves per run.</p>
        )}
      </Disclosure>

      <Disclosure
        id={`${generated}-instructions`}
        label="Instructions"
        summary={instructions.trim() ? "Edited" : "Workspace instructions"}
        open={openRow === "instructions"}
        onOpenChange={toggle("instructions")}
      >
        <label className="block text-[11px] text-[var(--muted-foreground-2)]" htmlFor="bot-instructions-field">
          What this bot should do, and when it should stop
        </label>
        <textarea
          id="bot-instructions-field"
          value={instructions}
          readOnly={!editing}
          rows={6}
          onChange={(event) => onInstructionsChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && dirty) { event.preventDefault(); onInstructionsSave(); }
          }}
          placeholder="Describe what this bot should do, how it should respond, and when it should stop."
          className={`${FIELD_CLASS} mt-1 min-h-24 resize-y py-2 leading-relaxed`}
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!editing || saveBusy || !dirty}
            onClick={onInstructionsSave}
            className="min-h-9 rounded-md border border-[var(--border-1)] bg-[var(--inverse)] px-3 text-[11px] text-[var(--inverse-text)] disabled:opacity-50"
          >
            {saveBusy ? "Saving…" : "Save instructions"}
          </button>
          {dirty && !saveBusy ? <span className="text-[11px] text-[var(--muted-foreground-2)]">Unsaved changes · ⌘↵ saves</span> : null}
          {!dirty && instructions.trim() ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-[var(--muted-foreground-2)]"><Check aria-hidden="true" className="size-3" />Saved</span>
          ) : null}
        </div>
      </Disclosure>

      <Disclosure
        id={`${generated}-tools`}
        label="Tools"
        summary={toolsLoading ? "Checking…" : toolsError ? "Unknown" : `${toolsRows.filter((row) => row.state === "on").length} on`}
        open={openRow === "tools"}
        onOpenChange={toggle("tools")}
      >
        {toolsLoading && toolsRows.length === 0 ? (
          <p role="status" className="text-[11px] text-[var(--muted-foreground-2)]">Checking this bot's tool grants…</p>
        ) : (
          <BotToolsList rows={toolsRows} onManageTools={onManageTools} />
        )}
      </Disclosure>

      <Disclosure
        id={`${generated}-advanced`}
        label="Advanced"
        summary="Approval required"
        open={openRow === "advanced"}
        onOpenChange={toggle("advanced")}
      >
        <dl className="divide-y divide-[var(--border-1)] rounded-md border border-[var(--border-1)] bg-[var(--card)] px-3 py-1">
          {advanced.map((row) => <Fact key={row.label} label={row.label} value={row.value} />)}
        </dl>
      </Disclosure>

      </section>
      <div className="pt-2"><BotNotice notice={notice} /></div>
    </div>
  );
}
