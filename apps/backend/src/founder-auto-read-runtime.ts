import { defaultReadToken, scopedGoogleReadToken, verifiedGoogleReadToken } from "./founder-auto-read-keys.js";
import { founderAutomaticReadReportHash, type FounderAutomaticReadReport } from "@shiba/shared";
import { hash, boundedBody, type ReadRequest, type GatewayReadReceipt } from "@shiba/openconnector-read-gateway";
import type { Env } from "./env.js";
import type { WorkspaceNativeMember } from "./workspace-native-authority.js";
import { automaticAvailability, automaticRuntime, ensureAutomaticReadSchema, automaticContract, automaticPins, automaticPinsGuard, automaticGrantGuard, type AutomaticPins, type AutomaticGrantRow, type AutomaticOccurrenceRow, type AutomaticStepRow } from "./founder-auto-read-store.js";
import { mintAutomaticReadCapabilities } from "./founder-auto-read-permits.js";
import { FOUNDER_SQL_NOW } from "./founder-connector-context.js";
import { nextFounderReviewDue } from "./founder-review-schedules.js";
import { openConnectorWorkspaceConnectionName } from "./integrations/openconnector-provider.js";
import { membershipSql, WorkspaceIntegrationError } from "./workspace-integrations-store.js";
import { founderConnectorRecipeHash } from "./founder-connector-context.js";
const utf8=(s:string)=>new TextEncoder().encode(s).length;
async function unknown(env:Env,grant:AutomaticGrantRow,occurrence:AutomaticOccurrenceRow,reason:string){
  await env.AGENT_AUDIT.batch([
    env.AGENT_AUDIT.prepare("UPDATE founder_automatic_read_steps SET state='unknown',updated_at=? WHERE occurrence_id=? AND state IN ('pending','submitted','claimed','dispatching')").bind(Date.now(),occurrence.id),
    env.AGENT_AUDIT.prepare("UPDATE founder_automatic_read_occurrences SET state='unknown',error=?,updated_at=? WHERE id=? AND state IN ('claimed','running')").bind(reason,Date.now(),occurrence.id),
    env.AGENT_AUDIT.prepare("UPDATE founder_automatic_read_grants SET state='blocked',blocked_reason=?,updated_at=? WHERE id=? AND version=? AND state='enabled'").bind(reason,Date.now(),grant.id,grant.version),
  ]);
}
export async function tickFounderAutomaticReads(env:Env):Promise<{created:number;completed:number;blocked:number;unavailable:string|null}>{
  const availability=automaticAvailability(env);if(availability)return{created:0,completed:0,blocked:0,unavailable:availability};
  await ensureAutomaticReadSchema(env);
  const rows=await env.AGENT_AUDIT.prepare("SELECT * FROM founder_automatic_read_grants WHERE state='enabled' ORDER BY checked_at,id LIMIT 2").all<AutomaticGrantRow>();let created=0,completed=0,blocked=0;
  for(const grant of rows.results){const contract=automaticContract(grant),pins=automaticPins(grant),now=Date.now(),source=await automaticGrantGuard(env,grant);
    const active=await env.AGENT_AUDIT.prepare("SELECT * FROM founder_automatic_read_occurrences WHERE grant_id=? AND grant_version=? AND state IN ('claimed','running','unknown') ORDER BY created_at DESC LIMIT 1").bind(grant.id,grant.version).first<AutomaticOccurrenceRow>();
    if(active){
      const terminal=await env.AGENT_AUDIT.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN state IN ('completed','failed') AND receipt_json IS NOT NULL THEN 1 ELSE 0 END) AS terminal FROM founder_automatic_read_steps WHERE occurrence_id=?").bind(active.id).first<{total:number;terminal:number}>();
      if(active.state==="running"&&terminal?.total===active.step_count&&terminal.terminal===active.step_count){
        // Reconstruct from verified durable receipts only. Never extend a lease or resend a read.
        try{if(await settleAutomaticReport(env,grant,active.id,active.lease_id??""))completed++;}catch{const valid=await env.AGENT_AUDIT.prepare(`SELECT 1 AS current WHERE ${source.sql}`).bind(...source.values).first();if(!valid){await unknown(env,grant,active,"automatic_read_authority_changed");blocked++;}}
      }else if(active.state==="unknown"||(active.lease_expires_at??0)<=Date.now()){await unknown(env,grant,active,"automatic_read_recovery_unknown");blocked++;}
      continue;
    }
    const google=pins.sources.find(item=>item.operationId==="googleads.campaign_daily_metrics");
    let live:Awaited<ReturnType<typeof automaticRuntime>>;
    try{const token=google?await verifiedGoogleReadToken(env,grant.workspace_id,google.binding.connectionId,google.runtimeKeyFingerprint):defaultReadToken(env);live=await automaticRuntime(env,token);}
    catch{await env.AGENT_AUDIT.prepare("UPDATE founder_automatic_read_grants SET state='blocked',blocked_reason='automatic_read_runtime_unattested',checked_at=? WHERE id=? AND version=? AND state='enabled'").bind(Date.now(),grant.id,grant.version).run();blocked++;continue;}
    const current=await env.AGENT_AUDIT.prepare(`SELECT 1 AS current WHERE ${source.sql}`).bind(...source.values).first();
    if(!current||JSON.stringify(contract.runtime)!==JSON.stringify(live.runtime)){await env.AGENT_AUDIT.prepare("UPDATE founder_automatic_read_grants SET state='blocked',blocked_reason='automatic_read_authority_changed',checked_at=? WHERE id=? AND version=? AND state='enabled'").bind(Date.now(),grant.id,grant.version).run();blocked++;continue;}
    if(grant.used_occurrences>=contract.maxOccurrences||grant.reserved_calls+contract.operations.length>contract.maxCalls||grant.reserved_bytes+contract.maxBytesPerOccurrence>contract.maxCapturedBytes){await env.AGENT_AUDIT.prepare("UPDATE founder_automatic_read_grants SET state='exhausted',checked_at=? WHERE id=? AND version=? AND state='enabled'").bind(Date.now(),grant.id,grant.version).run();continue;}
    if(grant.next_due_at>now){await env.AGENT_AUDIT.prepare("UPDATE founder_automatic_read_grants SET checked_at=? WHERE id=? AND version=?").bind(now,grant.id,grant.version).run();continue;}
    const next=nextFounderReviewDue(contract,Date.now());
    // Missed occurrences coalesce. A delayed scheduler never catches up with a batch of provider reads.
    if(now-grant.next_due_at>900000){await env.AGENT_AUDIT.prepare("UPDATE founder_automatic_read_grants SET next_due_at=?,checked_at=? WHERE id=? AND version=? AND next_due_at=?").bind(next,now,grant.id,grant.version,grant.next_due_at).run();continue;}
    const occurrenceId=`${grant.id}:${grant.version}:${grant.next_due_at}`,leaseId=crypto.randomUUID(),leaseExpiry=Math.min(contract.expiresAt,now+contract.maxOccurrenceMs),expiry=Math.min(contract.expiresAt,grant.next_due_at+86400000);
    const stepData=await Promise.all(pins.sources.map(async(source,index)=>{const nonce=(await hash([crypto.randomUUID(),crypto.randomUUID()]));return{id:`${occurrenceId}:${index}`,ordinal:index,nonce,digest:await hash({grantId:grant.id,grantVersion:grant.version,grantDigest:grant.digest,occurrenceId,ordinal:index,source,nonce})};}));
    const claimed=await env.AGENT_AUDIT.batch([
      env.AGENT_AUDIT.prepare(`UPDATE founder_automatic_read_grants SET used_occurrences=used_occurrences+1,reserved_calls=reserved_calls+?,reserved_bytes=reserved_bytes+?,next_due_at=?,checked_at=?,updated_at=? WHERE id=? AND version=? AND digest=? AND state='enabled' AND next_due_at=? AND used_occurrences<? AND reserved_calls+?<=? AND reserved_bytes+?<=? AND ${source.sql} AND NOT EXISTS(SELECT 1 FROM founder_automatic_read_occurrences WHERE grant_id=? AND state IN ('claimed','running','unknown'))`).bind(pins.sources.length,contract.maxBytesPerOccurrence,next,now,now,grant.id,grant.version,grant.digest,grant.next_due_at,contract.maxOccurrences,pins.sources.length,contract.maxCalls,contract.maxBytesPerOccurrence,contract.maxCapturedBytes,...source.values,grant.id),
      env.AGENT_AUDIT.prepare("INSERT OR IGNORE INTO founder_automatic_read_occurrences(id,grant_id,grant_version,grant_digest,scheduled_at,expires_at,state,step_count,lease_id,lease_expires_at,created_at,updated_at) SELECT ?,?,?,?,?,?,'claimed',?,?,?,?,? WHERE changes()=1").bind(occurrenceId,grant.id,grant.version,grant.digest,grant.next_due_at,expiry,pins.sources.length,leaseId,leaseExpiry,now,now),
      ...stepData.map(step=>env.AGENT_AUDIT.prepare("INSERT OR IGNORE INTO founder_automatic_read_steps(id,occurrence_id,ordinal,nonce,digest,state,updated_at) SELECT ?,?,?,?,?,'pending',? WHERE EXISTS(SELECT 1 FROM founder_automatic_read_occurrences WHERE id=? AND lease_id=? AND state='claimed')").bind(step.id,occurrenceId,step.ordinal,step.nonce,step.digest,now,occurrenceId,leaseId)),
    ]);
    if(claimed[0]?.meta.changes!==1)continue;created++;
    const occurrence=await env.AGENT_AUDIT.prepare("SELECT * FROM founder_automatic_read_occurrences WHERE id=? AND lease_id=?").bind(occurrenceId,leaseId).first<AutomaticOccurrenceRow>();if(!occurrence)continue;
    let allTerminal=false;
    try{
      await env.AGENT_AUDIT.prepare("UPDATE founder_automatic_read_occurrences SET state='running',updated_at=? WHERE id=? AND lease_id=? AND state='claimed'").bind(Date.now(),occurrenceId,leaseId).run();
      for(const data of stepData){if(Date.now()>=leaseExpiry)throw new Error("automatic_read_deadline_unknown");
        const selected=pins.sources[data.ordinal]!,policy=contract.operations[data.ordinal]!,capExpiry=Math.min(Date.now()+15000,leaseExpiry);
        const request:Omit<ReadRequest,"capabilities">={format:"shiba.scheduled-read.v1",versionId:contract.runtime.versionId,manifestDigest:contract.runtime.manifestDigest,grantId:grant.id,grantVersion:grant.version,occurrenceId,stepId:data.id,stepDigest:data.digest,principal:{kind:"schedule",id:`schedule:${grant.id}`},workspaceId:grant.workspace_id,alias:await openConnectorWorkspaceConnectionName(grant.workspace_id),connectionId:selected.binding.connectionId,providerConnectionId:selected.binding.providerConnectionId,authorizationFingerprint:selected.binding.fingerprint,operationId:selected.operationId,arguments:selected.arguments,...(selected.sourceFingerprint?{sourceFingerprint:selected.sourceFingerprint}:{}),expiresAt:capExpiry,maxBytes:policy.maxBytes,maxDurationMs:contract.maxStepMs};
        const readToken=selected.operationId==="googleads.campaign_daily_metrics"?await verifiedGoogleReadToken(env,grant.workspace_id,selected.binding.connectionId,selected.runtimeKeyFingerprint):defaultReadToken(env);
        const signed=await mintAutomaticReadCapabilities(env,request,data.nonce),finalSource=await automaticGrantGuard(env,grant);
        const submitted=await env.AGENT_AUDIT.prepare(`UPDATE founder_automatic_read_steps SET state='submitted',request_json=?,request_digest=?,expires_at=?,updated_at=? WHERE id=? AND nonce=? AND state='pending' AND ${finalSource.sql} AND ?>${FOUNDER_SQL_NOW} AND EXISTS(SELECT 1 FROM founder_automatic_read_occurrences WHERE id=? AND lease_id=? AND state='running' AND lease_expires_at>${FOUNDER_SQL_NOW})`).bind(JSON.stringify(request),signed.requestDigest,capExpiry,Date.now(),data.id,data.nonce,...finalSource.values,capExpiry,occurrenceId,leaseId).run();
        if(submitted.meta.changes!==1)throw new Error("automatic_read_authority_changed");
        if(selected.operationId==="googleads.campaign_daily_metrics" && scopedGoogleReadToken(env,grant.workspace_id,selected.binding.connectionId)!==readToken)throw new Error("automatic_read_runtime_changed");
        try{const response=await env.OPEN_CONNECTOR_READ_GATEWAY!.fetch("https://read-gate.internal/v1/shiba/read-gate/execute",{method:"POST",redirect:"manual",headers:{authorization:`Bearer ${readToken}`,"content-type":"application/json"},body:JSON.stringify({...request,capabilities:signed.capabilities}),signal:AbortSignal.timeout(Math.max(1,Math.min(15000,leaseExpiry-Date.now())))});await boundedBody(response.body,80000);}catch{/* The durable parent receipt is authoritative; never resend this request. */}
        const receipt=await env.AGENT_AUDIT.prepare("SELECT * FROM founder_automatic_read_steps WHERE id=? AND request_digest=?").bind(data.id,signed.requestDigest).first<AutomaticStepRow>();
        if(!receipt||!["completed","failed"].includes(receipt.state))throw new Error("automatic_read_outcome_unknown");
      }
      allTerminal=true;if(await settleAutomaticReport(env,grant,occurrenceId,leaseId))completed++;
    }catch{if(allTerminal){await env.AGENT_AUDIT.prepare("UPDATE founder_automatic_read_occurrences SET error='automatic_read_report_settlement_pending',updated_at=? WHERE id=? AND state='running'").bind(Date.now(),occurrenceId).run();}else{await unknown(env,grant,occurrence,"automatic_read_outcome_unknown");blocked++;}}
  }
  return{created,completed,blocked,unavailable:null};
}
async function settleAutomaticReport(env:Env,grant:AutomaticGrantRow,occurrenceId:string,leaseId:string){
  const rows=await env.AGENT_AUDIT.prepare("SELECT * FROM founder_automatic_read_steps WHERE occurrence_id=? ORDER BY ordinal").bind(occurrenceId).all<AutomaticStepRow>(),contract=automaticContract(grant);
  const occurrence=await env.AGENT_AUDIT.prepare("SELECT * FROM founder_automatic_read_occurrences WHERE id=? AND lease_id=?").bind(occurrenceId,leaseId).first<AutomaticOccurrenceRow>();
  if(!occurrence||rows.results.length!==contract.operations.length||rows.results.some(s=>!["completed","failed"].includes(s.state)))return false;
  const completed=rows.results.filter(s=>s.state==="completed").length,snapshots=rows.results.map(s=>({id:s.id,ordinal:s.ordinal,state:s.state,requestJson:s.request_json,requestDigest:s.request_digest,receiptJson:s.receipt_json}));
  const payload={format:"shiba.automatic-read.report.v1",principal:{kind:"schedule",id:`schedule:${grant.id}`},authorizedBy:grant.owner_id,grantId:grant.id,grantVersion:grant.version,scheduledAt:occurrence.scheduled_at,runtime:contract.runtime,
    notice:"Fixed reads under an explicit standing grant. Captures are bounded; dataset completeness is unknown and business success is unverified. No model, inferred metrics, MRR, churn or freshness claim.",
    sources:rows.results.map(s=>{const policy=contract.operations[s.ordinal]!,receipt=s.receipt_json?JSON.parse(s.receipt_json) as GatewayReadReceipt:null;return{operationId:policy.operationId,connectionId:policy.connectionId,connectionVersion:policy.connectionVersion,arguments:policy.arguments,...(policy.sourceFingerprint?{sourceFingerprint:policy.sourceFingerprint}:{}),inputSchemaHash:policy.inputSchemaHash,executorHash:policy.executorHash,queryHash:policy.queryHash,capturedAt:receipt?.capturedAt??null,capturedBytes:receipt?.bytes??0,state:s.state,requestDigest:s.request_digest,resultDigest:receipt?.resultDigest??null,sourceKind:"standing-scheduled-read",captureCompleteness:receipt?.captureCompleteness??"unknown",datasetCompleteness:"unknown",businessSuccess:"unverified",result:receipt?.resultJson?JSON.parse(receipt.resultJson) as unknown:null,error:receipt?.error??null};})};
  const json=JSON.stringify(payload,null,2)+"\n",markdown=`# Scheduled fixed-read evidence\n\n${payload.notice}\n\n${json.split("\n").map(line=>`    ${line}`).join("\n")}\n`;
  if(utf8(json)+utf8(markdown)>262144)throw new Error("automatic_read_report_limit");
  const reportHash=founderAutomaticReadReportHash({id:occurrenceId,grantId:grant.id,grantVersion:grant.version,expiresAt:occurrence.expires_at,markdown,json}),source=await automaticGrantGuard(env,grant);
  const snapshotJson=JSON.stringify(snapshots),state=completed===rows.results.length?"completed":completed?"partial":"failed";
  const result=await env.AGENT_AUDIT.prepare(`UPDATE founder_automatic_read_occurrences SET state=?,report_hash=?,report_sources_json=?,markdown=?,json=?,updated_at=? WHERE id=? AND lease_id=? AND state='running' AND expires_at>${FOUNDER_SQL_NOW} AND ${source.sql}
    AND NOT EXISTS(SELECT 1 FROM json_each(?) f WHERE NOT EXISTS(SELECT 1 FROM founder_automatic_read_steps s WHERE s.id=json_extract(f.value,'$.id') AND s.occurrence_id=? AND s.state=json_extract(f.value,'$.state') AND s.request_json IS json_extract(f.value,'$.requestJson') AND s.request_digest IS json_extract(f.value,'$.requestDigest') AND s.receipt_json IS json_extract(f.value,'$.receiptJson')))`)
    .bind(state,reportHash,snapshotJson,markdown,json,Date.now(),occurrenceId,leaseId,...source.values,snapshotJson,occurrenceId).run();
  if(result.meta.changes!==1){const existing=await env.AGENT_AUDIT.prepare(`SELECT 1 AS current FROM founder_automatic_read_occurrences WHERE id=? AND grant_id=? AND grant_version=? AND report_hash=? AND markdown=? AND json=? AND report_sources_json=? AND expires_at>${FOUNDER_SQL_NOW} AND ${source.sql}`).bind(occurrenceId,grant.id,grant.version,reportHash,markdown,json,snapshotJson,...source.values).first();if(!existing)throw new Error("automatic_read_report_authority_changed");}
  return state==="completed"||state==="partial";
}
export async function readAutomaticReadReport(env:Env,member:WorkspaceNativeMember,libraryId:string,occurrenceId:string,beforeFinalRead?:()=>Promise<void>):Promise<FounderAutomaticReadReport>{
  await ensureAutomaticReadSchema(env);const actor=membershipSql(member,true),grant=await env.AGENT_AUDIT.prepare(`SELECT * FROM founder_automatic_read_grants WHERE workspace_id=? AND owner_id=? AND owner_account_id=? AND library_id=? AND ${actor.sql}`).bind(member.workspaceId,member.userId,member.accountId,libraryId,...actor.values).first<AutomaticGrantRow>();
  const occurrence=grant?await env.AGENT_AUDIT.prepare("SELECT * FROM founder_automatic_read_occurrences WHERE id=? AND grant_id=? AND grant_version=? AND state IN ('completed','partial','failed')").bind(occurrenceId,grant.id,grant.version).first<AutomaticOccurrenceRow>():null;
  if(!grant||!occurrence?.markdown||!occurrence.json||!occurrence.report_hash||!occurrence.report_sources_json)throw new WorkspaceIntegrationError("automatic_read_report_unavailable",404);
  const expected=founderAutomaticReadReportHash({id:occurrence.id,grantId:grant.id,grantVersion:grant.version,expiresAt:occurrence.expires_at,markdown:occurrence.markdown,json:occurrence.json});if(expected!==occurrence.report_hash)throw new WorkspaceIntegrationError("automatic_read_report_changed",409);
  const source=await automaticGrantGuard(env,grant,false);await beforeFinalRead?.();
  const current=await env.AGENT_AUDIT.prepare(`SELECT 1 AS current FROM founder_automatic_read_occurrences o WHERE o.id=? AND o.grant_id=? AND o.grant_version=? AND o.state IN ('completed','partial','failed') AND o.expires_at>${FOUNDER_SQL_NOW} AND o.report_hash=? AND o.markdown=? AND o.json=? AND o.report_sources_json=? AND ${source.sql} AND EXISTS(SELECT 1 FROM founder_automatic_read_grants WHERE id=? AND state IN ('enabled','exhausted'))
    AND NOT EXISTS(SELECT 1 FROM json_each(?) f WHERE NOT EXISTS(SELECT 1 FROM founder_automatic_read_steps s WHERE s.id=json_extract(f.value,'$.id') AND s.occurrence_id=o.id AND s.state=json_extract(f.value,'$.state') AND s.request_json IS json_extract(f.value,'$.requestJson') AND s.request_digest IS json_extract(f.value,'$.requestDigest') AND s.receipt_json IS json_extract(f.value,'$.receiptJson')))`)
    .bind(occurrence.id,grant.id,grant.version,occurrence.report_hash,occurrence.markdown,occurrence.json,occurrence.report_sources_json,...source.values,grant.id,occurrence.report_sources_json).first();
  if(!current)throw new WorkspaceIntegrationError("automatic_read_report_authority_changed",403);
  return{ok:true,workspaceId:member.workspaceId,libraryId:libraryId as FounderAutomaticReadReport["libraryId"],actorId:member.userId,id:occurrence.id,grantId:grant.id,grantVersion:grant.version,principal:{kind:"schedule",id:`schedule:${grant.id}`},reportHash:occurrence.report_hash,expiresAt:occurrence.expires_at,markdown:occurrence.markdown,json:occurrence.json,sourceKind:"standing-scheduled-read",captureCompleteness:"bounded-response",datasetCompleteness:"unknown",businessSuccess:"unverified",canExport:false};
}

