import { useEffect, useRef, useState, type JSX } from "react";
import type { ReportSlackIntent, ReportSlackState } from "@shiba/shared";
import { ReportSlackClient } from "../report-slack-client";

const BUTTON = "min-h-11 border border-[var(--line)] bg-[var(--card)] px-3 py-2 text-xs disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]";
const FIELD = "mt-1 min-h-11 min-w-0 w-full border border-[var(--input-line)] bg-[var(--paper)] px-3 py-2 text-xs";
type Props = { workspaceId: string; libraryId: string; report: { id: string; reportHash: string; expiresAt: number }; onClose: () => void };
export function ReportSlackDisclosure(props: Props): JSX.Element {
  return <ReportSlackDisclosureContent key={`${props.workspaceId}:${props.libraryId}:${props.report.id}:${props.report.reportHash}`} {...props} />;
}
function ReportSlackDisclosureContent({ workspaceId, libraryId, report, onClose }: Props): JSX.Element {
  const [client] = useState(() => new ReportSlackClient(workspaceId, libraryId, report.id));
  const [view, setView] = useState<ReportSlackState | null>(null), [linkId, setLinkId] = useState(""), [expiry, setExpiry] = useState("");
  const [disclosure, setDisclosure] = useState<Record<string, boolean>>({}), [sendReview, setSendReview] = useState<Record<string, boolean>>({});
  const [unconfirmed, setUnconfirmed] = useState<string[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null), pending = useRef(false), attempted = useRef(new Set<string>()), identity = useRef<{ value: string; id: string } | null>(null);
  const active = (signal: AbortSignal) => controller.current?.signal === signal && !signal.aborted;
  const adopt = (value: ReportSlackState) => {
    if (report.expiresAt <= Date.now()) { setView(null); return; }
    setView(value.available ? { ...value, intents: value.intents.filter((intent) => intent.reportHash === report.reportHash && intent.expiresAt > Date.now()) } : { ...value, intents: [], destinations: [] });
    setDisclosure({}); setSendReview({});
    setUnconfirmed((previous) => previous.filter((id) => !value.intents.some((item) => item.id === id && ["sent", "failed", "blocked", "cancelled", "expired"].includes(item.status))));
  };
  const clear = () => { setView(null); setDisclosure({}); setSendReview({}); setLinkId(""); };
  useEffect(() => {
    const current = new AbortController(); controller.current = current;
    const read = () => {
      if (!active(current.signal) || pending.current || document.visibilityState === "hidden" || report.expiresAt <= Date.now()) return;
      pending.current = true; setBusy(true);
      void client.read(current.signal).then((value) => { if (active(current.signal)) adopt(value); }).catch((cause) => { if (active(current.signal)) { clear(); setError(cause instanceof Error ? cause.message : "Current Slack disclosure permission is unavailable."); } })
        .finally(() => { if (active(current.signal)) { pending.current = false; setBusy(false); } });
    };
    read(); const timer = window.setInterval(read, 20_000); window.addEventListener("focus", read);
    return () => { current.abort(); window.clearInterval(timer); window.removeEventListener("focus", read); };
    // biome-ignore lint/correctness/useExhaustiveDependencies: Wrapper fixes exact actor/workspace/report scope, every continuation checks its controller.
  }, []);
  useEffect(() => {
    const signal = controller.current?.signal, now = Date.now();
    if (!signal) return;
    const due = Math.min(report.expiresAt, ...(view?.intents.map((item) => item.expiresAt) ?? []));
    const timer = window.setTimeout(() => {
      if (!active(signal)) return;
      if (report.expiresAt <= Date.now()) { clear(); setError("The report lease expired. Protected Slack draft content is hidden."); }
      else setView((current) => current ? { ...current, intents: current.intents.filter((item) => item.expiresAt > Date.now()) } : null);
      setDisclosure({}); setSendReview({});
    }, Math.min(2_147_483_647, Math.max(1, due - now + 1)));
    return () => window.clearTimeout(timer);
  }, [view, report.expiresAt]);
  const perform = async (operation: (signal: AbortSignal) => Promise<ReportSlackState>, message: string) => {
    const signal = controller.current?.signal;
    if (!signal || !active(signal) || pending.current || report.expiresAt <= Date.now()) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    try { const value = await operation(signal); if (active(signal)) { adopt(value); setNotice(message); } }
    catch (cause) { if (active(signal)) { clear(); setError(cause instanceof Error ? cause.message : "Delivery is unconfirmed. Refresh status without repeating the send."); } }
    finally { if (active(signal)) { pending.current = false; setBusy(false); } }
  };
  const unresolved = unconfirmed.length > 0 || Boolean(view?.intents.some((item) => ["sending", "unknown"].includes(item.status)));
  const prepare = () => {
    const destination = view?.destinations.find((item) => item.linkId === linkId), expiresAt = new Date(expiry).getTime();
    if (!view?.available || !destination || unresolved || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Math.min(report.expiresAt, Date.now() + 900_000)) { setError("Select an authorized destination and expiry within 15 minutes and the report lease."); return; }
    const value = JSON.stringify([report.reportHash, destination.roomId, destination.linkId, expiresAt]);
    if (identity.current?.value !== value) identity.current = { value, id: crypto.randomUUID() };
    void perform((signal) => client.prepare({ requestId: identity.current!.id, reportHash: report.reportHash, roomId: destination.roomId, linkId, expiresAt }, signal), "Private Slack draft prepared. It has not been disclosed or sent.");
  };
  const decide = (intent: ReportSlackIntent, action: "disclose" | "approve" | "cancel") => {
    if (intent.reportHash !== report.reportHash || intent.expiresAt <= Date.now() || pending.current) return;
    if (action === "disclose" && (!intent.canDisclose || !disclosure[intent.id])) return;
    if (action === "approve") {
      if (!intent.canApprove || !sendReview[intent.id] || unresolved || attempted.current.has(intent.id)) return;
      attempted.current.add(intent.id); setUnconfirmed((items) => [...items, intent.id]);
    }
    if (action === "cancel" && !intent.canCancel) return;
    void perform((signal) => action === "disclose" ? client.disclose(intent, signal) : action === "approve" ? client.approve(intent, signal) : client.cancel(intent, signal),
      action === "disclose" ? "Creator disclosure consent recorded. A separate human approval and send is still required." : action === "cancel" ? "Disclosure draft cancelled. Nothing is sent by this cancellation."
        : "Delivery status returned. Only a sent receipt confirms Slack accepted the message; unknown outcomes are not retried.");
  };
  return <section aria-label="Review report disclosure to Slack" className="mt-4 min-w-0 border border-[var(--line)] bg-[var(--card)] p-4 text-xs">
    <header className="flex flex-wrap justify-between gap-2"><h5 className="font-semibold">Separate report disclosure to Slack</h5><button type="button" className={BUTTON} disabled={busy} onClick={onClose}>Close Slack disclosure</button></header>
    <p className="mt-3">The report remains private until you explicitly disclose it. Source connection ownership, native identity, configured room policy and exact destination are checked separately. Generating a report never creates or sends a Slack message.</p>
    <button type="button" className={`${BUTTON} mt-3`} disabled={busy} onClick={() => { void perform((signal) => client.read(signal), "Current disclosure state refreshed. No send was retried."); }}>Refresh Slack disclosure state</button>
    {error && <p role="alert" className="mt-3 text-[var(--danger)]">{error}</p>}{notice && <p role="status" className="mt-3">{notice}</p>}
    {unresolved && <p role="status" className="mt-3">A send is in flight or unconfirmed. Inspect the destination and delivery receipt; this panel will not repeat it.</p>}
    {view && !view.available && <p className="mt-3">Slack disclosure is unavailable for this report's current source ownership or configured room policy. No audience or approval is inferred.</p>}
    {view?.available && <><label className="mt-3 block">Configured Slack destination<select className={FIELD} value={linkId} disabled={busy || unresolved} onChange={(event) => setLinkId(event.target.value)}><option value="">Choose an exact room-linked thread</option>{view.destinations.map((item) => <option key={item.linkId} value={item.linkId}>{item.roomTitle} · {item.teamId}/{item.channelId} · {item.threadTs}</option>)}</select></label>
      <label className="mt-3 block">Disclosure draft expiry in your browser's local time<input className={FIELD} type="datetime-local" value={expiry} disabled={busy || unresolved} onChange={(event) => setExpiry(event.target.value)} /></label>
      <p className="mt-2">The complete neutralized report must fit in one message of at most 3,500 UTF-8 bytes. Larger reports are rejected without splitting or truncation.</p>
      <button type="button" className={`${BUTTON} mt-3`} disabled={busy || unresolved || !linkId || !expiry} onClick={prepare}>Prepare private Slack disclosure draft</button></>}
    {view?.intents.map((intent) => <article key={intent.id} className="mt-4 min-w-0 border-t border-[var(--line)] pt-3"><p>Delivery: {intent.status}</p><p className="mt-2 break-all">Exact destination: team {intent.destination.teamId} · channel {intent.destination.channelId} · thread {intent.destination.threadTs}</p><p className="mt-2">Authorized web-room readers: {intent.destination.roomAudienceIds.join(", ")}. This is not the Slack member list. Other people with access to the selected Slack channel/thread may read the message.</p>
      <p className="mt-2">Expires {new Date(intent.expiresAt).toISOString()}</p><p className="mt-2 break-all font-mono">Content hash {intent.contentHash}</p><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words">{intent.content}</pre>
      {intent.receiptTs && <p className="mt-2">Slack receipt timestamp: {intent.receiptTs}</p>}
      {intent.canDisclose && <><label className="mt-3 flex min-h-11 gap-2"><input type="checkbox" checked={Boolean(disclosure[intent.id])} disabled={busy} onChange={(event) => setDisclosure((value) => ({ ...value, [intent.id]: event.target.checked }))} />I own all selected source connections and authorize this exact report to be read by everyone who can access the selected Slack channel/thread, including people outside this web room.</label><button type="button" className={BUTTON} disabled={busy || !disclosure[intent.id]} onClick={() => decide(intent, "disclose")}>Disclose this exact report audience</button></>}
      {intent.canApprove && <><label className="mt-3 flex min-h-11 gap-2"><input type="checkbox" checked={Boolean(sendReview[intent.id])} disabled={busy || unresolved || attempted.current.has(intent.id)} onChange={(event) => setSendReview((value) => ({ ...value, [intent.id]: event.target.checked }))} />I reviewed the complete message, report hash, wider Slack audience, exact destination and expiry. Approve and send it once.</label><button type="button" className={BUTTON} disabled={busy || unresolved || !sendReview[intent.id] || attempted.current.has(intent.id)} onClick={() => decide(intent, "approve")}>Approve and send this complete small report once</button></>}
      {intent.canCancel && <button type="button" className={`${BUTTON} ml-2 mt-2`} disabled={busy} onClick={() => decide(intent, "cancel")}>Cancel disclosure draft</button>}
    </article>)}
  </section>;
}
