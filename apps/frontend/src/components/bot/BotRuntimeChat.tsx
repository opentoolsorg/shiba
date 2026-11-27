import { useCallback, useEffect, useRef, useState } from "react";
import { EMPLOYEE_RUNTIME_MESSAGE_MAX_LENGTH } from "@shiba/shared";
import type { EmployeeRuntimeExecution, EmployeeRuntimeMessage, EmployeeRuntimeState, EmployeeRuntimeStreamEvent } from "@shiba/shared";
import { teamWorkspaceHeaders } from "../../team-workspaces-client";
import { FIELD_CLASS, QUIET_BUTTON } from "./BotPanel";

type ChatMessage = Pick<EmployeeRuntimeMessage, "id" | "role" | "content">;
const runtimeDrafts = new Map<string, string>();

function runtimeMessage(id: string, role: "user" | "assistant", content: string): ChatMessage {
  return { id, role, content };
}

async function readSse(response: Response, onEvent: (event: EmployeeRuntimeStreamEvent) => void): Promise<void> {
  if (!response.body) throw new Error("The runtime stream is unavailable.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    pending += decoder.decode(part.value, { stream: true });
    let end = pending.indexOf("\n\n");
    while (end >= 0) {
      const raw = pending.slice(0, end);
      pending = pending.slice(end + 2);
      const data = raw.split("\n").find((line) => line.startsWith("data: "));
      if (data) onEvent(JSON.parse(data.slice(6)) as EmployeeRuntimeStreamEvent);
      end = pending.indexOf("\n\n");
    }
  }
}

