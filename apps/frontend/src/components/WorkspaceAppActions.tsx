import { useEffect, useRef, useState, type JSX } from "react";
import type { WorkspaceIntegrationActionsResponse, WorkspaceIntegrationApproval, WorkspaceIntegrationApprovalsResponse, WorkspaceIntegrationConnection } from "@shiba/shared";
import { useCustomAgentOptions } from "./CustomAgentsView";
import { workspaceAppActions, workspaceAppApprovals, requestWorkspaceAppAction, decideWorkspaceAppAction, executeWorkspaceAppAction, workspaceAccessChanged, WorkspaceIntegrationRequestError } from "../workspace-integrations-client";

const BUTTON = "min-h-11 border border-[var(--line)] bg-[var(--card)] px-3 text-xs disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]";
const FIELD = "mt-1 min-h-11 min-w-0 w-full border border-[var(--input-line)] bg-[var(--paper)] px-3 py-2 text-sm";
const canonical = (value: unknown): string => JSON.stringify(value && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, JSON.parse(canonical((value as Record<string, unknown>)[key]))]))
  : Array.isArray(value) ? value.map((item) => JSON.parse(canonical(item))) : value) ?? "null";

type ActionInput = Parameters<typeof requestWorkspaceAppAction>[2];
type BlockedAction = { workspaceId: string; actorId: string; providerKey: string; unavailableConnectionId: string; input: ActionInput };

