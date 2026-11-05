import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { TEAM_MODEL_TEXT_MODEL, TEAM_MODEL_LLAMA_MODEL, isTeamModelMoneyContract, type TeamModelFunding, type TeamModelFundingInput, type TeamModelStateResponse, type TeamModelTurn } from "@shiba/shared";
import { TeamModelClient, teamModelAccessLost } from "../team-model-client";
import { TeamModelFundingForm } from "./TeamModelFundingForm";
import { TeamModelMoneyDetails, TeamModelTurnMoney } from "./TeamModelMoneyDetails";

export interface TeamModelSessionsProps {
  workspaceId: string; roomId: string; actorId: string;
  messages: Array<{ id: string; author: string; body: string }>;
  notes: Array<{ id: string; version: 1; sha256: string; title: string; body: string }>;
}
const BUTTON = "min-h-11 border border-[var(--line)] bg-[var(--card)] px-3 py-2 text-xs disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]";
const FIELD = "mt-1 min-h-11 min-w-0 w-full border border-[var(--input-line)] bg-[var(--paper)] px-3 py-2 text-sm";
const reviewKey = (turn: TeamModelTurn) => JSON.stringify([turn.version, turn.inputHash, turn.messages, turn.sources, turn.inputBytes, turn.maxOutputTokens, turn.expiresAt, turn.cost]);
const moneyCurrent = (grant: TeamModelFunding, now: number) => isTeamModelMoneyContract(grant.contract.money, grant.contract.maxOutputTokens) && grant.contract.money.quote.createdAt <= now && grant.contract.money.quote.dispatchUntil > now && Boolean(grant.money && grant.money.remainingBudgetMicroUsd >= grant.contract.money.maximumDebitPerCallMicroUsd);
const capacityAvailable = (grant: TeamModelFunding) => !grant.money?.capacity || (grant.money.capacity.requesterCanReserveNext && grant.money.capacity.workspaceCanReserveNext);
const terminal = (turn: TeamModelTurn) => ["completed", "cancelled", "blocked"].includes(turn.status);

