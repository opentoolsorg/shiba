import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type JSX } from "react";
import type { ConnectedComputer, PairingTokenResponse } from "@shiba/shared";
import { currentPersonalAccounts, PersonalExecutionClient, personalGrantAvailable, type PersonalExecutionGrant } from "../personal-execution-client";
import { PersonalExecutionControls } from "./PersonalExecutionControls";

const FIELD = "mt-1 min-h-11 w-full min-w-0 border border-[var(--input-line)] bg-[var(--paper)] p-2 text-sm";
const BUTTON = "min-h-11 border border-[var(--line)] bg-[var(--card)] px-3 py-2 text-xs disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]";
export interface PersonalExecutionSetupProps {
  workspaceId: string;
  actorId: string;
  selected?: PersonalExecutionGrant | null;
  onSelectionChange: (grant: PersonalExecutionGrant | null) => void;
}

/** Pairing and grants are explicit user actions. They never queue or approve work. */
export function PersonalExecutionSetup(props: PersonalExecutionSetupProps): JSX.Element {
  if (!/^ws_[a-f0-9]{24}$/.test(props.workspaceId) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(props.actorId) || props.actorId !== props.actorId.toLowerCase()) {
    return <p role="status" className="text-xs">Select a verified native account and team workspace before personal setup.</p>;
  }
  return <ScopedPersonalExecutionSetup key={`${props.workspaceId}:${props.actorId}`} {...props} />;
}