/** Lightweight provider-independent employee conversation. No sandbox, repository, or coding harness is created here. */
export function BotRuntimeChat({ agentId, workspaceId, conversationId, variant = "panel" }: {
  agentId: string;
  workspaceId?: string;
  conversationId: string;
  variant?: "panel" | "main";
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pendingUser, setPendingUser] = useState<ChatMessage | null>(null);
  const [streamingText, setStreamingText] = useState("");
  const [activeExecution, setActiveExecution] = useState<EmployeeRuntimeExecution | null>(null);
  const [executions, setExecutions] = useState<EmployeeRuntimeExecution[]>([]);
  const [canRecover, setCanRecover] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const draftKey = `${workspaceId ?? "personal"}:${agentId}:${conversationId}`;
  const [draft, setDraftState] = useState(() => runtimeDrafts.get(draftKey) ?? "");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadRequest = useRef(0);

  const setDraft = useCallback((value: string) => {
    if (value) runtimeDrafts.set(draftKey, value);
    else runtimeDrafts.delete(draftKey);
    setDraftState(value);
  }, [draftKey]);

  const runtimePath = useCallback((suffix: string) => `/api/custom-agents/${encodeURIComponent(agentId)}/runtime${suffix}`, [agentId]);
  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    setLoading(true);
    try {
      const response = await fetch(`${runtimePath("/state")}?conversationId=${encodeURIComponent(conversationId)}`, {
        credentials: "same-origin", cache: "no-store", headers: teamWorkspaceHeaders(workspaceId),
      });
      const body = await response.json().catch(() => ({})) as Partial<EmployeeRuntimeState> & { error?: string };
      if (!response.ok || !Array.isArray(body.messages)) throw new Error(body.error ?? `Runtime chat could not be loaded (${response.status}).`);
      if (request === loadRequest.current) {
        setMessages(body.messages.filter((message) => message.role === "user" || message.role === "assistant"));
        setExecutions(Array.isArray(body.executions) ? body.executions : []);
        setCanRecover(body.permissions?.canRecover === true);
      }
    } catch (cause) {
      if (request === loadRequest.current) setError(cause instanceof Error ? cause.message : "Runtime chat could not be loaded.");
    } finally {
      if (request === loadRequest.current) setLoading(false);
    }
  }, [conversationId, runtimePath, workspaceId]);

  useEffect(() => {
    setDraftState(runtimeDrafts.get(draftKey) ?? "");
  }, [draftKey]);

  useEffect(() => {
    setMessages([]);
    setPendingUser(null);
    setStreamingText("");
    setActiveExecution(null);
    setExecutions([]);
    setCanRecover(false);
    void load();
  }, [load]);

  const finishTurn = async () => {
    setPendingUser(null);
    setStreamingText("");
    setActiveExecution(null);
    await load();
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || busy || activeExecution) return;
    if (text.length > EMPLOYEE_RUNTIME_MESSAGE_MAX_LENGTH) {
      setError(`Runtime messages must be ${EMPLOYEE_RUNTIME_MESSAGE_MAX_LENGTH.toLocaleString()} characters or fewer. Shorten the draft and try again.`);
      return;
    }
    setBusy(true);
    setError(null);
    setDraft("");
    setPendingUser(runtimeMessage(`local-user-${Date.now()}`, "user", text));
    setStreamingText("");
    try {
      const response = await fetch(runtimePath("/chat/stream"), {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json", ...teamWorkspaceHeaders(workspaceId) },
        body: JSON.stringify({ conversationId, message: text, mode: "chat" }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error ?? `Runtime chat failed (${response.status}).`);
      }
      let terminalType: "done" | "error" | null = null;
      let terminalError: string | null = null;
      await readSse(response, (event) => {
        if (event.type === "execution") setActiveExecution(event.execution);
        if (event.type === "delta") setStreamingText((current) => current + event.text);
        if (event.type === "done" || event.type === "error") {
          terminalType = event.type;
          terminalError = event.type === "error" ? event.error : null;
        }
      });
      if (terminalType === "error") setError(terminalError ?? "Employee inference failed.");
      await finishTurn();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Runtime chat failed. Refresh before retrying.");
      await finishTurn();
    } finally {
      setBusy(false);
    }
  };

  const recover = async () => {
    setRecovering(true);
    setError(null);
    try {
      const response = await fetch(runtimePath("/recover"), {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json", ...teamWorkspaceHeaders(workspaceId) },
        body: JSON.stringify({ conversationId }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string; failed?: number };
      if (!response.ok) throw new Error(payload.error ?? `Recovery failed (${response.status}).`);
      if (payload.failed) throw new Error("Interrupted work could not be recovered. Inspect the employee runtime execution state.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Recovery failed.");
    } finally {
      setRecovering(false);
    }
  };

  const clear = async () => {
    setError(null);
    try {
      const response = await fetch(runtimePath("/clear"), {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json", ...teamWorkspaceHeaders(workspaceId) },
        body: JSON.stringify({ conversationId }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error ?? `Clear failed (${response.status}).`);
      }
      setConfirmingClear(false);
      setMessages([]);
      setExecutions([]);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Clear failed.");
    }
  };

  const cancel = async () => {
    if (!activeExecution) return;
    setError(null);
    try {
      const response = await fetch(runtimePath("/cancel"), {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json", ...teamWorkspaceHeaders(workspaceId) },
        body: JSON.stringify({ executionId: activeExecution.id, conversationId }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error ?? `Cancellation failed (${response.status}).`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Cancellation failed.");
    }
  };

  const main = variant === "main";
  const visible = [
    ...messages,
    ...(pendingUser ? [pendingUser] : []),
    ...(streamingText ? [runtimeMessage("local-assistant-stream", "assistant", streamingText)] : []),
  ];

  return (
    <div className={`flex flex-col gap-3 ${main ? "min-h-0 flex-1" : ""}`}>
      <p className="text-[11px] leading-relaxed text-[var(--muted-foreground-2)]">
        Lightweight Chat mode uses this employee's identity, instructions, and runtime memory directly. It does not create a repository, sandbox, or coding harness.
      </p>
      {executions.some((execution) => execution.recoverable === true) ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--border-1)] bg-[var(--warning-subtle)] px-3 py-2 text-[11px] text-[var(--fg)]">
          <span>Interrupted runtime work needs recovery.</span>
          {canRecover ? (
            <button type="button" disabled={recovering || busy} onClick={() => void recover()} className="min-h-11 rounded-md border border-[var(--border-1)] px-3 font-medium disabled:opacity-50">
              {recovering ? "Recovering…" : "Recover interrupted work"}
            </button>
          ) : <span className="text-[var(--muted-foreground-2)]">A manager can recover it.</span>}
        </div>
      ) : null}
      {error ? <p role="alert" className="text-[11px] text-[var(--destructive)]">{error}</p> : null}
      <div aria-live="polite" className={`overflow-y-auto rounded-md border border-[var(--border-1)] bg-[var(--card)] p-3 ${main ? "min-h-0 flex-1" : "max-h-72"}`}>
        {loading && visible.length === 0 ? <p role="status" className="text-[11px] text-[var(--muted-foreground-2)]">Loading runtime chat…</p> : null}
        {!loading && visible.length === 0 ? <p className="text-[11px] text-[var(--muted-foreground-2)]">No runtime messages yet. Ask a question that does not require execution.</p> : null}
        <ol className="flex flex-col gap-3">
          {visible.map((message) => (
            <li key={message.id} className={message.role === "user" ? "ml-8" : "mr-8"}>
              <p className="text-[10px] font-mono uppercase tracking-wide text-[var(--muted-foreground-2)]">{message.role === "user" ? "You" : "Employee"}</p>
              <p className="mt-1 whitespace-pre-wrap break-words rounded-md border border-[var(--border-1)] px-3 py-2 text-xs leading-relaxed text-[var(--fg)]">{message.content}</p>
            </li>
          ))}
        </ol>
      </div>
      <label className="text-[11px] text-[var(--muted-foreground-2)]">
        Runtime message
        <textarea value={draft} rows={main ? 4 : 3} onChange={(event) => setDraft(event.target.value)} placeholder="Ask without starting sandbox work…" className={`${FIELD_CLASS} mt-1 min-h-20 resize-y py-2`} />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy || activeExecution !== null || !draft.trim()} onClick={() => void send()} className="min-h-11 rounded-md border border-[var(--border-1)] bg-[var(--inverse)] px-3 text-[11px] text-[var(--inverse-text)] disabled:opacity-50">
          {busy || activeExecution ? "Sending…" : "Send runtime message"}
        </button>
        {activeExecution ? (
          <button type="button" className={`${QUIET_BUTTON} border border-[var(--border-1)] text-xs`} onClick={() => void cancel()}>Stop generating</button>
        ) : null}
        {confirmingClear ? (
          <>
            <button type="button" disabled={busy || activeExecution !== null} onClick={() => void clear()} className="min-h-11 rounded-md border border-[var(--destructive)] px-3 text-[11px] text-[var(--destructive)] disabled:opacity-50">Confirm clear</button>
            <button type="button" onClick={() => setConfirmingClear(false)} className={`${QUIET_BUTTON} border border-[var(--border-1)] text-xs`}>Keep conversation</button>
          </>
        ) : (
          <button type="button" disabled={busy || activeExecution !== null || messages.length === 0} onClick={() => setConfirmingClear(true)} className={`${QUIET_BUTTON} border border-[var(--border-1)] text-xs disabled:opacity-50`}>Clear runtime conversation</button>
        )}
      </div>
    </div>
  );
}
