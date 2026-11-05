import { abortable, boundedBody, digest, hash } from "./json.js";
import { validateReadArguments, providerRequest } from "./operations.js";
import { GATE_PREFIX, ReadGateError, type GatewayDependencies, type GatewayReadReceipt, type ReadRequest } from "./types.js";
const HEADERS={"cache-control":"no-store","referrer-policy":"no-referrer","x-content-type-options":"nosniff"};
const response=(body:unknown,status=200)=>Response.json(body,{status,headers:HEADERS});
const ID=/^[A-Za-z0-9_:-]{1,200}$/;
const HEX=/^[a-f0-9]{64}$/;
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=="object"||Array.isArray(value))throw new ReadGateError("read_gate_request_invalid",400);return value as Record<string,unknown>;}
function exact(value:Record<string,unknown>,keys:string[]){if(Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))throw new ReadGateError("read_gate_request_invalid",400);}
function text(value:unknown,pattern:RegExp){if(typeof value!=="string"||!pattern.test(value))throw new ReadGateError("read_gate_request_invalid",400);return value;}
export function parseReadRequest(value:unknown):ReadRequest {
  const r=record(value);exact(r,["format","versionId","manifestDigest","grantId","grantVersion","occurrenceId","stepId","stepDigest","principal","workspaceId","alias","connectionId","providerConnectionId","authorizationFingerprint","operationId","arguments",...(r.operationId==="googleads.campaign_daily_metrics"?["sourceFingerprint"]:[]),"expiresAt","maxBytes","maxDurationMs","capabilities"]);
  const p=record(r.principal),c=record(r.capabilities);exact(p,["kind","id"]);exact(c,["claim","dispatch","complete"]);
  if(r.format!=="shiba.scheduled-read.v1"||p.kind!=="schedule"||!Number.isInteger(r.grantVersion)||Number(r.grantVersion)<1||!Number.isSafeInteger(r.expiresAt)||Number(r.expiresAt)<=Date.now()||Number(r.expiresAt)>Date.now()+60000||!Number.isInteger(r.maxBytes)||Number(r.maxBytes)<1024||Number(r.maxBytes)>32768||!Number.isInteger(r.maxDurationMs)||Number(r.maxDurationMs)<100||Number(r.maxDurationMs)>10000)throw new ReadGateError("read_gate_request_invalid",400);
  const operationId=text(r.operationId,/^(figma\.(?:get_file_metadata|list_comments)|linear\.list_issues_by_team_id|github\.list_pull_requests|googleads\.campaign_daily_metrics)$/) as ReadRequest["operationId"];
  const grantId=text(r.grantId,ID);
  if(p.id!==`schedule:${grantId}`)throw new ReadGateError("read_gate_principal_invalid",400);
  return {format:"shiba.scheduled-read.v1",versionId:text(r.versionId,/^[a-f0-9-]{36}$/),manifestDigest:text(r.manifestDigest,HEX),grantId,grantVersion:Number(r.grantVersion),occurrenceId:text(r.occurrenceId,ID),stepId:text(r.stepId,ID),stepDigest:text(r.stepDigest,HEX),principal:{kind:"schedule",id:text(p.id,ID)},workspaceId:text(r.workspaceId,/^ws_[a-f0-9]{24}$/),alias:text(r.alias,/^w_[a-f0-9]{32}$/),connectionId:text(r.connectionId,ID),providerConnectionId:text(r.providerConnectionId,/^ocg_[a-f0-9]{64}$/),authorizationFingerprint:text(r.authorizationFingerprint,HEX),operationId,arguments:validateReadArguments(operationId,r.arguments),...(operationId==="googleads.campaign_daily_metrics"?{sourceFingerprint:text(r.sourceFingerprint,HEX)}:{}),expiresAt:Number(r.expiresAt),maxBytes:Number(r.maxBytes),maxDurationMs:Number(r.maxDurationMs),capabilities:{claim:text(c.claim,/^[A-Za-z0-9_.-]{1,4096}$/),dispatch:text(c.dispatch,/^[A-Za-z0-9_.-]{1,4096}$/),complete:text(c.complete,/^[A-Za-z0-9_.-]{1,4096}$/)}};
}
/** Excludes opaque signatures to avoid a circular digest. Everything executable stays bound. */
export async function readRequestDigest(input:ReadRequest){const{capabilities:_,...bound}=input;return hash(bound);}
function redact(value:string,secrets:readonly string[]){let text=value;for(const secret of secrets)text=text.split(secret).join("[REDACTED]");return text.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,"[REDACTED]");}
function sanitized(value:unknown,secrets:readonly string[],depth=0):unknown {
  if(depth>24)throw new ReadGateError("read_gate_result_shape",502);
  if(typeof value==="string")return redact(value,secrets);
  if(typeof value==="number"&&!Number.isFinite(value))throw new ReadGateError("read_gate_result_shape",502);
  if(value===null||typeof value==="boolean"||typeof value==="number")return value;
  if(Array.isArray(value))return value.map(x=>sanitized(x,secrets,depth+1));
  if(value&&typeof value==="object"){const entries=Object.entries(value).map(([k,v])=>[redact(k,secrets),/^(?:authorization|access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret|cookie|client[_-]?secret)$/i.test(k)?"[REDACTED]":sanitized(v,secrets,depth+1)]as const);if(new Set(entries.map(([k])=>k)).size!==entries.length)throw new ReadGateError("read_gate_result_shape",502);return Object.fromEntries(entries);}
  throw new ReadGateError("read_gate_result_shape",502);
}
export async function googleAdsSourceFingerprint(input: Pick<ReadRequest,"alias">,credential: import("./types.js").OAuthReadCredential, secret:string | undefined): Promise<string> {
  if (!secret || !/^[A-Za-z0-9_-]{43,128}$/.test(secret) || new Set(secret).size<16 || !credential.developerToken || !/^[A-Za-z0-9_-]{16,256}$/.test(credential.developerToken)) throw new ReadGateError("read_gate_googleads_configuration_unavailable",409);
  const encoder=new TextEncoder();
  const key=await crypto.subtle.importKey("raw",encoder.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const message=JSON.stringify(["shiba.googleads.source.v1",input.alias,credential.rawConnectionId,credential.consentId,credential.revision,credential.developerToken]);
  const signature=await crypto.subtle.sign("HMAC",key,encoder.encode(message));
  return [...new Uint8Array(signature)].map(byte=>byte.toString(16).padStart(2,"0")).join("");
}
export async function handleReadGateway(request:Request,deps:GatewayDependencies):Promise<Response>{
  const url=new URL(request.url);
  if(!url.pathname.startsWith(GATE_PREFIX.slice(0,-1)))return deps.manualFetch(request);
  const route=url.pathname.slice(GATE_PREFIX.length);
  if(!["manifest","execute"].includes(route)||url.search)return response({error:"read_gate_not_found"},404);
  if(!deps.enabled||!deps.version||!/^[a-f0-9-]{36}$/.test(deps.version.id)||!/^[a-f0-9]{40}$/.test(deps.version.tag))return response({error:"read_gate_unattested"},503);
  const admittedAt=Date.now();let signal=AbortSignal.any([request.signal,AbortSignal.timeout(10000)]);
  const guarded=<T>(work:()=>Promise<T>):Promise<T>=>{signal.throwIfAborted();return abortable(work(),signal);};
  let input:ReadRequest|undefined,requestHash:string|undefined,claimed=false,started=false,committing=false,settlementAttempted=false;
  try {
    if(route==="manifest"){if(request.method!=="GET")return response({error:"method_not_allowed"},405);await guarded(()=>deps.verifyRuntime(request));const manifestDigest=await guarded(()=>hash(deps.manifest));return response({ok:true,version:deps.version,manifest:deps.manifest,manifestDigest});}
    if(request.method!=="POST")return response({error:"method_not_allowed"},405);
    if(!/^application\/json(?:;|$)/i.test(request.headers.get("content-type")??""))throw new ReadGateError("read_gate_request_invalid",415);
    let wire:unknown;try{wire=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await boundedBody(request.body,16384,signal)));}catch{throw new ReadGateError("read_gate_request_invalid",400);}
    input=parseReadRequest(wire);
    const remaining=Math.min(admittedAt+input.maxDurationMs,input.expiresAt)-Date.now();if(remaining<=0)throw new ReadGateError("read_gate_expired",409);
    signal=AbortSignal.any([request.signal,AbortSignal.timeout(Math.max(1,remaining))]);
    await guarded(()=>deps.verifyRuntime(request));
    const manifestDigest=await guarded(()=>hash(deps.manifest));
    if(input.versionId!==deps.version.id||input.manifestDigest!==manifestDigest||!deps.manifest.operations.some(o=>o.id===input!.operationId))throw new ReadGateError("read_gate_version_changed",409);
    requestHash=await guarded(()=>readRequestDigest(input!));
    const prior=await guarded(()=>deps.attempts.claim(input!,requestHash!));if(prior!=="claimed")return response({ok:true,receipt:prior,replayed:true});claimed=true;
    const credential=await guarded(()=>deps.resolveOAuth(input!));
    if(!/^[A-Za-z0-9._~+/-]{16,8192}={0,2}$/.test(credential.accessToken)||credential.privateRedactions?.some(v=>typeof v!=="string"||v.length<16||v.length>8192)||!credential.consentId||credential.expiresAt!==null&&(!Number.isFinite(credential.expiresAt)||credential.expiresAt<=Date.now()+60000))throw new ReadGateError("read_gate_oauth_unavailable",409);
    if(`ocg_${await guarded(()=>digest(JSON.stringify([input!.alias,input!.operationId.split(".")[0],credential.rawConnectionId,credential.consentId])))}`!==input.providerConnectionId||await guarded(()=>digest(JSON.stringify([input!.alias,input!.operationId.split(".")[0],credential.consentId])))!==input.authorizationFingerprint)throw new ReadGateError("read_gate_account_changed",409);
    if(input.operationId==="googleads.campaign_daily_metrics" && credential.sourceFingerprint!==input.sourceFingerprint)throw new ReadGateError("read_gate_account_changed",409);
    await guarded(()=>deps.verifyRuntime(request,input!.operationId,credential.rawConnectionId));
    const fresh=await guarded(()=>deps.resolveOAuth(input!));
    if(fresh.revision!==credential.revision||fresh.accessToken!==credential.accessToken||fresh.consentId!==credential.consentId||fresh.rawConnectionId!==credential.rawConnectionId||fresh.developerToken!==credential.developerToken||fresh.sourceFingerprint!==credential.sourceFingerprint)throw new ReadGateError("read_gate_account_changed",409);
    const runtimeToken=request.headers.get("authorization")?.replace(/^Bearer\s+/i,"")??"";if(runtimeToken.length<16)throw new ReadGateError("read_gate_runtime_unavailable",403);
    const secrets=[credential.accessToken,...(credential.developerToken?[credential.developerToken]:[]),...(credential.privateRedactions??[]),runtimeToken].sort((a,b)=>b.length-a.length);
    const target=providerRequest(input.operationId,input.arguments);
    const headers=new Headers({authorization:`Bearer ${credential.accessToken}`,accept:"application/json"});
    if(input.operationId.startsWith("github.")){headers.set("x-github-api-version","2022-11-28");headers.set("user-agent","Shiba fixed-read gateway");}
    if(input.operationId==="googleads.campaign_daily_metrics"){
      headers.set("developer-token",credential.developerToken!);
      headers.set("login-customer-id",String(input.arguments.loginCustomerId));
    }
    if(target.body)headers.set("content-type","application/json");
    // The final callback checks source/budgets and durably commits the nonce. No awaited work precedes fetch after this proof.
    committing=true;await guarded(()=>deps.attempts.commit(input!,requestHash!,credential));
    signal.throwIfAborted();if(Date.now()>=input.expiresAt||credential.expiresAt!==null&&Date.now()>=credential.expiresAt)throw new ReadGateError("read_gate_expired",409);
    started=true;
    const upstream=await abortable((deps.providerFetch??fetch)(target.url,{method:target.method,headers,body:target.body,redirect:"manual",cache:"no-store",signal}),signal);
    if(upstream.status>=300&&upstream.status<400)throw new ReadGateError("read_gate_provider_redirect_denied",502);
    const captured=await boundedBody(upstream.body,input.maxBytes,signal);if(!upstream.ok)throw new ReadGateError("read_gate_provider_refused",502);
    let body:unknown;try{body=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(captured));}catch{throw new ReadGateError("read_gate_provider_json_invalid",502);}
    if(input.operationId.startsWith("linear.")){const row=record(body);if(Array.isArray(row.errors)&&row.errors.length||!row.data)throw new ReadGateError("read_gate_provider_semantics_unverified",502);}
    if(input.operationId==="googleads.campaign_daily_metrics"){
      const top=record(body),rows=top.results===undefined?[]:top.results;
      if(!Array.isArray(rows)||rows.length>25)throw new ReadGateError("read_gate_result_shape",502);
      const number=(value:unknown)=>{if(value===undefined)return null;if(typeof value!=="string"||!/^\d{1,20}$/.test(value))throw new ReadGateError("read_gate_result_shape",502);return value;};
      body={results:rows.map(value=>{const row=record(value),campaign=record(row.campaign),segments=record(row.segments),metrics=record(row.metrics);
        if(typeof campaign.id!=="string"||!/^\d{1,20}$/.test(campaign.id)||typeof campaign.name!=="string"||campaign.name.length>500||typeof segments.date!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(segments.date)||segments.date<String(input!.arguments.startDate)||segments.date>String(input!.arguments.endDate))throw new ReadGateError("read_gate_result_shape",502);
        return {campaign:{id:campaign.id,name:campaign.name},date:segments.date,impressions:number(metrics.impressions),clicks:number(metrics.clicks),costMicros:number(metrics.costMicros)};
      })};
    }
    if(input.operationId==="figma.list_comments"){
      const row=record(body);
      if(!Array.isArray(row.comments)||row.comments.length>200)throw new ReadGateError("read_gate_result_shape",502);
      body={comments:row.comments.map((value:unknown)=>{
        const comment=record(value);
        if(typeof comment.id!=="string"||comment.id.length<1||comment.id.length>200||typeof comment.message!=="string"||comment.message.length>10000||typeof comment.created_at!=="string"||comment.created_at.length>100||!(comment.parent_id===null||typeof comment.parent_id==="string")||!(comment.resolved_at===null||typeof comment.resolved_at==="string"))throw new ReadGateError("read_gate_result_shape",502);
        return {id:comment.id,message:comment.message,created_at:comment.created_at,parent_id:comment.parent_id,resolved_at:comment.resolved_at};
      })};
    }
    const resultJson=JSON.stringify(sanitized(body,secrets));if(new TextEncoder().encode(resultJson).length>input.maxBytes)throw new ReadGateError("read_gate_result_limit",502);
    const receipt:GatewayReadReceipt={format:"shiba.scheduled-read.receipt.v1",stepId:input.stepId,stepDigest:input.stepDigest,versionId:deps.version.id,manifestDigest,operationId:input.operationId,state:"completed",capturedAt:Date.now(),bytes:captured.length,resultJson,resultDigest:await guarded(()=>digest(resultJson)),error:null,sourceKind:"bounded-fixed-read",captureCompleteness:"bounded-response",datasetCompleteness:"unknown",businessSuccess:"unverified"};
    settlementAttempted=true;await guarded(()=>deps.attempts.settle(input!,requestHash!,receipt));return response({ok:true,receipt});
  }catch(error){
    const code=error instanceof ReadGateError?error.code:"read_gate_outcome_unconfirmed";
    if(claimed&&!settlementAttempted&&input&&requestHash){const receipt:GatewayReadReceipt={format:"shiba.scheduled-read.receipt.v1",stepId:input.stepId,stepDigest:input.stepDigest,versionId:deps.version.id,manifestDigest:input.manifestDigest,operationId:input.operationId,state:started||committing?"unknown":"failed",capturedAt:Date.now(),bytes:0,resultJson:null,resultDigest:null,error:code,sourceKind:"bounded-fixed-read",captureCompleteness:"unknown",datasetCompleteness:"unknown",businessSuccess:"unverified"};try{await abortable(deps.attempts.settle(input,requestHash,receipt),AbortSignal.any([request.signal,AbortSignal.timeout(1000)]));}catch{/* uncertain callback outcomes are never retried */}}
    return response({error:code},error instanceof ReadGateError?error.status:503);
  }
}