function ScopedPersonalExecutionSetup({ workspaceId, actorId, selected, onSelectionChange }: PersonalExecutionSetupProps): JSX.Element {
  const client = useMemo(() => new PersonalExecutionClient(workspaceId), [workspaceId]);
  const [computers, setComputers] = useState<ConnectedComputer[]>([]);
  const [grants, setGrants] = useState<PersonalExecutionGrant[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pairing, setPairing] = useState<PairingTokenResponse | null>(null);
  const [pairHarness, setPairHarness] = useState<"" | "claude-code" | "codex">("");
  const [pairFingerprint, setPairFingerprint] = useState("");
  const [accountId, setAccountId] = useState("");
  const [model, setModel] = useState("");
  const [repo, setRepo] = useState("");
  const [duration, setDuration] = useState("60");
  const [consent, setConsent] = useState(false);
  const [hostingConsent, setHostingConsent] = useState(false);
  const [now, setNow] = useState(Date.now());
  const live = useRef(false), reading = useRef(0), operating = useRef(false), poll = useRef(true);
  const controller = useRef(new AbortController());
  const select = useRef(onSelectionChange); select.current = onSelectionChange;
  const current = () => live.current && !controller.current.signal.aborted;
  const clear = useCallback(() => {
    setComputers([]); setGrants([]); setPairing(null); setReady(false); setAccountId("");
    setConsent(false); setHostingConsent(false); select.current(null);
  }, []);
  const reload = useCallback(async () => {
    const epoch = ++reading.current, abort = controller.current;
    try {
      const [machines, saved] = await Promise.all([client.computers(abort.signal), client.grants(abort.signal)]);
      if (!live.current || abort.signal.aborted || epoch !== reading.current) return;
      setComputers(machines.filter((machine) => machine.personalExecution?.scope.actorId === actorId && machine.personalExecution.scope.workspaceId === workspaceId));
      setGrants(saved.filter((grant) => grant.snapshot.actorId === actorId && grant.snapshot.workspaceId === workspaceId));
      setReady(true); setError(""); poll.current = true;
    } catch (cause) {
      if (!live.current || abort.signal.aborted || epoch !== reading.current) return;
      clear(); poll.current = false;
      setError(cause instanceof Error ? cause.message : "Personal setup is unavailable.");
    }
  }, [actorId, clear, client, workspaceId]);
  useEffect(() => {
    live.current = true; const abort = new AbortController(); controller.current = abort;
    void reload();
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (!operating.current && poll.current) void reload();
    }, 5_000);
    return () => { live.current = false; reading.current++; abort.abort(); window.clearInterval(timer); };
  }, [reload]);
  useEffect(() => {
    if (pairing && pairing.expiresAt <= now) setPairing(null);
    if (!selected) return;
    const saved = grants.find((grant) => grant.snapshot.grantId === selected.snapshot.grantId && grant.version === selected.version);
    if (!ready || !saved || !personalGrantAvailable(saved, computers, workspaceId, actorId, now)) select.current(null);
  }, [actorId, computers, grants, now, pairing, ready, selected, workspaceId]);

  const accounts = computers.flatMap((computer) => currentPersonalAccounts(computer, workspaceId, actorId, now)
    .map((account) => ({ computer, account, id: `${computer.machineId}:${account.harness}:${account.accountFingerprint}:${account.authVersion}` })));
  const chosen = accounts.find((account) => account.id === accountId);
  const modelValid = chosen && new RegExp(`^${chosen.account.harness === "claude-code" ? "anthropic" : "openai"}/[a-zA-Z0-9][a-zA-Z0-9._-]*$`).test(model.trim());
  const repoValid = /^https:\/\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo.trim());

  const operation = async (action: () => Promise<void>) => {
    if (operating.current || !current()) return;
    operating.current = true; reading.current++; setBusy(true); setError(""); setNotice("");
    try { await action(); }
    catch (cause) { if (current()) { clear(); poll.current = false; setError(cause instanceof Error ? cause.message : "Personal setup could not be verified. Reload before continuing."); } }
    finally { if (current()) setBusy(false); operating.current = false; }
  };
  const pair = () => operation(async () => {
    if (!pairHarness || !/^[a-f0-9]{64}$/.test(pairFingerprint.trim())) return;
    const result = await client.pair({ harness: pairHarness, accountFingerprint: pairFingerprint.trim() }, controller.current.signal);
    if (!current()) return;
    if (result.expiresAt <= Date.now() || result.expiresAt > Date.now() + 15 * 60_000 + 5_000) throw new Error("The pairing code expiry could not be verified.");
    setPairing(result);
  });
  const create = (event: FormEvent) => {
    event.preventDefault();
    if (!chosen || !modelValid || !repoValid || !consent || !hostingConsent) return;
    if (!currentPersonalAccounts(chosen.computer, workspaceId, actorId, Date.now()).some((account) => account.accountFingerprint === chosen.account.accountFingerprint && account.authVersion === chosen.account.authVersion)) {
      clear(); setError("Local account proof expired. Reload before creating a grant."); return;
    }
    const captured = chosen;
    void operation(async () => {
      await client.create({ machineId: captured.computer.machineId, machineRevision: captured.computer.personalExecution!.revision,
        harness: captured.account.harness, accountFingerprint: captured.account.accountFingerprint, authVersion: captured.account.authVersion,
        codingModel: model.trim(), repoUrl: repo.trim(), expiresAt: Date.now() + Number(duration) * 60_000,
        consent: true, hostingConsent: true }, controller.current.signal);
      if (!current()) return;
      setConsent(false); setHostingConsent(false); setNotice("Grant created. Select it explicitly for this room task, then review the separate task approval.");
      await reload();
    });
  };
  const revoke = (grant: PersonalExecutionGrant) => operation(async () => {
    await client.revoke(grant, controller.current.signal);
    if (!current()) return;
    if (selected?.snapshot.grantId === grant.snapshot.grantId) select.current(null);
    setNotice("Grant revoked. It cannot authorize a new task."); await reload();
  });
  const unpair = (computer: ConnectedComputer) => operation(async () => {
    await client.unpair(computer, controller.current.signal);
    if (!current()) return;
    setPairing(null); setAccountId(""); select.current(null);
    setNotice("Computer unpaired. Reloaded grants must be reviewed before another task."); await reload();
  });

  return <section aria-label="Personal Claude or Codex execution" className="min-w-0 border border-[var(--line)] bg-[var(--card)] p-3">
    <h4 className="font-medium">Use my own Claude or Codex</h4>
    <p className="mt-2 text-xs text-[var(--ink-2)]">Only your paired computer and explicitly selected native subscription account can run this public repository task. There is no deployment account or cloud fallback.</p>
    {error && <p role="alert" className="mt-2 text-xs text-[var(--danger)]">{error}</p>}
    {notice && <p role="status" className="mt-2 text-xs">{notice}</p>}
    <button type="button" className={`${BUTTON} mt-2`} disabled={busy} onClick={() => { void reload(); }}>Reload personal setup</button>
    {!ready ? <p className="mt-2 text-xs text-[var(--ink-2)]">Setup requires an enabled deployment feature and your verified native account in this workspace.</p> : <>
      <label className="mt-3 block text-xs">Personal account grant for this room task
        <select className={FIELD} value={selected?.snapshot.grantId ?? ""} disabled={busy} onChange={(event) => {
          const grant = grants.find((item) => item.snapshot.grantId === event.target.value);
          select.current(grant && personalGrantAvailable(grant, computers, workspaceId, actorId, Date.now()) ? grant : null);
        }}><option value="">Choose a personal grant. No account selected.</option>{grants.map((grant) => <option key={grant.snapshot.grantId} value={grant.snapshot.grantId}
          disabled={!personalGrantAvailable(grant, computers, workspaceId, actorId, now)}>{grant.snapshot.harness} · {grant.snapshot.codingModel} · {grant.snapshot.repoUrl}{personalGrantAvailable(grant, computers, workspaceId, actorId, now) ? "" : " · unavailable"}</option>)}</select>
      </label>
      <p className="mt-2 text-xs text-[var(--ink-2)]">Local account observation is not proof of live entitlement, available quota or model support. Offline, stale and revoked grants cannot be selected.</p>
      <details onToggle={(event) => { if (!event.currentTarget.open) setPairing(null); }} className="mt-3 border-t border-[var(--line)] pt-2"><summary className="min-h-11 cursor-pointer py-2 text-xs">Pair a computer or create an explicit grant</summary>
        <p className="text-xs text-[var(--ink-2)]">Inspect your chosen CLI account locally first. Enter only the printed account fingerprint, never an API key, login file or token. Claude currently requires file-backed native login on Linux; Codex supports file-backed ChatGPT login on supported non-Windows machines.</p>
        <label className="mt-2 block text-xs">Native CLI to pair<select className={FIELD} value={pairHarness} disabled={busy} onChange={(event) => { setPairHarness(event.target.value as typeof pairHarness); setPairFingerprint(""); setPairing(null); }}><option value="">Choose a native CLI</option><option value="claude-code">Claude Code native subscription</option><option value="codex">Codex ChatGPT subscription</option></select></label>
        {pairHarness && <p className="mt-2 text-xs">From your Shiba checkout, inspect without starting a task:<code className="mt-1 block whitespace-pre-wrap break-all">node scripts/shiba-local-daemon.mjs --inspect-personal-auth {pairHarness}</code></p>}
        <label className="mt-2 block text-xs">Locally inspected account fingerprint<input className={FIELD} value={pairFingerprint} disabled={busy} maxLength={64} autoComplete="off" spellCheck={false} onChange={(event) => { setPairFingerprint(event.target.value); setPairing(null); }} /></label>
        <button type="button" className={`${BUTTON} mt-2`} disabled={busy || !pairHarness || !/^[a-f0-9]{64}$/.test(pairFingerprint.trim())} onClick={() => { void pair(); }}>Generate my personal pairing code</button>
        {pairing && <div className="mt-2 min-w-0 border border-[var(--line)] p-2"><p className="text-xs">Run this on your own computer. This single-use code expires in 15 minutes and stays only in this open setup.</p><pre className="mt-2 whitespace-pre-wrap break-all text-xs">{pairing.connectCommand}</pre><button type="button" className={`${BUTTON} mt-2`} onClick={() => setPairing(null)}>Hide pairing code</button></div>}
        {computers.length > 0 && <ul aria-label="My personal computers" className="mt-3 space-y-2">{computers.map((computer) => <li key={computer.machineId} className="flex flex-wrap items-center justify-between gap-2 border border-[var(--line)] p-2 text-xs"><span className="min-w-0 break-all">{computer.hostname} · {computer.status} · {computer.machineId.slice(-8)}</span><button type="button" className={`${BUTTON} max-w-full break-all`} disabled={busy} onClick={() => { void unpair(computer); }}>Unpair computer {computer.hostname}</button></li>)}</ul>}
        <form onSubmit={create} className="mt-3 flex min-w-0 flex-col gap-3">
          <label className="text-xs">Locally observed account<select className={FIELD} value={accountId} disabled={busy} onChange={(event) => { setAccountId(event.target.value); setModel(""); setConsent(false); setHostingConsent(false); }}><option value="">Choose your computer and observed account</option>{accounts.map(({ computer, account, id }) => <option key={id} value={id}>{computer.hostname} · {account.harness} · account {account.accountFingerprint.slice(0, 10)} · CLI {account.cliVersion}</option>)}</select></label>
          {accounts.length === 0 && <p className="text-xs text-[var(--ink-2)]">No idle personal computer with fresh supported account proof is available. Pair your computer and use the daemon's personal account inspection, then reload.</p>}
          <label className="text-xs">Exact model ID<input className={FIELD} value={model} disabled={busy || !chosen} maxLength={200} placeholder={chosen?.account.harness === "claude-code" ? "anthropic/<model-id>" : "openai/<model-id>"} onChange={(event) => setModel(event.target.value)} /></label>
          <label className="text-xs">Public GitHub repository<input className={FIELD} value={repo} disabled={busy} maxLength={512} placeholder="https://github.com/owner/repository" onChange={(event) => setRepo(event.target.value)} /></label>
          <label className="text-xs">Grant duration<select className={FIELD} value={duration} disabled={busy} onChange={(event) => setDuration(event.target.value)}><option value="15">15 minutes</option><option value="60">1 hour</option><option value="240">4 hours</option><option value="1440">24 hours</option></select></label>
          <label className="flex min-h-11 items-start gap-2 text-xs"><input type="checkbox" className="mt-1" checked={consent} disabled={busy} onChange={(event) => setConsent(event.target.checked)} /><span>I allow this selected account to run the public repository task and share its approved results with this room. Local execution runs as my operating system user and can access my host files. A fresh configuration home is not an OS sandbox.</span></label>
          <label className="flex min-h-11 items-start gap-2 text-xs"><input type="checkbox" className="mt-1" checked={hostingConsent} disabled={busy} onChange={(event) => setHostingConsent(event.target.checked)} /><span>I understand this deployment still hosts Worker and storage costs. This grant allows only my local repository task, with no operator-funded model, specialist, publication or app action.</span></label>
          <button type="submit" className={BUTTON} disabled={busy || !ready || !chosen || !modelValid || !repoValid || !consent || !hostingConsent}>Create personal execution grant</button>
          <p className="text-xs text-[var(--ink-2)]">Pairing and grant creation never start work. The exact task, shared context, account, machine, model and expiry still need a separate human approval.</p>
        </form>
      </details>
      {grants.length > 0 && <ul className="mt-3 space-y-2">{grants.map((grant) => <li key={grant.snapshot.grantId} className="min-w-0 border-t border-[var(--line)] pt-2 text-xs"><span className="break-all">{grant.snapshot.repoUrl} · {grant.status} · v{grant.version}</span><p>Expires {new Date(grant.snapshot.expiresAt).toLocaleString()}</p>{grant.status === "active" && <button type="button" className={`${BUTTON} mt-1`} disabled={busy} onClick={() => { void revoke(grant); }}>Revoke grant {grant.snapshot.grantId.slice(-6)}</button>}</li>)}</ul>}
      <p className="mt-2 text-xs text-[var(--ink-2)]">Revocation blocks new claims. Use the task cancellation controls for an already started local process.</p>
    </>}
    <PersonalExecutionControls workspaceId={workspaceId} actorId={actorId} />
  </section>;
}
