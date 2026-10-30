import { useCallback, useEffect, useState, type FormEvent, type JSX } from "react";

interface Grant { grantId:string; conversationId:string; sessionId:string; status:"active"|"revoked"; createdAt:number; }
interface Approval { approvalId:string; grantId:string; conversationId:string; sessionId:string; destination:string; message:string; status:string; expiresAt:number; }
interface SetupStatus { state:string; enabled:boolean; dispatchConfigured:boolean; networkMembership:string; activeGrants:number; pendingApprovals:number; }

async function api<T>(path:string, init?:RequestInit):Promise<T>{
  const response=await fetch(path,{...init,credentials:"same-origin",headers:{"content-type":"application/json",...init?.headers}});
  const payload=await response.json().catch(()=>({})) as T&{error?:string};
  if(!response.ok)throw new Error(payload.error??`Request failed (${response.status})`);
  return payload;
}

/** Approval setup only. This UI never starts the local process or sends a peer message. */
export function ReasonNetworkSetup():JSX.Element{
  const [status,setStatus]=useState<SetupStatus|null>(null);
  const [grants,setGrants]=useState<Grant[]>([]);
  const [approvals,setApprovals]=useState<Approval[]>([]);
  const [conversationId,setConversationId]=useState("");
  const [sessionId,setSessionId]=useState("");
  const [selectedGrant,setSelectedGrant]=useState("");
  const [destination,setDestination]=useState("");
  const [message,setMessage]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");

  const refresh=useCallback(async()=>{
    const [nextStatus,nextGrants,nextApprovals]=await Promise.all([
      api<SetupStatus>("/api/reason-network/status"),
      api<{grants:Grant[]}>("/api/reason-network/grants"),
      api<{approvals:Approval[]}>("/api/reason-network/approvals"),
    ]);
    setStatus(nextStatus);setGrants(nextGrants.grants);setApprovals(nextApprovals.approvals);
    setSelectedGrant((previous)=>nextGrants.grants.some((grant)=>grant.grantId===previous&&grant.status==="active")?previous:nextGrants.grants.find((grant)=>grant.status==="active")?.grantId??"");
  },[]);
  useEffect(()=>{let live=true;void refresh().catch((cause)=>{if(live)setError(cause instanceof Error?cause.message:String(cause));});return()=>{live=false;};},[refresh]);

  const mutate=async(operation:()=>Promise<unknown>)=>{setBusy(true);setError("");try{await operation();await refresh();}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}finally{setBusy(false);}};
  const createGrant=(event:FormEvent)=>{event.preventDefault();if(!conversationId.trim()||!sessionId.trim())return;void mutate(async()=>{await api("/api/reason-network/grants",{method:"POST",body:JSON.stringify({conversationId:conversationId.trim(),sessionId:sessionId.trim()})});setConversationId("");setSessionId("");});};
  const requestApproval=(event:FormEvent)=>{event.preventDefault();const grant=grants.find((item)=>item.grantId===selectedGrant&&item.status==="active");if(!grant||!destination.trim()||!message.trim())return;void mutate(async()=>{await api("/api/reason-network/approvals",{method:"POST",body:JSON.stringify({grantId:grant.grantId,conversationId:grant.conversationId,sessionId:grant.sessionId,destination:destination.trim(),message,idempotencyKey:`ui-${crypto.randomUUID()}`})});setDestination("");setMessage("");});};

  return <section aria-label="Reason Network setup" className="rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] p-4 shadow-[var(--sh-card)]">
    <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold">Reason Network (OSS)</h3><span className="rounded border border-[var(--border-1)] px-2 py-0.5 font-mono text-[10px]">{status?.state??"Checking"}</span></div>
    <p className="mt-2 text-xs leading-relaxed text-[var(--muted-foreground-2)]">The native connector is disabled and no send route is connected. This page stores scoped grants and message approvals only; it does not install or start the upstream process, join a network, check membership, or send messages.</p>
    <p className="mt-1 text-[11px]">Enabled: {status?.enabled?"yes":"no"} · Dispatch: {status?.dispatchConfigured?"configured":"not connected"} · Network membership: {status?.networkMembership??"not checked"} · Active grants: {status?.activeGrants??"…"} · Pending approvals: {status?.pendingApprovals??"…"}</p>
    {error?<p role="alert" className="mt-2 text-xs text-[var(--destructive)]">{error}</p>:null}
    <form onSubmit={createGrant} className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
      <input aria-label="Reason conversation ID" value={conversationId} onChange={(event)=>setConversationId(event.target.value)} maxLength={160} placeholder="Exact conversation ID" className="min-w-0 rounded border border-[var(--border-1)] bg-[var(--panel)] px-2 py-2 text-xs" />
      <input aria-label="Reason session ID" value={sessionId} onChange={(event)=>setSessionId(event.target.value)} maxLength={160} placeholder="Exact session ID" className="min-w-0 rounded border border-[var(--border-1)] bg-[var(--panel)] px-2 py-2 text-xs" />
      <button type="submit" disabled={busy||!conversationId.trim()||!sessionId.trim()} className="rounded border border-[var(--border-1)] px-3 py-2 text-xs disabled:opacity-50">Create local grant</button>
    </form>
    <form onSubmit={requestApproval} className="mt-3 grid gap-2">
      <select aria-label="Reason Network grant" value={selectedGrant} onChange={(event)=>setSelectedGrant(event.target.value)} className="rounded border border-[var(--border-1)] bg-[var(--panel)] px-2 py-2 text-xs">
        <option value="">Select an active conversation grant</option>{grants.filter((grant)=>grant.status==="active").map((grant)=><option key={grant.grantId} value={grant.grantId}>{grant.conversationId} · session {grant.sessionId}</option>)}
      </select>
      <input aria-label="Exact peer destination" value={destination} onChange={(event)=>setDestination(event.target.value)} maxLength={200} placeholder="One exact peer destination" className="rounded border border-[var(--border-1)] bg-[var(--panel)] px-2 py-2 text-xs" />
      <textarea aria-label="Exact message for approval" value={message} onChange={(event)=>setMessage(event.target.value)} maxLength={5000} rows={3} placeholder="Exact message text to put in the approval record" className="rounded border border-[var(--border-1)] bg-[var(--panel)] px-2 py-2 text-xs" />
      <button type="submit" disabled={busy||!selectedGrant||!destination.trim()||!message.trim()} className="justify-self-start rounded border border-[var(--border-1)] px-3 py-2 text-xs disabled:opacity-50">Request approval record</button>
    </form>
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <div><h4 className="mb-2 text-xs font-semibold">Conversation grants</h4><ul className="space-y-2">{grants.map((grant)=><li key={grant.grantId} className="flex items-center justify-between gap-2 rounded bg-[var(--panel)] p-2 text-[11px]"><span className="min-w-0 truncate">{grant.conversationId} · {grant.sessionId} · {grant.status}</span>{grant.status==="active"?<button type="button" disabled={busy} onClick={()=>void mutate(()=>api(`/api/reason-network/grants/${encodeURIComponent(grant.grantId)}`,{method:"DELETE"}))} className="text-[var(--destructive)]">Revoke</button>:null}</li>)}</ul>{grants.length===0?<p className="text-[11px] text-[var(--muted-foreground-2)]">No local grants.</p>:null}</div>
      <div><h4 className="mb-2 text-xs font-semibold">Pending exact-message approvals</h4><ul className="space-y-2">{approvals.map((approval)=><li key={approval.approvalId} className="rounded bg-[var(--panel)] p-2 text-[11px]"><p className="font-medium">To: {approval.destination} · expires {new Date(approval.expiresAt).toLocaleString()}</p><p className="mt-1 whitespace-pre-wrap break-words">{approval.message}</p><div className="mt-2 flex gap-2"><button type="button" disabled={busy} onClick={()=>void mutate(()=>api(`/api/reason-network/approvals/${encodeURIComponent(approval.approvalId)}`,{method:"POST",body:JSON.stringify({approved:true})}))} className="rounded border border-[var(--border-1)] px-2 py-1">Approve record</button><button type="button" disabled={busy} onClick={()=>void mutate(()=>api(`/api/reason-network/approvals/${encodeURIComponent(approval.approvalId)}`,{method:"POST",body:JSON.stringify({approved:false})}))} className="rounded border border-[var(--border-1)] px-2 py-1">Deny</button></div></li>)}</ul>{approvals.length===0?<p className="text-[11px] text-[var(--muted-foreground-2)]">No pending approvals.</p>:null}</div>
    </div>
  </section>;
}
