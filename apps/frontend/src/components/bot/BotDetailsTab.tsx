import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, ExternalLink } from "lucide-react";
import { BotNotice, Disclosure, FIELD_CLASS, QUIET_BUTTON } from "./BotPanel";
import { BOT_TOOL_STATE_LABEL, type BotToolRow } from "../../bot-tools";
import type { EmployeeRuntimeMemory, EmployeeRuntimeState } from "@shiba/shared";
import { teamWorkspaceHeaders } from "../../team-workspaces-client";

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
  agentId?: string;
  workspaceId?: string;
  conversationId?: string;
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

function memoryScope(memory: EmployeeRuntimeMemory): string {
  return memory.scope === "employee" ? "Employee" : "Thread";
}

function BotMemoryPanel({ agentId, workspaceId, conversationId = "default", canEdit }: {
  agentId: string;
  workspaceId?: string;
  conversationId?: string;
  canEdit: boolean;
}) {
  const [memories, setMemories] = useState<EmployeeRuntimeMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [scope, setScope] = useState<"employee" | "thread">("thread");
  const [essential, setEssential] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const loadRequest = useRef(0);

  const runtimePath = useCallback((suffix = "") => `/api/custom-agents/${encodeURIComponent(agentId)}/runtime${suffix}`, [agentId]);
  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${runtimePath("/state")}?conversationId=${encodeURIComponent(conversationId)}`, {
        credentials: "same-origin", cache: "no-store", headers: teamWorkspaceHeaders(workspaceId),
      });
      const body = await response.json().catch(() => ({})) as Partial<EmployeeRuntimeState> & { error?: string };
      if (!response.ok || !Array.isArray(body.memories)) throw new Error(body.error ?? `Memory could not be loaded (${response.status}).`);
      if (request === loadRequest.current) setMemories(body.memories);
    } catch (cause) {
      if (request === loadRequest.current) setError(cause instanceof Error ? cause.message : "Memory could not be loaded.");
    } finally {
      if (request === loadRequest.current) setLoading(false);
    }
  }, [conversationId, runtimePath, workspaceId]);

  useEffect(() => {
    setMemories([]);
    setEditingId(null);
    setNotice(null);
    void load();
  }, [load]);

  const mutate = async (suffix: string, body: Record<string, unknown>, ok: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(runtimePath(suffix), {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json", ...teamWorkspaceHeaders(workspaceId) },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `Memory could not be saved (${response.status}).`);
      await load();
      setNotice(ok);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Memory could not be saved.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const createMemory = async () => {
    const content = draft.trim();
    if (!content) return;
    const saved = await mutate("/memory", {
      scope, kind: "fact", content, essential,
      ...(scope === "thread" ? { conversationId } : {}),
    }, "Memory saved.");
    if (saved) {
      setDraft("");
      setEssential(false);
    }
  };

  const updateMemory = async (memory: EmployeeRuntimeMemory, patch: { content?: string; essential?: boolean }, ok: string) => {
    return mutate("/memory/update", {
      memoryId: memory.id,
      ...(memory.conversationId ? { conversationId: memory.conversationId } : {}),
      ...patch,
    }, ok);
  };

  const deleteMemory = async (memory: EmployeeRuntimeMemory) => {
    await mutate("/memory/delete", {
      memoryId: memory.id,
      ...(memory.conversationId ? { conversationId: memory.conversationId } : {}),
    }, "Memory deleted.");
  };

  if (loading && memories.length === 0) return <p role="status" className="text-[11px] text-[var(--muted-foreground-2)]">Loading this bot's memory…</p>;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] leading-relaxed text-[var(--muted-foreground-2)]">
        Essential memories are included in employee runtime context. Thread memories stay in this conversation; employee memories are shared by the employee.
      </p>
      {error ? <p role="alert" className="text-[11px] text-[var(--destructive)]">{error}</p> : null}
      {notice ? <p role="status" className="text-[11px] text-[var(--muted-foreground-2)]">{notice}</p> : null}
      {memories.length === 0 ? (
        <p className="border border-dashed border-[var(--border-1)] px-3 py-4 text-[11px] text-[var(--muted-foreground-2)]">No runtime memories yet.</p>
      ) : (
        <ul aria-label="Employee runtime memories" className="divide-y divide-[var(--border-1)] rounded-md border border-[var(--border-1)] bg-[var(--card)]">
          {memories.map((memory) => (
            <li key={memory.id} className="flex flex-col gap-2 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono uppercase tracking-wide text-[var(--muted-foreground-2)]">
                <span>{memoryScope(memory)}</span><span>{memory.kind}</span>{memory.essential ? <span className="text-[var(--primary)]">Essential</span> : null}
              </div>
              {editingId === memory.id ? (
                <div className="flex flex-col gap-2">
                  <textarea aria-label="Edit memory" rows={3} value={editDraft} onChange={(event) => setEditDraft(event.target.value)} className={`${FIELD_CLASS} min-h-20 resize-y py-2`} />
                  <div className="flex flex-wrap gap-2">
                    <button type="button" disabled={busy || !editDraft.trim()} className={`${QUIET_BUTTON} border border-[var(--border-1)] text-xs`} onClick={() => void updateMemory(memory, { content: editDraft.trim() }, "Memory updated.").then((saved) => { if (saved) setEditingId(null); })}>Save changes</button>
                    <button type="button" disabled={busy} className={`${QUIET_BUTTON} text-xs`} onClick={() => setEditingId(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-[var(--fg)]">{memory.content}</p>
              )}
              {canEdit && editingId !== memory.id ? (
                <div className="flex flex-wrap gap-1">
                  <button type="button" disabled={busy} className={`${QUIET_BUTTON} px-2 text-[11px]`} onClick={() => { setEditingId(memory.id); setEditDraft(memory.content); }}>Edit</button>
                  <button type="button" disabled={busy} className={`${QUIET_BUTTON} px-2 text-[11px]`} aria-pressed={memory.essential} onClick={() => void updateMemory(memory, { essential: !memory.essential }, memory.essential ? "Memory is no longer essential." : "Memory marked essential.")}>{memory.essential ? "Unset essential" : "Mark essential"}</button>
                  <button type="button" disabled={busy} className={`${QUIET_BUTTON} min-h-9 px-2 text-[11px] text-[var(--destructive)]`} onClick={() => void deleteMemory(memory)}>Delete</button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <div className="flex flex-col gap-2 rounded-md border border-[var(--border-1)] bg-[var(--card)] p-3">
          <label className="text-[11px] text-[var(--muted-foreground-2)]">
            New memory
            <textarea value={draft} rows={3} onChange={(event) => setDraft(event.target.value)} placeholder="A fact, preference, or reusable lesson this employee should remember." className={`${FIELD_CLASS} mt-1 min-h-20 resize-y py-2`} />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-[11px] text-[var(--muted-foreground-2)]">
              Scope
              <select aria-label="Memory scope" value={scope} onChange={(event) => setScope(event.target.value === "thread" ? "thread" : "employee")} className={`${FIELD_CLASS} ml-2 inline-block w-auto`}>
                <option value="employee">Employee</option>
                <option value="thread">This thread</option>
              </select>
            </label>
            <label className="inline-flex min-h-11 items-center gap-2 text-[11px] text-[var(--muted-foreground-2)]">
              <input type="checkbox" checked={essential} onChange={(event) => setEssential(event.target.checked)} />Essential
            </label>
            <button type="button" disabled={busy || !draft.trim()} onClick={() => void createMemory()} className="min-h-11 rounded-md border border-[var(--border-1)] bg-[var(--inverse)] px-3 text-[11px] text-[var(--inverse-text)] disabled:opacity-50">Save memory</button>
          </div>
        </div>
      ) : (
        <p className="text-[11px] text-[var(--muted-foreground-2)]">You can inspect this memory, but only an editor can change it.</p>
      )}
    </div>
  );
}

export function BotDetailsTab(props: BotDetailsTabProps) {
  const { editing, modelEdit, instructions, instructionsSaved, onInstructionsChange, onInstructionsSave, notice, saveBusy, toolsRows, toolsLoading, toolsError, onManageTools, advanced, agentId, workspaceId, conversationId, openInstructionsSignal } = props;
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

      {agentId ? (
        <Disclosure
          id={`${generated}-memory`}
          label="Memory"
          summary="Runtime"
          open={openRow === "memory"}
          onOpenChange={toggle("memory")}
        >
          {openRow === "memory" ? <BotMemoryPanel agentId={agentId} workspaceId={workspaceId} conversationId={conversationId} canEdit={editing} /> : null}
        </Disclosure>
      ) : null}

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
