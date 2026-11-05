/** Parent-only one-use capabilities. The INTERNAL_SIGNING_KEY never reaches the gateway. */
import { digest, readRequestDigest, boundedBody, type ReadRequest, type GatewayReadReceipt } from "@shiba/openconnector-read-gateway";
import type { Env } from "./env.js";
import { automaticAvailability, automaticGrantGuard, automaticContract, type AutomaticGrantRow, type AutomaticStepRow, type AutomaticOccurrenceRow } from "./founder-auto-read-store.js";
import { FOUNDER_SQL_NOW } from "./founder-connector-context.js";
import { WorkspaceIntegrationError } from "./workspace-integrations-store.js";
type Stage="claim"|"dispatch"|"complete";
interface Capability {format:"shiba.auto-read.cap.v1";stage:Stage;stepId:string;nonce:string;requestDigest:string;expiresAt:number}
const encoder=new TextEncoder(),domain="shiba:auto-read-capability:v1\n";
function encode(bytes:Uint8Array){let text="";for(const b of bytes)text+=String.fromCharCode(b);return btoa(text).replaceAll("+","-").replaceAll("/","_").replace(/=+$/u,"");}
function decode(text:string){if(!/^[A-Za-z0-9_-]+$/.test(text))throw new Error("invalid");const raw=atob(text.replaceAll("-","+").replaceAll("_","/"));return Uint8Array.from(raw,c=>c.charCodeAt(0));}
async function key(env:Env){if(!env.INTERNAL_SIGNING_KEY||env.INTERNAL_SIGNING_KEY.length<32)throw new WorkspaceIntegrationError("automatic_read_authority_unavailable",503);return crypto.subtle.importKey("raw",encoder.encode(env.INTERNAL_SIGNING_KEY),{name:"HMAC",hash:"SHA-256"},false,["sign","verify"]);}
async function seal(env:Env,payload:Capability){const encoded=encode(encoder.encode(JSON.stringify(payload))),signature=await crypto.subtle.sign("HMAC",await key(env),encoder.encode(domain+encoded));return`${encoded}.${encode(new Uint8Array(signature))}`;}
export async function mintAutomaticReadCapabilities(env:Env,input:Omit<ReadRequest,"capabilities">,nonce:string){
  const bound={...input,capabilities:{claim:"unused",dispatch:"unused",complete:"unused"}},requestDigest=await readRequestDigest(bound);
  const base={format:"shiba.auto-read.cap.v1" as const,stepId:input.stepId,nonce,requestDigest,expiresAt:input.expiresAt};
  return{requestDigest,capabilities:{claim:await seal(env,{...base,stage:"claim"}),dispatch:await seal(env,{...base,stage:"dispatch"}),complete:await seal(env,{...base,stage:"complete"})}};
}
async function verify(env:Env,wire:unknown,stage:Stage,requestDigest:string):Promise<Capability>{
  try{if(typeof wire!=="string"||wire.length>4096)throw new Error("invalid");const parts=wire.split(".");if(parts.length!==2)throw new Error("invalid");
    const payload=decode(parts[0]!),signature=decode(parts[1]!);if(payload.length>2048||signature.length!==32||!await crypto.subtle.verify("HMAC",await key(env),signature,encoder.encode(domain+parts[0])))throw new Error("invalid");
    const p=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(payload)) as Capability;
    if(!p||Object.keys(p).sort().join(",")!=="expiresAt,format,nonce,requestDigest,stage,stepId"||p.format!=="shiba.auto-read.cap.v1"||p.stage!==stage||p.requestDigest!==requestDigest||!/^[A-Za-z0-9_:-]{1,200}$/.test(p.stepId)||!/^[a-f0-9]{64}$/.test(p.nonce)||!Number.isSafeInteger(p.expiresAt)||p.expiresAt<=Date.now()||p.expiresAt>Date.now()+60000)throw new Error("invalid");return p;
  }catch{throw new WorkspaceIntegrationError("automatic_read_capability_denied",403);}
}
function parseReceipt(value:unknown,input:Omit<ReadRequest,"capabilities">):GatewayReadReceipt{
  const row=value as GatewayReadReceipt;
  const expected=["format","stepId","stepDigest","versionId","manifestDigest","operationId","state","capturedAt","bytes","resultJson","resultDigest","error","sourceKind","captureCompleteness","datasetCompleteness","businessSuccess"];
  if(!row||typeof row!=="object"||Array.isArray(row)||Object.keys(row).length!==expected.length||expected.some(k=>!Object.hasOwn(row,k))||row.format!=="shiba.scheduled-read.receipt.v1"||row.stepId!==input.stepId||row.stepDigest!==input.stepDigest||row.versionId!==input.versionId||row.manifestDigest!==input.manifestDigest||row.operationId!==input.operationId||!["completed","failed","unknown"].includes(row.state)||!Number.isSafeInteger(row.capturedAt)||row.capturedAt>Date.now()+5000||!Number.isInteger(row.bytes)||row.bytes<0||row.bytes>input.maxBytes||row.sourceKind!=="bounded-fixed-read"||!["bounded-response","unknown"].includes(row.captureCompleteness)||row.datasetCompleteness!=="unknown"||row.businessSuccess!=="unverified")throw new WorkspaceIntegrationError("automatic_read_receipt_invalid",400);
  if(row.state==="completed"){if(typeof row.resultJson!=="string"||encoder.encode(row.resultJson).length>input.maxBytes||!row.resultDigest||!/^[a-f0-9]{64}$/.test(row.resultDigest)||row.error!==null||row.captureCompleteness!=="bounded-response")throw new WorkspaceIntegrationError("automatic_read_receipt_invalid",400);try{JSON.parse(row.resultJson);}catch{throw new WorkspaceIntegrationError("automatic_read_receipt_invalid",400);}}
  else if(row.resultJson!==null||row.resultDigest!==null||typeof row.error!=="string"||!/^[a-z0-9_]{1,100}$/.test(row.error))throw new WorkspaceIntegrationError("automatic_read_receipt_invalid",400);
  return row;
}
/** Exact endpoint; capability verification happens before touching D1 or feature flags. */
export async function handleFounderAutomaticReadPermit(request:Request,env:Env):Promise<Response|null>{
  const url=new URL(request.url);if(url.pathname!=="/internal/founder-automatic-read/permit")return null;
  const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{"cache-control":"no-store","referrer-policy":"no-referrer"}});
  if(request.method!=="POST"||url.search||!/^application\/json(?:;|$)/i.test(request.headers.get("content-type")??""))return json({error:"automatic_read_capability_denied"},403);
  try{let body:unknown;try{body=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await boundedBody(request.body,80000)));}catch{return json({error:"automatic_read_capability_denied"},403);}
    const b=body as {stage?:Stage;capability?:unknown;requestDigest?:string;receipt?:unknown};
    if(!b||typeof b!=="object"||Array.isArray(b)||!b.stage||!["claim","dispatch","complete"].includes(b.stage)||typeof b.requestDigest!=="string"||!/^[a-f0-9]{64}$/.test(b.requestDigest)||Object.keys(b).some(k=>!["stage","capability","requestDigest",...(b.stage==="complete"?["receipt"]:[])].includes(k)))return json({error:"automatic_read_capability_denied"},403);
    const cap=await verify(env,b.capability,b.stage,b.requestDigest);
    const unavailable=automaticAvailability(env);if(unavailable)throw new WorkspaceIntegrationError(unavailable,503);
    const step=await env.AGENT_AUDIT.prepare("SELECT * FROM founder_automatic_read_steps WHERE id=? AND nonce=? AND request_digest=?").bind(cap.stepId,cap.nonce,cap.requestDigest).first<AutomaticStepRow>();
    if(!step?.request_json||step.expires_at!==cap.expiresAt)throw new WorkspaceIntegrationError("automatic_read_capability_denied",403);
    const input=JSON.parse(step.request_json) as Omit<ReadRequest,"capabilities">;
    if(await readRequestDigest({...input,capabilities:{claim:"unused",dispatch:"unused",complete:"unused"}})!==cap.requestDigest)throw new WorkspaceIntegrationError("automatic_read_capability_denied",403);
    const occurrence=await env.AGENT_AUDIT.prepare("SELECT * FROM founder_automatic_read_occurrences WHERE id=?").bind(step.occurrence_id).first<AutomaticOccurrenceRow>();
    const grant=occurrence?await env.AGENT_AUDIT.prepare("SELECT * FROM founder_automatic_read_grants WHERE id=? AND version=? AND digest=?").bind(occurrence.grant_id,occurrence.grant_version,occurrence.grant_digest).first<AutomaticGrantRow>():null;
    if(!grant||!occurrence||input.grantId!==grant.id||input.grantVersion!==grant.version||input.occurrenceId!==occurrence.id||input.stepDigest!==step.digest||input.principal.id!==`schedule:${grant.id}`||input.principal.kind!=="schedule")throw new WorkspaceIntegrationError("automatic_read_capability_denied",403);
    const contract=automaticContract(grant),source=await automaticGrantGuard(env,grant);
    const context=`${source.sql} AND EXISTS(SELECT 1 FROM founder_automatic_read_occurrences WHERE id=? AND grant_id=? AND grant_version=? AND grant_digest=? AND state IN ('claimed','running') AND expires_at>${FOUNDER_SQL_NOW} AND lease_expires_at>${FOUNDER_SQL_NOW}) AND ?>${FOUNDER_SQL_NOW}`;
    const contextValues=[...source.values,occurrence.id,grant.id,grant.version,grant.digest,cap.expiresAt];
    if(input.versionId!==contract.runtime.versionId||input.manifestDigest!==contract.runtime.manifestDigest||input.expiresAt>occurrence.expires_at||input.maxBytes!==contract.operations[step.ordinal]?.maxBytes)throw new WorkspaceIntegrationError("automatic_read_capability_denied",403);
    if(b.stage==="claim"){
      if(step.state==="completed"&&step.receipt_json){const proof=await env.AGENT_AUDIT.prepare(`SELECT 1 AS current WHERE ${context}`).bind(...contextValues).first();if(!proof)throw new WorkspaceIntegrationError("automatic_read_authority_changed",409);return json({ok:true,receipt:JSON.parse(step.receipt_json)});}
      const changed=await env.AGENT_AUDIT.prepare(`UPDATE founder_automatic_read_steps SET state='claimed',claim_used=1,updated_at=? WHERE id=? AND nonce=? AND request_digest=? AND state='submitted' AND claim_used=0 AND ${context}`).bind(Date.now(),step.id,cap.nonce,cap.requestDigest,...contextValues).run();
      if(changed.meta.changes!==1)throw new WorkspaceIntegrationError("automatic_read_nonce_unconfirmed",409);return json({ok:true});
    }
    if(b.stage==="dispatch"){
      const changed=await env.AGENT_AUDIT.prepare(`UPDATE founder_automatic_read_steps SET state='dispatching',dispatch_used=1,updated_at=? WHERE id=? AND nonce=? AND request_digest=? AND state='claimed' AND claim_used=1 AND dispatch_used=0 AND ${context}`).bind(Date.now(),step.id,cap.nonce,cap.requestDigest,...contextValues).run();
      if(changed.meta.changes!==1)throw new WorkspaceIntegrationError("automatic_read_nonce_unconfirmed",409);return json({ok:true});
    }
    const receipt=parseReceipt(b.receipt,input);if(receipt.resultJson!==null&&await digest(receipt.resultJson)!==receipt.resultDigest)throw new WorkspaceIntegrationError("automatic_read_receipt_invalid",400);
    const changed=await env.AGENT_AUDIT.prepare(`UPDATE founder_automatic_read_steps SET state=?,receipt_json=?,complete_used=1,updated_at=? WHERE id=? AND nonce=? AND request_digest=? AND complete_used=0 AND claim_used=1 AND ((?='completed' AND state='dispatching' AND dispatch_used=1) OR (?<>'completed' AND state IN ('claimed','dispatching'))) AND ${context}`)
      .bind(receipt.state,JSON.stringify(receipt),Date.now(),step.id,cap.nonce,cap.requestDigest,receipt.state,receipt.state,...contextValues).run();
    if(changed.meta.changes!==1)throw new WorkspaceIntegrationError("automatic_read_nonce_unconfirmed",409);return json({ok:true});
  }catch(error){return error instanceof WorkspaceIntegrationError?json({error:error.code},error.status):json({error:"automatic_read_capability_denied"},403);}
}