export function WorkspaceAppActions({ workspaceId, actorId, canManage, connections, isCurrent, onAccessLost, onConnect }: {
  workspaceId: string; actorId?: string | null; canManage: boolean; connections: WorkspaceIntegrationConnection[];
  isCurrent: () => boolean; onAccessLost: () => void; onConnect?: () => void;
}): JSX.Element | null {
  const employees = useCustomAgentOptions(Boolean(actorId), workspaceId, actorId ?? undefined);
  const [connectionId, setConnectionId] = useState(""), [employeeId, setEmployeeId] = useState(""), [query, setQuery] = useState("");
  const [actions, setActions] = useState<WorkspaceIntegrationActionsResponse["actions"]>([]), [actionId, setActionId] = useState("");
  const [argsText, setArgsText] = useState("{}"), [approvals, setApprovals] = useState<WorkspaceIntegrationApproval[]>([]);
  const [unconfirmed, setUnconfirmed] = useState<Record<string, string>>({});
  const [blocked, setBlocked] = useState<BlockedAction | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(false), abort = useRef(new AbortController()), pending = useRef(false), scope = useRef(isCurrent);
  const searchEpoch = useRef(0), requestReceipt = useRef<{ payload: string; requestId: string } | null>(null);
  scope.current = isCurrent;
  const active = () => alive.current && scope.current() && !abort.current.signal.aborted;
  const ready = connections.filter((connection) => connection.state === "active" && connection.upstreamReady);
  const paused = blocked?.workspaceId === workspaceId && blocked.actorId === actorId ? blocked : null;
  const replacements = paused ? ready.filter((connection) => connection.providerKey === paused.providerKey && connection.id !== paused.unavailableConnectionId) : [];
  const replacement = replacements.length === 1 ? replacements[0] : undefined;
  const adopt = (body: WorkspaceIntegrationApprovalsResponse) => {
    if (active()) {
      setApprovals(body.approvals);
      setUnconfirmed((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => !body.approvals.some((approval) => approval.id === id && ["completed", "failed", "denied", "expired"].includes(approval.status)))));
    }
  };
  const fail = (cause: unknown) => {
    if (!active()) return;
    if (workspaceAccessChanged(cause)) { setBlocked(null); setActions([]); setApprovals([]); setArgsText("{}"); onAccessLost(); }
    setError(cause instanceof Error ? cause.message : "Workspace app actions are unavailable.");
  };
  useEffect(() => {
    alive.current = true; const controller = new AbortController(); abort.current = controller;
    void workspaceAppApprovals(workspaceId, controller.signal).then(adopt).catch(fail);
    return () => { alive.current = false; searchEpoch.current++; controller.abort(); };
    // biome-ignore lint/correctness/useExhaustiveDependencies: Caller fixes the actor/workspace scope with a key and every continuation rechecks it.
  }, []);
  const perform = async (operation: () => Promise<void>) => {
    if (!active() || pending.current) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    try { await operation(); } catch (cause) { fail(cause); }
    finally { if (active()) { pending.current = false; setBusy(false); } }
  };
  const search = () => {
    const employee = employees.agents.find((item) => item.id === employeeId);
    if (!connectionId || !employee) return;
    const epoch = ++searchEpoch.current;
    void perform(async () => {
      const body = await workspaceAppActions(workspaceId, connectionId, employeeId, employee.version, query, abort.current.signal);
      if (active() && epoch === searchEpoch.current) { setActions(body.actions); setActionId(""); }
    });
  };
  const submitAction = (connection: WorkspaceIntegrationConnection, request: BlockedAction, resuming = false) => {
    if (request.workspaceId !== workspaceId || request.actorId !== actorId || request.providerKey !== connection.providerKey) return;
    if (accountUncertain(connection.id)) { setError("Inspect the uncertain or in-flight account action before requesting more work."); return; }
    const { input } = request;
    void perform(async () => {
      let body: WorkspaceIntegrationApprovalsResponse;
      try {
        body = await requestWorkspaceAppAction(workspaceId, connection.id, input, abort.current.signal);
      } catch (cause) {
        if (!active()) return;
        if (cause instanceof WorkspaceIntegrationRequestError && cause.status === 409 && cause.code === "workspace_action_connection_required") {
          setBlocked({ ...request, unavailableConnectionId: connection.id });
          return;
        }
        if (resuming && cause instanceof WorkspaceIntegrationRequestError && cause.status === 403 && cause.code === "workspace_connection_grant_missing") {
          setError("Ask a workspace manager to grant this account to you and the original employee before continuing.");
          return;
        }
        throw cause;
      }
      if (!active()) return;
      const receipt = body.approvals.find((item) => item.id === body.approvalId);
      if (!receipt || receipt.connectionId !== connection.id || receipt.employeeId !== input.employeeId || receipt.employeeVersion !== input.employeeVersion || receipt.actionId !== input.actionId || receipt.requesterId !== request.actorId.trim().toLowerCase() || canonical(receipt.arguments) !== canonical(input.arguments)) throw new Error("The exact action receipt could not be verified. Refresh requests before trying again.");
      if (resuming) { setConnectionId(connection.id); setActions([]); setActionId(""); }
      requestReceipt.current = { payload: canonical({ connectionId: connection.id, employeeId: input.employeeId, employeeVersion: input.employeeVersion, actionId: input.actionId, arguments: input.arguments }), requestId: input.requestId };
      setBlocked(null);
      adopt(body); setNotice("Action requested for human review. No external action was executed.");
    });
  };
  const requestAction = () => {
    const employee = employees.agents.find((item) => item.id === employeeId);
    const connection = ready.find((item) => item.id === connectionId);
    if (!actorId || paused || !employee || !actions.some((action) => action.id === actionId) || !connection) return;
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(argsText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || new TextEncoder().encode(argsText).length > 16_000) throw new Error("invalid_arguments");
      args = parsed as Record<string, unknown>;
    } catch { setError("Supply a JSON object of at most 16,000 bytes. Review the action's schema before requesting approval."); return; }
    const payload = canonical({ connectionId, employeeId, employeeVersion: employee.version, actionId, arguments: args });
    requestReceipt.current = requestReceipt.current?.payload === payload ? requestReceipt.current : { payload, requestId: crypto.randomUUID() };
    submitAction(connection, { workspaceId, actorId, providerKey: connection.providerKey, unavailableConnectionId: connection.id,
      input: { employeeId, employeeVersion: employee.version, actionId, arguments: args, requestId: requestReceipt.current.requestId } });
  };
  const decide = (approval: WorkspaceIntegrationApproval, approved: boolean) => {
    if (!canManage || !approval.canDecide || approval.status !== "pending" || approval.expiresAt <= Date.now()) return;
    void perform(async () => {
      const body = await decideWorkspaceAppAction(workspaceId, approval.id, approved, abort.current.signal);
      if (active()) { adopt(body); setNotice(approved ? "Human approval recorded. The original requester must separately execute this exact action." : "Action denied. Nothing was executed."); }
    });
  };
  const accountUncertain = (id: string) => Object.values(unconfirmed).includes(id) || approvals.some((approval) => approval.connectionId === id && ["unknown", "executing"].includes(approval.status));
  const execute = (approval: WorkspaceIntegrationApproval) => {
    if (!active() || pending.current || !approval.canExecute || accountUncertain(approval.connectionId) || approval.requesterId !== actorId?.trim().toLowerCase() || approval.status !== "approved" || approval.expiresAt <= Date.now()) return;
    setUnconfirmed((previous) => ({ ...previous, [approval.id]: approval.connectionId }));
    void perform(async () => {
      const body = await executeWorkspaceAppAction(workspaceId, approval.id, abort.current.signal);
      if (active()) { adopt(body); setNotice("Execution state refreshed from the server. Unknown outcomes must be inspected before another action."); }
    });
  };
  const selectedAction = actions.find((action) => action.id === actionId);
  const uncertain = accountUncertain(connectionId);
  if (!connections.length && !paused) return null;
  return <section aria-label="Manual workspace app actions" className="border border-[var(--line)] bg-[var(--card)] p-4">
    <h3 className="text-lg">Manual app actions and human review</h3><p className="mt-2 text-xs text-[var(--ink-2)]">Use an explicitly granted employee and account. Search returns action metadata, not proof that an app action works. This flow starts no model session. Each action needs a frozen human approval and a separate execution click by its original requester.</p>
    {error && <p role="alert" className="mt-3 text-xs text-[var(--danger)]">{error}</p>}{notice && <p role="status" className="mt-3 text-xs">{notice}</p>}
    {paused ? <section aria-label="Connect an app to resume" className="mt-4 min-w-0 border border-[var(--line)] p-4">
      <h4 className="break-words font-semibold">Connect {paused.providerKey} to resume</h4>
      <p className="mt-2 break-words text-sm">Your original request for <strong>{paused.input.actionId}</strong> is paused. The account needs a current grant for you and the original employee. Resuming requests human review; it does not execute the action.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {canManage && onConnect && !replacement && <button type="button" className={BUTTON} onClick={onConnect}>Connect app</button>}
        <button type="button" className={BUTTON} disabled={busy || !replacement} onClick={() => replacement && submitAction(replacement, paused, true)}>Resume for human review</button>
        <button type="button" className={BUTTON} disabled={busy} onClick={() => { setBlocked(null); setError(null); }}>Dismiss</button>
      </div>
      {replacement?.identityLabel && <p className="mt-2 break-words text-xs">Account for review: {replacement.identityLabel}</p>}
    </section> : <>
    <div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-xs">Shared app account<select className={FIELD} value={connectionId} disabled={busy} onChange={(event) => { searchEpoch.current++; setConnectionId(event.target.value); setActions([]); setActionId(""); }}><option value="">Choose a granted account</option>{ready.map((connection) => <option key={connection.id} value={connection.id}>{connection.providerKey} · {connection.identityLabel ?? "shared account"}</option>)}</select></label><label className="text-xs">Employee for this action<select className={FIELD} value={employeeId} disabled={busy || employees.loading} onChange={(event) => { searchEpoch.current++; setEmployeeId(event.target.value); setActions([]); setActionId(""); }}><option value="">Choose an employee with exact app grants</option>{employees.agents.map((employee) => <option key={employee.id} value={employee.id}>{employee.config.name} · v{employee.version}</option>)}</select></label></div>
    {employees.error && <p className="mt-2 text-xs text-[var(--danger)]">Current workspace employees are unavailable. Refresh before requesting work.</p>}
    <label className="mt-3 block text-xs">Search registered actions<input className={FIELD} value={query} maxLength={200} disabled={busy} onChange={(event) => setQuery(event.target.value)} /></label><button type="button" className={`${BUTTON} mt-2`} disabled={busy || !connectionId || !employeeId} onClick={search}>Find allowed actions</button>
    {actions.length > 0 && <div className="mt-3 grid gap-3"><label className="text-xs">Action<select className={FIELD} value={actionId} disabled={busy} onChange={(event) => setActionId(event.target.value)}><option value="">Choose an exact action</option>{actions.map((action) => <option key={action.id} value={action.id}>{action.name} · {action.id}</option>)}</select></label>{selectedAction && <details className="text-xs"><summary>Review action description and input schema</summary><p className="mt-2">{selectedAction.description}</p><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(selectedAction.inputSchema ?? {}, null, 2)}</pre></details>}<label className="text-xs">Exact action arguments<textarea className={`${FIELD} min-h-32 font-mono text-xs`} value={argsText} maxLength={16_000} disabled={busy} onChange={(event) => setArgsText(event.target.value)} /></label><button type="button" className={BUTTON} disabled={busy || !actionId || uncertain} onClick={requestAction}>Request human review</button></div>}
    </>}
    {uncertain && <p role="status" className="mt-3 text-xs">An action on this account is in flight or has an unknown outcome. Ask the operator to inspect it before another action. Nothing is retried automatically.</p>}
    <div className="mt-6 flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-semibold">Frozen action requests</h4><button type="button" className={BUTTON} disabled={busy} onClick={() => { void perform(async () => adopt(await workspaceAppApprovals(workspaceId, abort.current.signal))); }}>Refresh action requests</button></div>
    {approvals.length === 0 ? <p className="mt-3 text-xs text-[var(--ink-2)]">No requests are currently visible to you.</p> : <ul className="mt-3 grid gap-3">{approvals.filter((approval) => connections.some((connection) => connection.id === approval.connectionId)).map((approval) => <li key={approval.id} className="min-w-0 border border-[var(--line)] p-3"><h5 className="break-words text-sm font-semibold">{approval.actionId}</h5><p className="mt-1 break-words text-xs">{approval.employeeName} · employee v{approval.employeeVersion} · requested by {approval.requesterId}</p><p className="mt-1 text-xs">{approval.status} · account v{approval.connectionVersion}</p><p className="mt-1 break-all font-mono text-[10px]">Frozen input {approval.inputHash}</p><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(approval.arguments, null, 2)}</pre>{unconfirmed[approval.id] && <p role="status" className="mt-2 text-xs">Execution response unconfirmed. Inspect the current receipt before another action. Nothing is retried automatically.</p>}{approval.error && <p className="mt-2 break-words text-xs text-[var(--danger)]">{approval.error}</p>}{approval.result !== null && <details className="mt-2 text-xs"><summary>Action result</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(approval.result, null, 2)}</pre></details>}<div className="mt-3 flex flex-wrap gap-2">{canManage && approval.canDecide && approval.status === "pending" && <><button type="button" className={BUTTON} disabled={busy || approval.expiresAt <= Date.now()} onClick={() => decide(approval, true)}>Approve exact action</button><button type="button" className={BUTTON} disabled={busy || approval.expiresAt <= Date.now()} onClick={() => decide(approval, false)}>Deny action</button></>}{approval.canExecute && approval.requesterId === actorId?.trim().toLowerCase() && approval.status === "approved" && <button type="button" className={BUTTON} disabled={busy || accountUncertain(approval.connectionId) || approval.expiresAt <= Date.now()} onClick={() => execute(approval)}>Execute approved action</button>}</div></li>)}</ul>}
  </section>;
}
