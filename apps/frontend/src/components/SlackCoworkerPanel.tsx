import { useEffect,useMemo,useRef,useState,type JSX } from "react";
import { SlackCoworkerClient,type CoworkerDraft,type CoworkerState } from "../slack-coworker-client";
const BUTTON="min-h-11 border border-[var(--line)] bg-[var(--card)] px-3 py-2 text-xs disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]";
const INPUT="min-h-11 max-w-full border border-[var(--input-line)] bg-[var(--card)] px-2 text-[var(--ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]";
interface Props {workspaceId:string;actorId:string;onAdoptTask:(task:string)=>void;client?:SlackCoworkerClient}
export function SlackCoworkerPanel(props:Props):JSX.Element {
  if(!/^ws_[a-f0-9]{24}$/.test(props.workspaceId)||!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(props.actorId)||props.actorId!==props.actorId.toLowerCase())return <p role="status">Select a verified native workspace member.</p>;
  return <ScopedSlackCoworkerPanel key={`${props.workspaceId}:${props.actorId}`} {...props}/>;
}
function ScopedSlackCoworkerPanel({workspaceId,actorId,onAdoptTask,client:provided}:Props):JSX.Element {
  const client=useMemo(()=>provided??new SlackCoworkerClient(workspaceId,actorId),[workspaceId,actorId,provided]);
  const controller=useRef<AbortController|null>(null),epoch=useRef(0),operating=useRef(false);
  const [state,setState]=useState<CoworkerState|null>(null),[drafts,setDrafts]=useState<CoworkerDraft[]>([]),[installationId,setInstallationId]=useState(''),[secret,setSecret]=useState(''),[channelId,setChannelId]=useState(''),[threadTs,setThreadTs]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(true),[uncertain,setUncertain]=useState(false);
  const current=(owner:AbortController,seq:number)=>controller.current===owner&&!owner.signal.aborted&&epoch.current===seq;
  async function refresh(owner:AbortController){if(operating.current)return;operating.current=true;const seq=++epoch.current;setBusy(true);setError('');setState(null);setDrafts([]);
    try{const result=await client.read(owner.signal);if(current(owner,seq)){setState(result.state);setDrafts(result.drafts);setUncertain(false);}}
    catch{if(current(owner,seq))setError('Status could not be verified. Refresh before another action.');}
    finally{if(current(owner,seq)){operating.current=false;setBusy(false);}}}
  // Each client owns one abortable identity scope.
  useEffect(()=>{const owner=new AbortController();controller.current=owner;operating.current=false;void refresh(owner);return()=>{owner.abort();if(controller.current===owner)controller.current=null;};},[client]);
  async function act(work:(signal:AbortSignal,owner:AbortController,seq:number)=>Promise<void>){const owner=controller.current;if(!owner||owner.signal.aborted||operating.current||uncertain)return;
    operating.current=true;const seq=++epoch.current;setBusy(true);setError('');
    try{await work(owner.signal,owner,seq);if(current(owner,seq)){operating.current=false;await refresh(owner);}}
    catch{if(current(owner,seq)){setState(null);setDrafts([]);setSecret('');setUncertain(true);setError('The action outcome was not confirmed. Refresh and inspect status before a new decision; nothing is retried automatically.');}}
    finally{if(current(owner,seq)){operating.current=false;setBusy(false);}}}
  return <section aria-label="Slack coworker" className="min-w-0 space-y-3 border border-[var(--line)] bg-[var(--paper)] p-4 text-sm text-[var(--ink)]">
    <h3 className="text-base font-semibold">Slack coworker</h3><p className="text-xs text-[var(--ink-2)]">Link your native account and review your own Slack statements as private drafts. Slack identity does not grant source access, provider funding, or execution.</p>
    {error&&<p role="alert">{error}</p>}<p className="break-all text-xs">Workspace {workspaceId} · Member {actorId}</p>
    <label>Managed installation ID <input className={INPUT} value={installationId} disabled={busy||uncertain} onChange={e=>setInstallationId(e.target.value)}/></label>{' '}
    <button type="button" className={BUTTON} disabled={busy||uncertain} onClick={()=>void act(async(signal,owner,seq)=>{const result=await client.begin(installationId,signal);if(current(owner,seq))setSecret(result.secret);})}>Begin identity link</button>
    {secret&&<p className="break-all">In Slack, enter <code>/shiba-link {secret}</code> as a slash command, then accept the named native account in Slack. This secret is shown once; do not post it as a message.</p>}
    <button type="button" className={BUTTON} disabled={busy} onClick={()=>{if(controller.current)void refresh(controller.current);}}>Refresh</button>
    {state?.challenges.map(c=><div key={c.id}><p>Slack team {c.teamId}, user {c.slackUserId}. Check that this is your exact Slack user ID before confirming.</p><button type="button" className={BUTTON} disabled={busy||uncertain} onClick={()=>void act(async(signal,owner,seq)=>{await client.confirm(c,signal);if(current(owner,seq))setSecret('');})}>Confirm this identity</button></div>)}
    {state?.bindings.map(b=><div key={b.id} className="space-y-2 border border-[var(--line)] p-3"><p>Linked: team {b.teamId}, Slack user {b.slackUserId}</p><button type="button" className={BUTTON} disabled={busy||uncertain} onClick={()=>void act(async(signal)=>{await client.revoke('/revoke',b.id,signal);})}>Revoke identity</button>{' '}
      <label>Channel ID <input className={INPUT} disabled={busy||uncertain} value={channelId} onChange={e=>setChannelId(e.target.value)}/></label>{' '}<label>Thread timestamp <input className={INPUT} disabled={busy||uncertain} value={threadTs} onChange={e=>setThreadTs(e.target.value)}/></label>{' '}
      <button type="button" className={BUTTON} disabled={busy||uncertain} onClick={()=>void act(async(signal)=>{await client.grant(b.id,channelId,threadTs,signal);})}>Allow my future mentions in this thread for 24 hours</button></div>)}
    {state?.grants.map(g=><p key={g.id}>Intake: {g.teamId} / {g.channelId} / {g.threadTs}, expires {new Date(g.expiresAt).toLocaleString()}. <button type="button" className={BUTTON} disabled={busy||uncertain} onClick={()=>void act(async(signal)=>{await client.revoke('/intake/revoke',g.id,signal);})}>Revoke intake</button></p>)}
    {drafts.map(d=><article key={d.id} className="min-w-0 border border-[var(--line)] p-3"><p>Untrusted statement by {d.slackUserId} in {d.teamId} / {d.channelId} / {d.threadTs} · message {d.messageTs} · event {d.eventId}:</p><blockquote className="whitespace-pre-wrap break-words">{d.text}</blockquote><button type="button" className={BUTTON} disabled={busy||uncertain} onClick={()=>void act(async(signal,owner,seq)=>{const adopted=await client.adopt(d,signal);if(current(owner,seq))onAdoptTask(adopted.text);})}>Review in task composer</button></article>)}
    <p className="text-xs text-[var(--ink-2)]">Choose the task target, employee, provider and funding in the native composer. Review and approve each action there. No Slack reply is sent automatically.</p>
  </section>;
}
