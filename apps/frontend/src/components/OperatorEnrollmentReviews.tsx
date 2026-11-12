import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { operatorEnrollmentDirectorySchema, type OperatorEnrollmentDecision, type OperatorEnrollmentReview } from "@shiba/shared";

const BASE = "/api/operator-enrollment-reviews";
const BUTTON = "min-h-11 border border-[var(--line)] bg-[var(--card)] px-3 py-2 text-xs text-[var(--ink)] hover:bg-[var(--panel-2)] disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]";

/** Changing owner remounts this private view and discards pending responses and decisions. */
export function OperatorEnrollmentReviews({ actorId }: { actorId?: string | null }): JSX.Element | null {
  return actorId ? <OwnerReviews key={actorId} actorId={actorId.trim().toLowerCase()} /> : null;
}

function OwnerReviews({ actorId }: { actorId: string }): JSX.Element | null {
  const [rows, setRows] = useState<OperatorEnrollmentReview[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const accountPin = useRef<string | null>(null);
  const controller = useRef(new AbortController()), generation = useRef(0), operation = useRef(false);
  const apply = useCallback(async (response: Response, ticket: number) => {
    if (!response.ok) throw new Error(response.status === 409
      ? "This proposal changed or expired. Refresh and review it again."
      : "Operator enrollment reviews are unavailable. No execution has been enabled.");
    const parsed = operatorEnrollmentDirectorySchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Operator enrollment review data could not be verified.");
    if (controller.current.signal.aborted || ticket !== generation.current) return;
    if (parsed.data.actorId !== actorId || (accountPin.current !== null && parsed.data.ownerAccountId !== accountPin.current))
      throw new Error("Account identity changed. Reload the dashboard before reviewing proposals.");
    accountPin.current = parsed.data.ownerAccountId;
    setEnabled(parsed.data.enabled); setRows(parsed.data.proposals); setError(null);
  }, [actorId]);
  const refresh = useCallback(async () => {
    if (operation.current) return;
    const ticket = ++generation.current;
    setLoading(true); setRows([]); setReviewed(null); setError(null); setNotice(null);
    try {
      const response = await fetch(BASE, { cache: "no-store", signal: controller.current.signal });
      if (response.status === 403 || response.status === 404) {
        if (ticket === generation.current && !controller.current.signal.aborted) setEnabled(false);
        return;
      }
      await apply(response, ticket);
    } catch (cause) {
      if (!controller.current.signal.aborted && ticket === generation.current) setError(cause instanceof Error ? cause.message : "Review unavailable.");
    } finally { if (!controller.current.signal.aborted && ticket === generation.current) setLoading(false); }
  }, [apply]);
  useEffect(() => {
    controller.current = new AbortController(); void refresh();
    return () => { controller.current.abort(); ++generation.current; };
  }, [refresh]);
  const decide = async (row: OperatorEnrollmentReview, decision: OperatorEnrollmentDecision["decision"]) => {
    if (!accountPin.current || operation.current || loading || (decision === "accept" && reviewed !== row.proposalDigest)) return;
    operation.current = true; setBusy(true); setError(null); setNotice(null); setReviewed(null);
    const ticket = ++generation.current;
    try {
      const response = await fetch(`${BASE}/${row.enrollmentId}/decision`, { method: "POST", signal: controller.current.signal,
        headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedOwnerAccountId: accountPin.current, expectedVersion: row.version, proposalDigest: row.proposalDigest, decision, reviewOnly: true }) });
      await apply(response, ticket);
      if (!controller.current.signal.aborted && ticket === generation.current)
        setNotice(decision === "accept" ? "Review accepted. Account execution remains unavailable; no employee access or action approval was granted."
          : decision === "revoke" ? "Review acceptance revoked. The credential remains in OpenConnector." : "Proposal rejected.");
    } catch (cause) {
      if (!controller.current.signal.aborted && ticket === generation.current) {
        setRows([]); setError(cause instanceof Error ? cause.message : "Review outcome unavailable. Refresh before deciding again.");
      }
    } finally { operation.current = false; if (!controller.current.signal.aborted && ticket === generation.current) setBusy(false); }
  };
  if (!enabled && !error) return null;
  return <section aria-label="Operator account enrollment reviews" className="max-h-[60vh] shrink-0 overflow-y-auto border-b border-[var(--line)] bg-[var(--card)] p-4 text-xs text-[var(--ink)] lg:px-8">
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold">Operator account reviews</h3><button type="button" className={BUTTON} disabled={busy || loading} onClick={() => void refresh()}>Refresh reviews</button></div>
    <p className="mt-2 text-[var(--ink-2)]">Review only. API-key execution is disabled. Acceptance does not grant an employee access or approve any action. Credentials stay in OpenConnector.</p>
    {error ? <p role="alert" className="mt-2">{error}</p> : null}
    {notice ? <p role="status" className="mt-2">{notice}</p> : null}
    {loading ? <p role="status">Loading reviews…</p> : enabled && rows.length === 0 && !error ? <p className="mt-2">No operator proposals to review.</p> : null}
    {rows.map((row) => <article key={row.enrollmentId} className="mt-3 min-w-0 border border-[var(--line)] p-3">
      <h4 className="break-words font-semibold">{row.provider}: {row.accountLabel}</h4>
      <p className="mt-1">{row.expiresAt <= Date.now() && row.state !== "revoked" ? "Expired" : row.state === "accepted" ? "Accepted for review only" : row.state} · Execution unavailable</p>
      <dl className="mt-2 grid gap-1 break-all text-[var(--ink-2)]">
        <div><dt className="inline font-semibold">Account: </dt><dd className="inline">{row.rawConnectionId}</dd></div>
        <div><dt className="inline font-semibold">Credential revision: </dt><dd className="inline">{row.upstreamRevision}</dd></div>
        <div><dt className="inline font-semibold">Generation: </dt><dd className="inline">{row.enrollmentGeneration}</dd></div>
        <div><dt className="inline font-semibold">Deployment: </dt><dd className="inline">{row.deploymentEpoch} / {row.versionId}</dd></div>
        <div><dt className="inline font-semibold">Contract: </dt><dd className="inline">{row.manifestDigest}</dd></div>
        <div><dt className="inline font-semibold">Expires: </dt><dd className="inline">{new Date(row.expiresAt).toLocaleString()}</dd></div>
      </dl>
      <p className="mt-2 font-semibold">Exact proposed actions</p><ul className="list-inside list-disc break-all">{row.operations.map((item) => <li key={item.actionId}>{item.actionId}</li>)}</ul>
      <details className="mt-2 break-all text-[var(--ink-2)]"><summary className="cursor-pointer">Provenance and operation hashes</summary>
        <p>Personal alias: {row.personalAlias}</p><p>Upstream source: {row.upstreamSourceRevision}</p><p>Proposal digest: {row.proposalDigest}</p>
        <ul>{row.operations.map((item) => <li key={item.actionId}>{item.actionId}<br />Input schema: {item.inputSchemaHash}<br />Executor: {item.executorHash}</li>)}</ul>
      </details>
      {row.state === "proposed" && row.expiresAt > Date.now() ? <label className="mt-3 flex items-start gap-2"><input type="checkbox" checked={reviewed === row.proposalDigest} disabled={busy || loading} onChange={(event) => setReviewed(event.target.checked ? row.proposalDigest : null)} /><span>I reviewed this exact account, generation, actions and expiry. I understand this does not enable execution.</span></label> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {row.state === "proposed" ? <><button type="button" className={BUTTON} disabled={busy || loading || reviewed !== row.proposalDigest || row.expiresAt <= Date.now()} onClick={() => void decide(row, "accept")}>Accept review only</button><button type="button" className={BUTTON} disabled={busy || loading} onClick={() => void decide(row, "reject")}>Reject proposal</button></> : null}
        {row.state === "accepted" || row.state === "proposed" ? <button type="button" className={BUTTON} disabled={busy || loading} onClick={() => void decide(row, "revoke")}>Revoke review</button> : null}
      </div>
    </article>)}
  </section>;
}