export function TeamModelSessions(props: TeamModelSessionsProps): JSX.Element {
  const key = `${props.workspaceId}\0${props.roomId}\0${props.actorId}`;
  const current = useRef(key); current.current = key;
  if (!/^ws_[a-f0-9]{24}$/.test(props.workspaceId) || !/^room_[a-f0-9]{24}$/.test(props.roomId) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(props.actorId) || props.actorId !== props.actorId.toLowerCase()) return <p role="status" className="text-xs">Select a verified native account and team room before opening funded text sessions.</p>;
  return <ScopedTeamModelSessions key={key} {...props} isCurrent={() => current.current === key} />;
}
function ScopedTeamModelSessions({ workspaceId, roomId, actorId, messages, notes, isCurrent }: TeamModelSessionsProps & { isCurrent: () => boolean }): JSX.Element {
  const client = useMemo(() => new TeamModelClient(workspaceId, roomId, actorId), [workspaceId, roomId, actorId]);
  const [state, setState] = useState<TeamModelStateResponse | null>(null), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [now, setNow] = useState(Date.now());
  const [selection, setSelection] = useState<{ id: string; version: number } | null>(null), [prompt, setPrompt] = useState("");
  const [messageIds, setMessageIds] = useState<string[]>([]), [noteIds, setNoteIds] = useState<string[]>([]);
  const [fundingReview, setFundingReview] = useState<string | null>(null), [reviewed, setReviewed] = useState<Record<string, string>>({});
  const [unconfirmed, setUnconfirmed] = useState<Record<string, string>>({});
  const [stopping, setStopping] = useState<Record<string, boolean>>({});
  const stopAbort = useRef(new AbortController()), stopPending = useRef(new Set<string>()), stopEpoch = useRef<Record<string, number>>({});
  const live = useRef(false), abort = useRef(new AbortController()), epoch = useRef(0), operating = useRef(false), used = useRef(new Set<string>());
  const scope = useRef(isCurrent); scope.current = isCurrent;
  const requestReceipt = useRef<{ payload: string; id: string } | null>(null);
  const active = useCallback(() => live.current && scope.current() && !abort.current.signal.aborted, []);
  const clear = useCallback(() => { setState(null); setSelection(null); setPrompt(""); setMessageIds([]); setNoteIds([]); setFundingReview(null); setReviewed({}); }, []);
  const adopt = useCallback((next: TeamModelStateResponse) => {
    if (!active()) return;
    setState(next); setNow(Date.now());
    setUnconfirmed((old) => Object.fromEntries(Object.entries(old).filter(([id]) => !next.turns.some((turn) => turn.id === id && terminal(turn)))));
    setReviewed((old) => Object.fromEntries(Object.entries(old).filter(([id, key]) => next.turns.some((turn) => turn.id === id && reviewKey(turn) === key))));
  }, [active]);
  const failure = useCallback((cause: unknown) => {
    if (!active()) return;
    if (teamModelAccessLost(cause)) clear();
    setError(cause instanceof Error ? cause.message : "The team model outcome is unconfirmed. Refresh before another action.");
  }, [active, clear]);
  const reload = useCallback(async () => {
    if (!active()) return;
    const generation = ++epoch.current, controller = abort.current;
    try {
      const next = await client.state(controller.signal);
      if (!active() || generation !== epoch.current || controller !== abort.current) return;
      adopt(next); setError(""); setLoading(false);
    } catch (cause) {
      if (active() && generation === epoch.current && controller === abort.current) { clear(); failure(cause); setLoading(false); }
    }
  }, [active, adopt, clear, client, failure]);
  useEffect(() => {
    live.current = true; const controller = new AbortController(); abort.current = controller; const stopController = new AbortController(); stopAbort.current = stopController;
    void reload();
    const refresh = () => { if (!operating.current) void reload(); };
    const timer = window.setInterval(() => { setNow(Date.now()); refresh(); }, 10_000);
    window.addEventListener("focus", refresh);
    return () => { live.current = false; epoch.current++; controller.abort(); stopController.abort(); window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [reload]);
  useEffect(() => {
    const at = Date.now();
    const future = [...(state?.turns.flatMap((turn) => [turn.expiresAt, ...(turn.cost ? [turn.cost.dispatchUntil] : [])]) ?? []),
      ...(state?.grants.flatMap((item) => [item.contract.expiresAt, ...(item.contract.money ? [item.contract.money.quote.dispatchUntil] : []), ...(item.state === "draft" ? [item.reviewExpiresAt] : [])]) ?? [])].filter((expiry) => expiry > at);
    if (!future.length) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, Math.min(...future) - at));
    return () => window.clearTimeout(timer);
  }, [state, now]);
  const readableTurn = (turn: TeamModelTurn) => (turn.status === "completed" || turn.expiresAt > now) && Boolean(state?.grants.some((item) => item.id === turn.grantId && item.state === "active" && item.contract.expiresAt > now));
  const uncertain = (id: string) => Object.values(unconfirmed).includes(id) || Boolean(state?.turns.some((turn) => turn.grantId === id && ["unknown", "running"].includes(turn.status)));
  const turnMoneyCurrent = (turn: TeamModelTurn) => Boolean(turn.cost && turn.cost.dispatchUntil > now && state?.grants.some((item) => item.id === turn.grantId && moneyCurrent(item, now)));
  const visibleTurns = state?.turns.filter((turn) => turn.sources.every((source) => source.kind === "message"
    ? messages.some((message) => message.id === source.id && message.body === source.body)
    : notes.some((note) => note.id === source.id && note.version === source.version && note.sha256 === source.sha256))) ?? [];
  const grant = state?.grants.find((item) => item.id === selection?.id && item.version === selection.version && item.contract.memberId === actorId && item.state === "active" && item.contract.expiresAt > now && item.usedRequests < item.contract.maxRequests && moneyCurrent(item, now) && capacityAvailable(item)) ?? null;
  useEffect(() => { if (selection && state && !grant) { setSelection(null); setReviewed({}); setNotice("The selected allowance changed or expired. Select a current grant explicitly. No other funding route is substituted."); } }, [grant, selection, state]);
  useEffect(() => {
    const availableMessages = new Set(messages.map((message) => message.id)), availableNotes = new Set(notes.map((note) => note.id));
    if (messageIds.some((id) => !availableMessages.has(id)) || noteIds.some((id) => !availableNotes.has(id))) {
      setMessageIds((old) => old.filter((id) => availableMessages.has(id))); setNoteIds((old) => old.filter((id) => availableNotes.has(id)));
      setReviewed({}); setState((old) => old ? { ...old, turns: [] } : null);
      setError("A selected room source was removed. Refresh and review its current scope before preparing another turn.");
    }
  }, [messages, notes, messageIds, noteIds]);
  useEffect(() => {
    if (!state?.turns.some((turn) => turn.sources.some((source) => source.kind === "message"
      ? !messages.some((message) => message.id === source.id && message.body === source.body)
      : !notes.some((note) => note.id === source.id && note.version === source.version && note.sha256 === source.sha256)))) return;
    setState((old) => old ? { ...old, turns: [] } : null); setReviewed({});
    setError("A frozen turn source changed or was revoked. Cached input and output were removed. Refresh the current server state.");
  }, [messages, notes, state?.turns]);
  const perform = async (key: string, action: () => Promise<void>) => {
    if (!active() || operating.current || used.current.has(key)) return;
    used.current.add(key); operating.current = true; epoch.current++; setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (cause) { failure(cause); }
    finally { operating.current = false; if (active()) setBusy(false); }
  };
  const adoptFunding = (next: TeamModelFunding) => {
    if (active()) { setNow(Date.now()); setState((old) => old ? { ...old, grants: [...old.grants.filter((item) => item.id !== next.id), next] } : null); }
  };
  const adoptTurn = (next: TeamModelTurn) => {
    if (!active()) return;
    setNow(Date.now()); setState((old) => old ? { ...old, turns: [...old.turns.filter((item) => item.id !== next.id), next] } : null);
    setReviewed((old) => { const copy = { ...old }; delete copy[next.id]; return copy; });
    if (terminal(next)) setUnconfirmed((old) => { const copy = { ...old }; delete copy[next.id]; return copy; });
  };
  const prepareFunding = (input: Omit<TeamModelFundingInput, "roomId">) => {
    if (!state?.enabled || !state.canFund) return;
    void perform(`prepare-funding:${JSON.stringify(input)}`, async () => { const next = await client.prepareFunding(input, abort.current.signal); if (active()) { adoptFunding(next); setFundingReview(null); setNotice("Funding review prepared. Nothing is enabled and no model request was started."); } });
  };
  const activate = (item: TeamModelFunding) => {
    if (!state?.enabled || !state.canFund || !item.canActivate || fundingReview !== `${item.id}:${item.version}:${item.digest}` || item.reviewExpiresAt <= Date.now() || item.contract.expiresAt <= Date.now() || !moneyCurrent(item, Date.now())) return;
    void perform(`activate:${item.id}:${item.version}`, async () => { const next = await client.activateFunding(item, abort.current.signal); if (active()) { adoptFunding(next); setFundingReview(null); setNotice("Funding state returned by the server. Each member turn still requires separate human review and execution."); } });
  };
  const prepare = () => {
    if (!state?.enabled || !grant || !capacityAvailable(grant) || !prompt.trim() || uncertain(grant.id)) return;
    const refs = noteIds.map((id) => notes.find((note) => note.id === id)).filter((note) => Boolean(note)).map((note) => ({ id: note!.id, version: note!.version, sha256: note!.sha256 }));
    if (refs.length !== noteIds.length || messageIds.some((id) => !messages.some((message) => message.id === id))) { setError("Selected context changed. Refresh before preparing this turn."); return; }
    const input = { prompt: prompt.trim(), messageIds, memoryRefs: refs };
    const payload = JSON.stringify([grant.id, grant.version, input]);
    requestReceipt.current = requestReceipt.current?.payload === payload ? requestReceipt.current : { payload, id: crypto.randomUUID() };
    const requestId = requestReceipt.current.id;
    void perform(`prepare-turn:${requestId}`, async () => { const next = await client.prepareTurn(grant, { ...input, requestId }, abort.current.signal); if (active()) { adoptTurn(next); setNotice("Exact input prepared for review. No model request was executed."); } });
  };
  const approve = (turn: TeamModelTurn) => {
    if (!state?.enabled || !turn.canApprove || turn.status !== "pending" || reviewed[turn.id] !== reviewKey(turn) || turn.expiresAt <= Date.now() || !turnMoneyCurrent(turn) || !turn.cost || turn.cost.dispatchUntil <= Date.now() || uncertain(turn.grantId)) return;
    void perform(`approve:${turn.id}:${turn.version}`, async () => { const next = await client.approveTurn(turn, abort.current.signal); if (active()) { adoptTurn(next); setNotice("Human review state returned by the server. Execute this exact turn separately to start a billed model call."); } });
  };
  const execute = (turn: TeamModelTurn) => {
    if (!active() || operating.current || !state?.enabled || !turn.canExecute || turn.status !== "approved" || turn.expiresAt <= Date.now() || !turnMoneyCurrent(turn) || !turn.cost || turn.cost.dispatchUntil <= Date.now() || uncertain(turn.grantId)) return;
    setUnconfirmed((old) => ({ ...old, [turn.id]: turn.grantId }));
    const capturedStopEpoch = stopEpoch.current[turn.id] ?? 0;
    void perform(`execute:${turn.id}:${turn.version}`, async () => { const next = await client.executeTurn(turn, abort.current.signal); if (active() && capturedStopEpoch === (stopEpoch.current[turn.id] ?? 0)) { adoptTurn(next); setNotice("Model turn state returned by the server. Unknown outcomes are not retried or refunded automatically."); } });
  };
  const cancel = (turn: TeamModelTurn) => {
    if (!active() || !turn.canCancel || stopPending.current.has(turn.id)) return;
    stopPending.current.add(turn.id); stopEpoch.current[turn.id] = (stopEpoch.current[turn.id] ?? 0) + 1;
    setStopping((old) => ({ ...old, [turn.id]: true })); setUnconfirmed((old) => ({ ...old, [turn.id]: turn.grantId })); setError("");
    const controller = stopAbort.current;
    void (async () => {
      try {
        const fresh = await client.state(controller.signal);
        if (!active() || controller !== stopAbort.current || controller.signal.aborted) return;
        adopt(fresh);
        const current = fresh.turns.find((item) => item.id === turn.id && item.grantId === turn.grantId);
        if (!current?.canCancel) { setNotice("Current server state does not permit Stop for this turn. No cancellation was sent."); return; }
        const next = await client.cancelTurn(current, controller.signal);
        if (active() && controller === stopAbort.current && !controller.signal.aborted) { adoptTurn(next); setNotice("Cancellation state returned by the server. An already started provider call may still finish and be billed. Unknown outcomes keep this grant blocked."); }
      } catch (cause) { failure(cause); }
      finally { if (active() && controller === stopAbort.current) setStopping((old) => ({ ...old, [turn.id]: false })); }
    })();
  };
  return <section aria-label="Deployment-funded team text sessions" className="mt-3 min-w-0 border border-[var(--line)] bg-[var(--card)] p-3">
    <h3 className="text-lg">Workers AI text sessions</h3><p className="mt-2 text-xs text-[var(--ink-2)]">Workers AI is billed to this deployment under an explicit grant. These private member turns use only reviewed employee instructions and individually selected web room context. No private memory, automatic room history, Slack context, tools, CLI execution or fallback provider is included.</p>
    <button type="button" className={`${BUTTON} mt-3`} disabled={busy} onClick={() => { void reload(); }}>Refresh team model state</button>
    {error && <p role="alert" className="mt-2 text-xs text-[var(--danger)]">{error}</p>}{notice && <p role="status" className="mt-2 text-xs">{notice}</p>}
    {loading ? <p role="status" className="mt-2 text-xs">Checking the current server funding policy…</p> : !state?.enabled ? <p className="mt-3 text-xs">Team model sessions are unavailable for this account or deployment. Ask the deployment operator to review the feature and billing policy.</p> : <>
      <p className="mt-3 break-all font-mono text-[10px]">Configured model {state.model} · policy {state.policyDigest}</p>
      {state.unavailableReason && <p className="mt-2 text-xs">Server state: {state.unavailableReason}</p>}
      {state.canFund && (state.model === TEAM_MODEL_TEXT_MODEL || state.model === TEAM_MODEL_LLAMA_MODEL) && <details className="mt-3 border border-[var(--line)] p-3"><summary className="min-h-11 cursor-pointer text-sm">Operator funding setup</summary><TeamModelFundingForm key={state.policyDigest} model={state.model} employees={state.employees} actors={state.actors.filter((actor) => actor.userId !== state.actorId)} disabled={busy} onChanged={() => setFundingReview(null)} onPrepare={prepareFunding} /></details>}
      {state.grants.filter((item) => item.contract.issuerId === actorId).map((item) => <article key={item.id} className="mt-3 min-w-0 border border-[var(--line)] p-3"><h4 className="text-sm font-semibold">Funding {item.state} · v{item.version}</h4><p className="mt-1 break-words text-xs">{item.contract.memberId} · {item.contract.employeeName} v{item.contract.employeeVersion} · membership v{item.contract.memberVersion}</p><p className="mt-1 break-all text-xs">{item.contract.model} · deployment-workers-ai · requesting member only</p><p className="mt-1 text-xs">Maximum {item.contract.maxRequests} requests · {item.contract.maxInputBytes.toLocaleString()} full input bytes and {item.contract.maxOutputTokens} output tokens per request · expires {new Date(item.contract.expiresAt).toLocaleString()}</p><p className="mt-1 text-xs">{item.usedRequests} reserved requests · {item.reservedInputBytes} reserved input bytes · {item.reservedOutputTokens} reserved output tokens. Full envelopes are permanent authorization debits, not actual invoice charges.</p><TeamModelMoneyDetails grant={item} /><p className="mt-1 break-all font-mono text-[10px]">Funding digest {item.digest}</p>{item.contract.expiresAt > now && (item.state !== "draft" || item.reviewExpiresAt > now) && <details className="mt-2 text-xs"><summary>Review frozen employee instructions</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">{item.contract.employeeInstructions}</pre></details>}{item.unavailableReason && <p className="mt-2 text-xs">{item.unavailableReason}</p>}
        {state.canFund && item.canActivate && item.state === "draft" && <div className="mt-2"><label className="flex min-h-11 items-start gap-2 text-xs"><input type="checkbox" checked={fundingReview === `${item.id}:${item.version}:${item.digest}`} disabled={busy || item.reviewExpiresAt <= now || item.contract.expiresAt <= now || !moneyCurrent(item, now)} onChange={(event) => setFundingReview(event.target.checked ? `${item.id}:${item.version}:${item.digest}` : null)} /><span>I reviewed this exact employee, member, model, expiry and limits. I authorize Workers AI billing to this deployment under this grant. I reviewed the exact USD budget and expiring quote. This is an application authorization cap at those reference rates, not a provider invoice cap. Full reservations are not released or refunded.</span></label><button type="button" className={BUTTON} disabled={busy || fundingReview !== `${item.id}:${item.version}:${item.digest}` || item.reviewExpiresAt <= now || item.contract.expiresAt <= now || !moneyCurrent(item, now)} onClick={() => activate(item)}>Enable exact funding grant</button></div>}
        {item.canRevoke && <button type="button" className={`${BUTTON} mt-2`} disabled={busy} onClick={() => { void perform(`revoke:${item.id}:${item.version}`, async () => { const next = await client.revokeFunding(item, abort.current.signal); if (active()) { adoptFunding(next); setFundingReview(null); setNotice("Funding state refreshed. Revocation blocks further claims; an already started call may still be billed."); } }); }}>Revoke funding grant</button>}
      </article>)}
      <label className="mt-4 block text-xs">My text-session funding grant<select className={FIELD} value={selection?.id ?? ""} disabled={busy} onChange={(event) => { const item = state.grants.find((candidate) => candidate.id === event.target.value && candidate.contract.memberId === actorId && capacityAvailable(candidate)); setSelection(item ? { id: item.id, version: item.version } : null); setMessageIds([]); setNoteIds([]); setReviewed({}); }}><option value="">Choose a current grant. No funding selected.</option>{state.grants.filter((item) => item.contract.memberId === actorId).map((item) => <option key={item.id} value={item.id} disabled={item.state !== "active" || item.contract.expiresAt <= now || item.usedRequests >= item.contract.maxRequests || !moneyCurrent(item, now) || !capacityAvailable(item)}>{item.contract.employeeName} · {item.contract.model} · {item.state} · {item.usedRequests}/{item.contract.maxRequests} requests · v{item.version}</option>)}</select></label>
      {state.grants.filter((item) => item.contract.memberId === actorId && item.contract.issuerId !== actorId).map((item) => <details key={`cost:${item.id}`} className="mt-3 min-w-0 border border-[var(--line)] p-3"><summary className="min-h-11 cursor-pointer text-xs">My allowance · {item.contract.employeeName} · {item.state}</summary><TeamModelMoneyDetails grant={item} />{item.unavailableReason && <p className="mt-2 text-xs">{item.unavailableReason}</p>}</details>)}
      {grant && <div className="mt-3 grid min-w-0 gap-3"><p className="break-all text-xs">Selected {grant.contract.model} for {grant.contract.employeeName} v{grant.contract.employeeVersion}. Maximum full input {grant.contract.maxInputBytes} bytes; maximum output {grant.contract.maxOutputTokens} tokens. Expires {new Date(grant.contract.expiresAt).toLocaleString()}.</p><TeamModelMoneyDetails grant={grant} /><label className="text-xs">Exact text prompt<textarea className={`${FIELD} min-h-32`} value={prompt} maxLength={16_384} disabled={busy} onChange={(event) => setPrompt(event.target.value)} /></label><p className="text-xs">Prompt only: {new TextEncoder().encode(prompt).length} UTF-8 bytes. Employee instructions and selected sources also count; the server freezes the full input before review.</p>
        <fieldset className="min-w-0 border border-[var(--line)] p-3"><legend className="px-1 text-xs">Optional room context, nothing selected automatically</legend>{messages.map((message) => <label key={message.id} className="mt-2 flex min-h-11 items-start gap-2 break-words text-xs"><input type="checkbox" disabled={busy || (!messageIds.includes(message.id) && messageIds.length >= 12)} checked={messageIds.includes(message.id)} onChange={(event) => setMessageIds((old) => event.target.checked ? [...old, message.id] : old.filter((id) => id !== message.id))} /><span className="min-w-0 break-words">Web message by {message.author}: {message.body.slice(0, 240)}</span></label>)}{notes.map((note) => <label key={note.id} className="mt-2 flex min-h-11 items-start gap-2 break-words text-xs"><input type="checkbox" disabled={busy || (!noteIds.includes(note.id) && noteIds.length >= 8)} checked={noteIds.includes(note.id)} onChange={(event) => setNoteIds((old) => event.target.checked ? [...old, note.id] : old.filter((id) => id !== note.id))} /><span className="min-w-0 break-words">Shared note {note.title} · v{note.version} · {note.sha256.slice(0, 12)}</span></label>)}{!messages.length && !notes.length && <p className="text-xs">No eligible web messages or active shared notes are available.</p>}</fieldset>
        <button type="button" className={BUTTON} disabled={busy || !prompt.trim() || uncertain(grant.id) || new TextEncoder().encode(prompt).length > grant.contract.maxInputBytes} onClick={prepare}>Prepare exact text turn for review</button>{uncertain(grant.id) && <p role="status" className="text-xs">This grant has a running or unconfirmed turn. Inspect its outcome before new work. Nothing is retried automatically.</p>}</div>}
      <h4 className="mt-5 text-sm font-semibold">My frozen text turns</h4>{visibleTurns.length === 0 && <p className="mt-2 text-xs">No private turns are currently visible to you.</p>}{visibleTurns.map((turn) => <article key={turn.id} className="mt-3 min-w-0 border border-[var(--line)] p-3"><p className="break-all text-sm font-semibold">{turn.status} · {turn.model} · turn v{turn.version}</p><p className="mt-1 text-xs">{turn.inputBytes.toLocaleString()} full input bytes · maximum {turn.maxOutputTokens} output tokens · approval and dispatch deadline {new Date(turn.expiresAt).toLocaleString()}. Completed output requires current funding and source access.</p><TeamModelTurnMoney turn={turn} /><p className="mt-1 break-all font-mono text-[10px]">Frozen input {turn.inputHash}</p>{readableTurn(turn) && turn.messages.length > 0 && <details className="mt-2 text-xs" open={turn.status === "pending"}><summary>Review complete frozen model input</summary>{turn.messages.map((message, index) => <div key={index} className="mt-2"><p className="font-semibold">{message.role}</p><pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words">{message.content}</pre></div>)}</details>}{readableTurn(turn) && turn.sources.length > 0 && <details className="mt-2 text-xs"><summary>Review frozen source provenance</summary>{turn.sources.map((source) => <div key={`${source.kind}:${source.id}`} className="mt-2"><p className="break-all">{source.kind} {source.id} · author {source.author} · version {source.version ?? "message snapshot"} · {source.sha256}</p><pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words">{source.body}</pre></div>)}</details>}{readableTurn(turn) && turn.output !== null && <div className="mt-3"><p className="text-xs font-semibold">Model text output</p><pre className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">{turn.output}</pre></div>}{readableTurn(turn) && turn.error && <p className="mt-2 break-words text-xs">{turn.error}</p>}{unconfirmed[turn.id] && <p role="status" className="mt-2 text-xs">Execution response unconfirmed. No other turn on this grant can execute until its outcome is reconciled.</p>}
        {readableTurn(turn) && turn.canApprove && turn.status === "pending" && <label className="mt-2 flex min-h-11 items-start gap-2 text-xs"><input type="checkbox" disabled={busy || turn.expiresAt <= now || !turnMoneyCurrent(turn) || !turn.cost || turn.cost.dispatchUntil <= now} checked={reviewed[turn.id] === reviewKey(turn)} onChange={(event) => setReviewed((old) => ({ ...old, [turn.id]: event.target.checked ? reviewKey(turn) : "" }))} /><span>I reviewed the complete exact model input, source provenance, maximum permanent USD debit, quote, limits and expiry for this billed text turn.</span></label>}
        <div className="mt-2 flex flex-wrap gap-2">{turn.canApprove && turn.status === "pending" && <button type="button" className={BUTTON} disabled={busy || turn.expiresAt <= now || !turnMoneyCurrent(turn) || !turn.cost || turn.cost.dispatchUntil <= now || reviewed[turn.id] !== reviewKey(turn) || uncertain(turn.grantId)} onClick={() => approve(turn)}>Approve exact text input</button>}{turn.canExecute && turn.status === "approved" && <button type="button" className={BUTTON} disabled={busy || turn.expiresAt <= now || !turnMoneyCurrent(turn) || !turn.cost || turn.cost.dispatchUntil <= now || uncertain(turn.grantId)} onClick={() => execute(turn)}>Execute approved model turn</button>}{turn.canCancel && <button type="button" className={BUTTON} disabled={Boolean(stopping[turn.id]) || stopPending.current.has(turn.id)} onClick={() => cancel(turn)}>Stop this text turn</button>}</div></article>)}
    </>}
  </section>;
}
