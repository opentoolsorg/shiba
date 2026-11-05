import { useEffect,useMemo,useRef,useState,type JSX } from "react";
import { SLACK_BOT_SCOPES,type SlackInstallationPublic,type SlackInstallationState } from "@shiba/shared";
import { SlackInstallationsClient } from "../slack-installations-client";

const BUTTON="min-h-11 border border-[var(--line)] bg-[var(--card)] px-3 py-2 text-xs disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]";
const scopeLabels:Record<(typeof SLACK_BOT_SCOPES)[number],string>={"chat:write":"Post reviewed messages (required)","app_mentions:read":"Receive mentions","commands":"Receive slash commands","chat:write.customize":"Show specialist personas","channels:history":"Read permitted public-channel context","groups:history":"Read permitted private-channel context","im:history":"Read permitted direct-message context","mpim:history":"Read permitted group-DM context"};
interface Props { workspaceId:string;actorId:string;client?:SlackInstallationsClient }
export function SlackInstallationsPanel(props:Props):JSX.Element{
  if(!/^ws_[a-f0-9]{24}$/.test(props.workspaceId)||!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(props.actorId)||props.actorId!==props.actorId.toLowerCase())return <p role="status">Select a verified native workspace owner before Slack setup.</p>;
  return <ScopedPanel key={`${props.workspaceId}:${props.actorId}`} {...props}/>;
}
function ScopedPanel({workspaceId,actorId,client:provided}:Props):JSX.Element {
  const client=useMemo(()=>provided??new SlackInstallationsClient(workspaceId,actorId),[workspaceId,actorId,provided]);
  const controller=useRef<AbortController|null>(null),operating=useRef(false),epoch=useRef(0);
  const [state,setState]=useState<SlackInstallationState|null>(null),[busy,setBusy]=useState(true),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const [scopes,setScopes]=useState<(typeof SLACK_BOT_SCOPES)[number][]>(["chat:write"]),[consent,setConsent]=useState(false),[attempted,setAttempted]=useState(false);
  const [authorization,setAuthorization]=useState<{authorizationUrl:string;expiresAt:number}|null>(null),[now,setNow]=useState(Date.now());
  const current=(owned:AbortController,sequence:number)=>controller.current===owned&&!owned.signal.aborted&&epoch.current===sequence;
  const read=async(owned:AbortController)=>{const sequence=++epoch.current;setState(null);setAuthorization(null);setNotice("");setBusy(true);setError("");
    try{const result=await client.read(owned.signal);if(current(owned,sequence))setState(result);}catch{if(current(owned,sequence)){setState(null);setError("Slack setup status is unavailable. Check your current verified workspace-owner access and operator configuration.");}}
    finally{if(current(owned,sequence))setBusy(false);}};
  // biome-ignore lint/correctness/useExhaustiveDependencies: Each exact client owns one abortable scope and its cached identity.
  useEffect(()=>{const owned=new AbortController();controller.current=owned;operating.current=false;setAttempted(false);setConsent(false);void read(owned);
    return()=>{owned.abort();if(controller.current===owned)controller.current=null;};},[client]);
  useEffect(()=>{if(!authorization)return;const timer=setInterval(()=>setNow(Date.now()),1_000);return()=>clearInterval(timer);},[authorization]);
  const begin=async()=>{const owned=controller.current;if(!owned||owned.signal.aborted||!state?.available||busy||operating.current||!consent||attempted)return;
    operating.current=true;setBusy(true);setAttempted(true);setError("");setAuthorization(null);const sequence=++epoch.current;
    try{const result=await client.begin({requestId:crypto.randomUUID(),scopes,consent:"install-bot-in-selected-slack-workspace"},owned.signal);if(current(owned,sequence)){setAuthorization(result);setNow(Date.now());setNotice("Authorization prepared. Open Slack only if you want to install this bot with the listed scopes.");}}
    catch{if(current(owned,sequence)){setState(null);setConsent(false);setNotice("");setError("Authorization was not confirmed. Refresh installation status before starting a new explicit request; nothing is retried automatically.");}}
    finally{if(current(owned,sequence)){operating.current=false;setBusy(false);}}};
  const decide=async(action:"activate"|"revoke"|"refresh",row:SlackInstallationPublic)=>{const owned=controller.current;if(!owned||owned.signal.aborted||busy||operating.current)return;
    operating.current=true;setBusy(true);setError("");setAuthorization(null);const sequence=++epoch.current;
    try{const result=await client.decide(action,row,owned.signal);if(current(owned,sequence)){setState(result);setNotice(action==="activate"?"Local bot installation activated. Employee execution still needs its own native identity and provider/billing grant.":action==="revoke"?"Local use disabled. This does not uninstall the app in Slack.":"Token revision refreshed. Previous reviewed send snapshots cannot follow it automatically.");}}
    catch{if(current(owned,sequence)){setState(null);setError("This installation action was not confirmed. Refresh and inspect its status before another action; uncertain exchanges are not retried.");}}
    finally{if(current(owned,sequence)){operating.current=false;setBusy(false);}}};
  const refresh=()=>{if(operating.current||!controller.current)return;setConsent(false);void read(controller.current);};
  return <section aria-label="Workspace Slack installations" className="min-w-0 space-y-3 border border-[var(--line)] bg-[var(--paper)] p-4 text-sm text-[var(--ink)]">
    <h3 className="text-base font-semibold">Slack workspace installations</h3>
    <p className="text-xs text-[var(--ink-2)]">Install a bot for this workspace using your verified native owner account. Each installation needs a separate review before activation. Installation does not grant employee execution, provider billing or private context access.</p>
    <p className="break-all text-xs">Workspace {workspaceId} · Owner {actorId}</p>
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {!busy&&state&&!state.available&&<p role="status">Unavailable: the operator must configure the Slack app, existing PKCE setting, verified query-log privacy and encrypted token keyring. This panel creates no credentials or app configuration.</p>}
    {busy&&!state&&<p role="status">Checking Slack setup…</p>}
    <fieldset disabled={busy||!state?.available||attempted} className="space-y-2"><legend className="text-xs font-semibold">Bot permissions to request</legend>
      {SLACK_BOT_SCOPES.map((scope)=><label key={scope} className="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" checked={scopes.includes(scope)} disabled={scope==="chat:write"} onChange={(event)=>{setScopes((previous)=>event.target.checked?[...previous,scope]:previous.filter((item)=>item!==scope));setConsent(false);setAuthorization(null);}}/>{scopeLabels[scope]} <code className="break-all">{scope}</code></label>)}
      <label className="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" checked={consent} onChange={(event)=>setConsent(event.target.checked)}/>I reviewed these bot scopes and choose to authorize installation in Slack. This does not approve messages, model calls or employee work.</label>
      <button type="button" className={BUTTON} disabled={busy||!state?.available||!consent||attempted} onClick={()=>void begin()}>Prepare Slack authorization</button>
    </fieldset>
    {authorization&&authorization.expiresAt>now&&<a href={authorization.authorizationUrl} target="_blank" rel="noopener noreferrer" className={`${BUTTON} inline-flex max-w-full items-center`}>Open Slack authorization</a>}
    {authorization&&authorization.expiresAt<=now&&<p role="status">This authorization link expired. Refresh status before a new explicit request.</p>}
    {attempted&&<button type="button" className={BUTTON} disabled={busy} onClick={()=>{setAuthorization(null);setAttempted(false);setConsent(false);setNotice("Review the scopes again before preparing a new authorization request.");}}>Review a new authorization request</button>}
    <button type="button" className={BUTTON} disabled={busy} onClick={refresh}>Refresh installation status</button>
    {state?.installations.map((row)=><InstallationRow key={`${row.id}:${row.version}:${row.digest}:${row.state}`} row={row} busy={busy} decide={decide}/>)}
    {state&&state.installations.length===0&&<p className="text-xs">No installation is stored for this native owner in this workspace.</p>}
    <p className="text-xs text-[var(--ink-2)]">Enterprise/GovSlack and user-token installations are unavailable. Token status is local metadata; live OAuth and Slack delivery require an authorized configured environment.</p>
  </section>;
}
function InstallationRow({row,busy,decide}:{row:SlackInstallationPublic;busy:boolean;decide:(action:"activate"|"revoke"|"refresh",row:SlackInstallationPublic)=>Promise<void>}):JSX.Element {
  const [reviewed,setReviewed]=useState(false),[attempted,setAttempted]=useState(false),[now,setNow]=useState(Date.now());
  useEffect(()=>{if(row.state!=="pending")return;const timer=setInterval(()=>setNow(Date.now()),1_000);return()=>clearInterval(timer);},[row.state]);
  const act=(action:"activate"|"revoke"|"refresh")=>{if(!reviewed||attempted||busy)return;setAttempted(true);void decide(action,row);};
  return <article className="min-w-0 space-y-2 border border-[var(--line)] p-3 text-xs">
    <h4 className="break-all font-semibold">{row.teamId} · {row.state}</h4><p className="break-all">App {row.appId} · Bot {row.botUserId}/{row.botId} · Installation {row.id}</p>
    <p>Generation {row.generation} · Version {row.version} · Token revision {row.tokenRevision}</p><p className="break-all">Scopes: {row.scopes.join(", ")}</p>
    <p className="break-all">Review digest: <code>{row.digest}</code></p><p>Activation deadline: {new Date(row.activationExpiresAt).toISOString()}</p>
    {row.expiresAt&&<p>Access-token expiry: {new Date(row.expiresAt).toISOString()}</p>}
    <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={reviewed} disabled={busy||attempted} onChange={(event)=>setReviewed(event.target.checked)}/>I reviewed this exact team, app, bot, scopes and installation revision.</label>
    <div className="flex flex-wrap gap-2">{row.canActivate&&<button type="button" className={BUTTON} disabled={busy||!reviewed||attempted||now>=row.activationExpiresAt} onClick={()=>act("activate")}>Activate reviewed installation</button>}
      {row.canRefresh&&<button type="button" className={BUTTON} disabled={busy||!reviewed||attempted} onClick={()=>act("refresh")}>Refresh reviewed token</button>}
      {row.canRevoke&&<button type="button" className={BUTTON} disabled={busy||!reviewed||attempted} onClick={()=>act("revoke")}>Disable in Shiba</button>}</div>
    {attempted&&<p role="status">Decision attempted once. Refresh status if the outcome is uncertain.</p>}
  </article>;
}