export interface AutomaticReportAuthority {
  principal:{kind:"schedule";id:string};
  /** Human consent reference, never a fabricated logged-in human or execution actor. */
  humanAuthorizer:WorkspaceNativeMember;
  readGrant:AutomaticGrantRow;pins:AutomaticPins;occurrence:AutomaticOccurrenceRow;recipeHashFromCode:string;
  report:FounderAutomaticReadReport;
}
const privateGoogleTokens=new WeakMap<AutomaticReportAuthority,string>();
/** Sync, trusted-server snapshot only. Combine with a separate standing Slack grant immediately before send. */
export function automaticReadReportAuthorityGuard(env:Env,authority:AutomaticReportAuthority){
  const grant=authority.readGrant,contract=automaticContract(grant),o=authority.occurrence,pins=authority.pins;
  if(automaticAvailability(env)||authority.principal.kind!=="schedule"||authority.principal.id!==`schedule:${grant.id}`||authority.recipeHashFromCode!==pins.recipeSha256||contract.runtime.versionId!==env.OPEN_CONNECTOR_READ_VERSION_ID||contract.runtime.manifestDigest!==env.OPEN_CONNECTOR_READ_MANIFEST_SHA256||authority.report.reportHash!==o.report_hash||authority.report.markdown!==o.markdown||authority.report.json!==o.json)return{sql:"0=1",values:[]as unknown[]};
  const google=pins.sources.find(item=>item.operationId==="googleads.campaign_daily_metrics");
  if(google){try{if(!google.runtimeKeyFingerprint||privateGoogleTokens.get(authority)!==scopedGoogleReadToken(env,grant.workspace_id,google.binding.connectionId))return{sql:"0=1",values:[]as unknown[]};}catch{return{sql:"0=1",values:[]as unknown[]};}}
  const source=automaticPinsGuard(pins);
  return{sql:`${source.sql} AND EXISTS(SELECT 1 FROM founder_automatic_read_grants WHERE id=? AND version=? AND digest=? AND contract_json=? AND pins_json=? AND state IN ('enabled','exhausted') AND json_extract(contract_json,'$.expiresAt')>${FOUNDER_SQL_NOW})
    AND EXISTS(SELECT 1 FROM founder_automatic_read_occurrences o WHERE o.id=? AND o.grant_id=? AND o.grant_version=? AND o.grant_digest=? AND o.state IN ('completed','partial','failed') AND o.expires_at>${FOUNDER_SQL_NOW} AND o.expires_at=? AND o.report_hash=? AND o.markdown=? AND o.json=? AND o.report_sources_json=?
      AND NOT EXISTS(SELECT 1 FROM json_each(?) f WHERE NOT EXISTS(SELECT 1 FROM founder_automatic_read_steps s WHERE s.id=json_extract(f.value,'$.id') AND s.occurrence_id=o.id AND s.state=json_extract(f.value,'$.state') AND s.request_json IS json_extract(f.value,'$.requestJson') AND s.request_digest IS json_extract(f.value,'$.requestDigest') AND s.receipt_json IS json_extract(f.value,'$.receiptJson'))))`,
    values:[...source.values,grant.id,grant.version,grant.digest,grant.contract_json,grant.pins_json,o.id,grant.id,grant.version,grant.digest,o.expires_at,o.report_hash,o.markdown,o.json,o.report_sources_json,o.report_sources_json]};
}
/** Scheduler authority remains separate from the human who explicitly consented to these reads. */
export async function loadAutomaticReadReportAuthority(env:Env,input:{kind:"schedule";grantId:string;grantVersion:number;occurrenceId:string}):Promise<AutomaticReportAuthority>{
  if(input.kind!=="schedule")throw new WorkspaceIntegrationError("automatic_report_principal_required",403);
  await ensureAutomaticReadSchema(env);
  const grant=await env.AGENT_AUDIT.prepare("SELECT * FROM founder_automatic_read_grants WHERE id=? AND version=? AND state IN ('enabled','exhausted')").bind(input.grantId,input.grantVersion).first<AutomaticGrantRow>();
  const occurrence=grant?await env.AGENT_AUDIT.prepare("SELECT * FROM founder_automatic_read_occurrences WHERE id=? AND grant_id=? AND grant_version=?").bind(input.occurrenceId,grant.id,grant.version).first<AutomaticOccurrenceRow>():null;
  if(!grant||!occurrence)throw new WorkspaceIntegrationError("automatic_read_report_unavailable",404);
  const pins=automaticPins(grant),report=await readAutomaticReadReport(env,pins.member,grant.library_id,occurrence.id),recipe=await founderConnectorRecipeHash(grant.library_id);
  if(!recipe)throw new WorkspaceIntegrationError("automatic_read_report_authority_changed",403);
  const authority:AutomaticReportAuthority={principal:{kind:"schedule",id:`schedule:${grant.id}`},humanAuthorizer:pins.member,readGrant:grant,pins,occurrence,recipeHashFromCode:recipe,report};
  const google=pins.sources.find(item=>item.operationId==="googleads.campaign_daily_metrics");
  if(google)privateGoogleTokens.set(authority,await verifiedGoogleReadToken(env,grant.workspace_id,google.binding.connectionId,google.runtimeKeyFingerprint));
  const guard=automaticReadReportAuthorityGuard(env,authority);
  if(!await env.AGENT_AUDIT.prepare(`SELECT 1 AS current WHERE ${guard.sql}`).bind(...guard.values).first())throw new WorkspaceIntegrationError("automatic_read_report_authority_changed",403);
  return authority;
}
