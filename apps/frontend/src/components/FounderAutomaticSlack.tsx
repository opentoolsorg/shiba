import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { AUTOMATIC_SLACK_MAX_TTL_MS, founderSkillIdSchema, type AutomaticSlackGrant, type AutomaticSlackState } from "@shiba/shared";
import { FounderAutomaticSlackClient } from "../founder-automatic-slack-client";

const BUTTON = "min-h-11 border border-[var(--line)] bg-[var(--card)] px-3 py-2 text-xs disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]";
const FIELD = "mt-1 min-h-11 min-w-0 w-full border border-[var(--input-line)] bg-[var(--paper)] px-3 py-2 text-xs";
export type AutomaticSlackSample = { readGrantId: string; readGrantVersion: number; sampleOccurrenceId: string; sampleReportHash: string; expiresAt: number; readGrantExpiresAt: number };
const localDateInput = (at: number) => new Date(at - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
type Props = { workspaceId: string; libraryId: string; actorId: string; sample?: AutomaticSlackSample; onClose?: () => void; client?: FounderAutomaticSlackClient };

export function FounderAutomaticSlack(props: Props): JSX.Element {
  if (!/^ws_[a-f0-9]{24}$/.test(props.workspaceId) || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(props.actorId) || props.actorId !== props.actorId.toLowerCase() || !founderSkillIdSchema.safeParse(props.libraryId).success) return <p role="status">Select the current native account, founder skill and workspace before reviewing automatic Slack delivery.</p>;
  return <ScopedAutomaticSlack key={`${props.workspaceId}:${props.libraryId}:${props.actorId}:${props.sample?.readGrantId ?? ""}:${props.sample?.readGrantVersion ?? ""}:${props.sample?.sampleOccurrenceId ?? ""}:${props.sample?.sampleReportHash ?? ""}:${props.sample?.expiresAt ?? ""}:${props.sample?.readGrantExpiresAt ?? ""}`} {...props} />;
}
function ScopedAutomaticSlack({ workspaceId, libraryId, actorId, sample, onClose, client: provided }: Props): JSX.Element {
  const client = useMemo(() => provided ?? new FounderAutomaticSlackClient(workspaceId, libraryId, actorId), [provided, workspaceId, libraryId, actorId]);
  const [view, setView] = useState<AutomaticSlackState | null>(null), [linkId, setLinkId] = useState(""), [maxSends, setMaxSends] = useState(""), [expiry, setExpiry] = useState("");
  const [busy, setBusy] = useState(true), [now, setNow] = useState(Date.now()), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [reviews, setReviews] = useState<Record<string, boolean>>({}), [attempted, setAttempted] = useState<string[]>([]);
  const controller = useRef<AbortController | null>(null), pending = useRef(false), attempts = useRef(new Set<string>()), request = useRef<{ key: string; id: string } | null>(null);
  const active = (signal: AbortSignal) => controller.current?.signal === signal && !signal.aborted;
  const clear = () => { setView(null); setReviews({}); setLinkId(""); setNotice(""); };
  const adopt = (value: AutomaticSlackState) => { setView(value.available ? value : { ...value, destinations: [], grants: [], deliveries: [] }); setReviews({}); setNow(Date.now()); };
  const perform = async (operation: (signal: AbortSignal) => Promise<AutomaticSlackState>, message: string) => {
    const signal = controller.current?.signal; if (!signal || !active(signal) || pending.current) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try { const result = await operation(signal); if (active(signal)) { adopt(result); setNotice(message); } }
    catch (cause) { if (active(signal)) { clear(); setError(cause instanceof Error ? cause.message : "Future-delivery state is unconfirmed. Refresh without repeating a decision."); } }
    finally { if (active(signal)) { pending.current = false; setBusy(false); } }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: The wrapper keys exact native/sample scope; every continuation checks its current client controller.
  useEffect(() => {
    const owned = new AbortController(); controller.current = owned;
    pending.current = false; clear();
    const refresh = () => {
      if (!active(owned.signal) || pending.current || document.visibilityState === "hidden") return;
      pending.current = true; setBusy(true); clear();
      void client.read(owned.signal).then((result) => { if (active(owned.signal)) adopt(result); })
        .catch((cause) => { if (active(owned.signal)) { clear(); setError(cause instanceof Error ? cause.message : "Current automatic Slack permission is unavailable."); } })
        .finally(() => { if (active(owned.signal)) { pending.current = false; setBusy(false); } });
    };
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    refresh(); const timer = window.setInterval(refresh, 20_000); window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", visible);
    return () => { owned.abort(); window.clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", visible); if (controller.current === owned) controller.current = null; };
  }, [client]);
  useEffect(() => {
    const deadlines = [sample?.expiresAt, sample?.readGrantExpiresAt, ...(view?.grants.flatMap((grant) => [grant.expiresAt, grant.sampleExpiresAt, ...(["draft", "disclosed"].includes(grant.state) ? [grant.reviewExpiresAt] : [])]) ?? []), ...(view?.deliveries.map((delivery) => delivery.expiresAt) ?? [])].filter((value): value is number => value !== undefined && value !== null && value > now);
    if (!deadlines.length) return;
    const timer = window.setTimeout(() => { setNow(Date.now()); setReviews({}); }, Math.min(2_147_483_647, Math.max(1, Math.min(...deadlines) - Date.now() + 1)));
    return () => window.clearTimeout(timer);
  }, [sample?.expiresAt, sample?.readGrantExpiresAt, view, now]);
  const validSample = sample && /^[a-f0-9]{64}$/.test(sample.sampleReportHash) && sample.readGrantVersion > 0 && Number.isInteger(sample.readGrantVersion) && sample.expiresAt > now && sample.readGrantExpiresAt > now;
  const unresolved = Boolean(view?.deliveries.some((item) => ["sending", "unknown"].includes(item.state)));
  const prepare = () => {
    const destination = view?.destinations.find((item) => item.linkId === linkId), expiresAt = new Date(expiry).getTime(), count = Number(maxSends);
    if (!view?.available || !sample || !validSample || !destination?.installation || unresolved || !maxSends || !Number.isInteger(count) || count < 1 || count > 10 || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Math.min(sample.readGrantExpiresAt, Date.now() + AUTOMATIC_SLACK_MAX_TTL_MS, destination.installation.expiresAt ?? Number.MAX_SAFE_INTEGER)) {
      setError("Select a current completed sample, managed destination, one to ten sends and an explicit expiry within 28 days and the read-grant/token lease."); return;
    }
    const input = { readGrantId: sample.readGrantId, readGrantVersion: sample.readGrantVersion, sampleOccurrenceId: sample.sampleOccurrenceId, sampleReportHash: sample.sampleReportHash, roomId: destination.roomId, linkId, maxSends: count, expiresAt };
    const key = JSON.stringify(input); if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
    void perform((signal) => client.prepare({ requestId: request.current!.id, ...input }, signal), "Future-delivery draft prepared. No disclosure, approval or message was sent.");
  };
  const decide = (grant: AutomaticSlackGrant, action: "disclose" | "approve" | "pause" | "revoke") => {
    const key = `${grant.id}:${grant.digest}:${action}`;
    if (pending.current || attempts.current.has(key) || grant.expiresAt <= Date.now()) return;
    if (action === "disclose" && (!grant.canDisclose || !reviews[key] || grant.reviewExpiresAt <= Date.now() || grant.sampleContent === null || grant.sampleExpiresAt === null || grant.sampleExpiresAt <= Date.now())) return;
    if (action === "approve" && (!grant.canApprove || !reviews[key] || grant.reviewExpiresAt <= Date.now() || grant.sampleContent === null || grant.sampleExpiresAt === null || grant.sampleExpiresAt <= Date.now() || unresolved)) return;
    if (action === "pause" && !grant.canPause || action === "revoke" && !grant.canRevoke) return;
    attempts.current.add(key); setAttempted((items) => [...items, key]);
    void perform((signal) => client.decide(grant, action, signal), action === "disclose" ? "Source-owner disclosure recorded. A different configured human must approve the exact future family before scheduling delivery."
      : action === "approve" ? "Future-delivery decision returned. This approval is not a send receipt; only qualifying later occurrences can be delivered within the reviewed limits."
        : "Future delivery disabled. A request already in flight may have reached Slack; unknown outcomes are not retried.");
  };
  return <section aria-label="Automatic founder reports to Slack" className="mt-4 min-w-0 space-y-3 border border-[var(--line)] bg-[var(--paper)] p-4 text-xs text-[var(--ink)]">
    <header className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-semibold">Future fixed-read reports to Slack</h4>{onClose && <button type="button" className={BUTTON} disabled={busy} onClick={onClose}>Close future Slack delivery</button>}</header>
    <p>This is separate standing permission for future completed reports from one exact scheduled-read grant. It does not authorize new app actions, models, employee work, invitations or channel creation.</p>
    <p>Only complete qualified reports up to 3,500 UTF-8 bytes can be sent. Captures are bounded, dataset completeness is unknown and business success is unverified. Oversized reports are blocked without splitting or truncation.</p>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <button type="button" className={BUTTON} disabled={busy} onClick={() => { clear(); void perform((signal) => client.read(signal), "Current future-delivery state refreshed. No decision or send was retried."); }}>Refresh future Slack state</button>
    {busy && !view && <p role="status">Checking current source and managed Slack permissions…</p>}
    {view && !view.available && <p role="status">Automatic delivery is unavailable. The operator must configure the attested read runtime, managed Slack installation, outbox and separate human approver. No catalog entry or legacy token grants delivery.</p>}
    {view?.available && <fieldset disabled={busy || !validSample || unresolved} className="space-y-3"><legend className="font-semibold">Prepare a future-delivery draft</legend>
      {validSample && sample ? <p className="break-all">Selected completed sample {sample.sampleOccurrenceId} · read grant {sample.readGrantId} version {sample.readGrantVersion} · report hash {sample.sampleReportHash}</p> : <p>Select and open a current completed scheduled-read report before preparing future Slack delivery. Existing grants can still be reviewed below.</p>}
      <label className="block">Exact managed room-linked Slack thread<select className={FIELD} value={linkId} onChange={(event) => setLinkId(event.target.value)}><option value="">Choose a configured managed destination</option>{view.destinations.map((item) => <option key={item.linkId} value={item.linkId}>{item.roomTitle} · {item.teamId}/{item.channelId} · {item.threadTs}</option>)}</select></label>
      <label className="block">Maximum future sends<input className={FIELD} type="number" min="1" max="10" step="1" value={maxSends} onChange={(event) => setMaxSends(event.target.value)} /></label>
      <label className="block">Future-delivery expiry in your browser's local time<input className={FIELD} type="datetime-local" value={expiry} max={localDateInput(Math.min(Date.now() + AUTOMATIC_SLACK_MAX_TTL_MS, sample?.readGrantExpiresAt ?? Number.MAX_SAFE_INTEGER, view.destinations.find((item) => item.linkId === linkId)?.installation?.expiresAt ?? Number.MAX_SAFE_INTEGER))} onChange={(event) => setExpiry(event.target.value)} /></label>
      <p>Choose every limit explicitly. Expiry must fit within 28 days and the current read-grant and token leases. Existing approved expiries and send limits are not extended. Preparation does not disclose or approve future reports.</p>
      <p>For weekly schedules, cover the next scheduled occurrence and its completion. Only future occurrences after approval qualify; historical samples are never sent as catch-up. The sample must remain current for both human decisions, which expire after 15 minutes.</p>
      <button type="button" className={BUTTON} disabled={busy || !validSample || !linkId || !maxSends || !expiry || unresolved} onClick={prepare}>Prepare future-delivery draft</button>
    </fieldset>}
    {unresolved && <p role="status">A delivery is sending or unknown. No new delivery authorization or automatic retry can resolve an uncertain send; inspect its receipt and destination.</p>}
    {view?.grants.filter((grant) => grant.expiresAt > now).map((grant) => {
      const reviewAlive = grant.reviewExpiresAt > now, sampleVisible = grant.sampleContent !== null && grant.sampleExpiresAt !== null && grant.sampleExpiresAt > now && (!["draft", "disclosed"].includes(grant.state) || reviewAlive);
      const key = (action: string) => `${grant.id}:${grant.digest}:${action}`;
      return <article key={`${grant.id}:${grant.digest}:${grant.state}`} className="min-w-0 space-y-2 border-t border-[var(--line)] pt-3">
        <h5 className="break-all font-semibold">Future delivery {grant.state} · {grant.id}</h5><p>Source owner {grant.ownerId} · {grant.usedSends}/{grant.maxSends} send slots used</p>
        <p className="break-all">Read grant {grant.readGrantId} version {grant.readGrantVersion} · digest {grant.readGrantDigest}</p>
        <p>Complete frozen source contract: exact provider accounts and operation arguments, runtime, employee and skill versions, schedule and source budgets.</p><pre data-testid="automatic-slack-source-contract" className="max-h-80 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(grant.readContract, null, 2)}</pre>
        <p className="break-all">Exact destination {grant.destination.teamId}/{grant.destination.channelId} · thread {grant.destination.threadTs}</p>
        <p className="break-all">Managed installation {grant.destination.installation?.id} · app {grant.destination.installation?.appId} · generation {grant.destination.installation?.generation} · version {grant.destination.installation?.version} · token revision {grant.destination.installation?.tokenRevision}</p>
        <p>Authorized web-room readers: {grant.destination.roomAudienceIds.join(", ")}. This is not the Slack member list. All current and future people with access to the selected Slack channel/thread may read future reports, including people outside this web room.</p>
        <p>Expires {new Date(grant.expiresAt).toISOString()} · Human review deadline {new Date(grant.reviewExpiresAt).toISOString()}</p>
        <p className="break-all">Future-family digest <code>{grant.digest}</code> · sample report hash <code>{grant.sampleReportHash}</code></p>
        <p>Renderer {grant.renderPolicy}; complete qualified markdown, maximum {grant.maxBytes} UTF-8 bytes. Future source data can change; the sample is not a preview of every future report. Only occurrences scheduled after approval qualify.</p>
        {sampleVisible ? <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words">{grant.sampleContent}</pre> : <p>Current sample review is unavailable or expired. No cached sample authorizes a new disclosure or approval.</p>}
        {grant.approvedByUserId && <p>Future delivery authorized by {grant.approvedByUserId}; scheduler execution is recorded separately.</p>}
        {grant.canDisclose && reviewAlive && sampleVisible && <><label className="flex min-h-11 gap-2"><input type="checkbox" checked={Boolean(reviews[key("disclose")])} disabled={busy || attempted.includes(key("disclose"))} onChange={(event) => setReviews((items) => ({ ...items, [key("disclose")]: event.target.checked }))} />I own every selected source connection and consent to future completed reports from this exact read grant being read by all current and future people with access to this exact Slack channel/thread, including people outside this web room.</label><button type="button" className={BUTTON} disabled={busy || !reviews[key("disclose")] || attempted.includes(key("disclose"))} onClick={() => decide(grant, "disclose")}>Disclose this future report audience</button></>}
        {grant.canApprove && reviewAlive && sampleVisible && <><label className="flex min-h-11 gap-2"><input type="checkbox" checked={Boolean(reviews[key("approve")])} disabled={busy || unresolved || attempted.includes(key("approve"))} onChange={(event) => setReviews((items) => ({ ...items, [key("approve")]: event.target.checked }))} />As a separate configured human, I reviewed this exact source grant, sample, wider future Slack audience, renderer, installation, maximum sends and expiry, and approve only this bounded future delivery family.</label><button type="button" className={BUTTON} disabled={busy || unresolved || !reviews[key("approve")] || attempted.includes(key("approve"))} onClick={() => decide(grant, "approve")}>Approve bounded future reports</button></>}
        <div className="flex flex-wrap gap-2">{grant.canPause && <button type="button" className={BUTTON} disabled={busy || attempted.includes(key("pause"))} onClick={() => decide(grant, "pause")}>Pause future delivery</button>}{grant.canRevoke && <button type="button" className={BUTTON} disabled={busy || attempted.includes(key("revoke"))} onClick={() => decide(grant, "revoke")}>Revoke future delivery</button>}</div>
        {attempted.some((item) => item.startsWith(`${grant.id}:${grant.digest}:`)) && <p role="status">Decision attempted once. Refresh status to inspect the outcome; this panel will not repeat it automatically.</p>}
      </article>;
    })}
    {view?.deliveries.filter((delivery) => delivery.expiresAt > now).map((delivery) => <article key={delivery.id} className="min-w-0 space-y-2 border-t border-[var(--line)] pt-3"><h5 className="font-semibold">Scheduled delivery: {delivery.state}</h5><p className="break-all">Occurrence {delivery.occurrenceId} · report {delivery.reportHash} · content hash {delivery.contentHash}</p><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words">{delivery.content}</pre>{delivery.receiptTs && <p>Slack acceptance timestamp: {delivery.receiptTs}. This does not prove every channel member read the message.</p>}{delivery.state === "unknown" && <p>Outcome unknown. No automatic resend is permitted.</p>}</article>)}
    <p>No email, OAuth launch, live Slack message or model call starts from opening this panel. Installed live delivery requires separately authorized operator configuration and acceptance testing.</p>
  </section>;
}
