import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { PersonalExecutionClient, type PersonalHarnessApproval, type PersonalHarnessRun } from "../personal-execution-client";

const BUTTON = "min-h-11 border border-[var(--line)] bg-[var(--card)] px-3 py-2 text-xs disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]";
export function PersonalExecutionControls({ workspaceId, actorId }: { workspaceId: string; actorId: string }): JSX.Element {
  return <ScopedPersonalExecutionControls key={`${workspaceId}:${actorId}`} workspaceId={workspaceId} />;
}
function ScopedPersonalExecutionControls({ workspaceId }: { workspaceId: string }): JSX.Element {
  const client = useMemo(() => new PersonalExecutionClient(workspaceId), [workspaceId]);
  const [runs, setRuns] = useState<PersonalHarnessRun[]>([]), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false), [now, setNow] = useState(Date.now());
  const live = useRef(false), epoch = useRef(0), operation = useRef(false), used = useRef(new Set<string>());
  const controller = useRef(new AbortController());
  const current = () => live.current && !controller.current.signal.aborted;
  const reload = useCallback(async () => {
    const generation = ++epoch.current, abort = controller.current;
    try { const result = await client.harness(abort.signal); if (live.current && !abort.signal.aborted && generation === epoch.current) { setRuns(result); setError(""); } }
    catch { if (live.current && !abort.signal.aborted && generation === epoch.current) { setRuns([]); setError("Personal run controls are unavailable. No permission decision was made."); } }
  }, [client]);
  useEffect(() => {
    live.current = true; const abort = new AbortController(); controller.current = abort; void reload();
    const timer = window.setInterval(() => { setNow(Date.now()); if (!operation.current) void reload(); }, 5_000);
    return () => { live.current = false; epoch.current++; abort.abort(); window.clearInterval(timer); };
  }, [reload]);
  const submit = async (key: string, action: () => Promise<void>) => {
    if (operation.current || used.current.has(key) || !current()) return;
    used.current.add(key); operation.current = true; epoch.current++; setBusy(true); setNotice("");
    try { await action(); if (current()) { setNotice("Control request sent. Waiting for the local daemon; this does not confirm the external outcome."); await reload(); } }
    catch { if (current()) { setRuns([]); setError("Control outcome could not be confirmed. Inspect current state before requesting any new action. It will not be automatically retried."); } }
    finally { operation.current = false; if (current()) setBusy(false); }
  };
  const decide = (run: PersonalHarnessRun, approval: PersonalHarnessApproval, decision: "allow" | "deny") =>
    submit(`${run.sandboxId}:${approval.requestId}:${approval.actionHash}`, () => client.decide(run, approval, decision, controller.current.signal));
  return <section aria-label="My local CLI permission requests" className="mt-3 min-w-0 border border-[var(--line)] p-3">
    <h4 className="font-medium">My local CLI permissions</h4>
    <p className="mt-2 text-xs text-[var(--ink-2)]">Only the verified machine owner can use these controls. Allow and deny also require current server-confirmed approval authority. There is no approve-all action.</p>
    {error && <p role="status" className="mt-2 text-xs">{error}</p>}{notice && <p role="status" className="mt-2 text-xs">{notice}</p>}
    <button type="button" className={`${BUTTON} mt-2`} disabled={busy} onClick={() => { void reload(); }}>Reload my local permissions</button>
    {runs.map((run) => <div key={run.sandboxId} className="mt-3 border-t border-[var(--line)] pt-2">
      <p className="break-all font-mono text-xs">Local process {run.sandboxId}</p>
      <button type="button" className={`${BUTTON} mt-2`} disabled={busy || !run.canInterrupt || used.current.has(`stop:${run.sandboxId}`)} onClick={() => { void submit(`stop:${run.sandboxId}`, () => client.interrupt(run, controller.current.signal)); }}>Stop my local process</button>
      {run.approvals.map((approval) => {
        const key = `${run.sandboxId}:${approval.requestId}:${approval.actionHash}`;
        const done = Boolean(approval.decision || approval.consumedAt || used.current.has(key)), expired = approval.expiresAt <= now;
        return <article key={key} className="mt-2 min-w-0 border border-[var(--line)] bg-[var(--paper)] p-3">
          <p className="break-words text-xs font-medium">{approval.title}</p><pre className="mt-2 whitespace-pre-wrap break-words text-xs">{approval.detail}</pre>
          <p className="mt-2 text-xs text-[var(--ink-2)]">{approval.reviewIncomplete ? "Complete safe review is unavailable. Approval is disabled." : "Complete sanitized request. The decision binds its source action hash and expiry."}</p>
          <p className="mt-1 text-xs text-[var(--ink-2)]">Frozen grant v{run.grantVersion} · machine revision {run.machineRevision}</p>
          <p className="break-all font-mono text-[10px]">Action hash {approval.actionHash || "unavailable"}</p>
          <p className="text-xs">{approval.decision ? `Recorded decision: ${approval.decision}` : done ? "Decision submitted. Do not repeat an uncertain action." : expired ? "Request expired." : `Expires ${new Date(approval.expiresAt).toLocaleString()}`}</p>
          <div className="mt-2 flex flex-wrap gap-2"><button type="button" className={BUTTON} disabled={busy || done || expired || approval.reviewIncomplete || !run.canAllow} onClick={() => { void decide(run, approval, "allow"); }}>Allow this request</button><button type="button" className={BUTTON} disabled={busy || done || expired || !run.canDeny} onClick={() => { void decide(run, approval, "deny"); }}>Deny this request</button></div>
        </article>;
      })}
    </div>)}
  </section>;
}
