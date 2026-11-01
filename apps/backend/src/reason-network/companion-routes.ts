import type { Env } from "../env.js";
import { randomHex } from "../mailbox-store.js";
import { getConsumedReasonNetworkPayload } from "./approval-store.js";
import { D1ReasonNetworkOperationStore, REASON_NETWORK_RECOVERY_WINDOW_MS } from "./operation-store.js";

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{"cache-control":"no-store"}});
async function bodyObject(request:Request):Promise<Record<string,unknown>|null>{try{const v:unknown=await request.json();return typeof v==="object"&&v!==null&&!Array.isArray(v)?v as Record<string,unknown>:null;}catch{return null;}}

/** Private, paired-machine-only v1 companion lane. Caller auth is verified by handleLocalAdapter. */
export async function handleReasonNetworkCompanion(request:Request,env:Env,machineId:string|undefined):Promise<Response>{
  const url=new URL(request.url);const path=url.pathname.replace(/^\/api\/local\/reason-network\/v1\/?/,"");
  if(env.REASON_NETWORK_ENABLED!=="1"||env.SHIBA_LOCAL_RUNTIME!=="1"||!env.AGENT_AUDIT)return json({error:"Reason Network companion dispatch is disabled."},404);
  if(!machineId)return json({error:"A paired machine credential is required; shared deployment tokens cannot claim Reason operations."},403);
  const store=new D1ReasonNetworkOperationStore({AGENT_AUDIT:env.AGENT_AUDIT});
  if(path==="claim"&&request.method==="POST"){
    const claimToken=randomHex(24);const op=await store.claimNext(machineId,claimToken);
    if(!op)return json({operation:null});
    const payload=await getConsumedReasonNetworkPayload({AGENT_AUDIT:env.AGENT_AUDIT},op.scope.ownerId,op.approvalId??"",machineId);
    if(!payload||payload.payloadDigest!==op.payloadDigest||payload.destination!==op.destination||payload.idempotencyKey!==op.idempotencyKey||
      payload.grantId!==op.scope.grantId||payload.conversationId!==op.scope.conversationId||payload.sessionId!==op.scope.sessionId){
      await store.settleClaim(machineId,op.operationId!,claimToken,"rejected");return json({error:"Approved payload no longer matches this operation and paired machine."},409);
    }
    return json({operation:{operationId:op.operationId,claimToken,conversationId:payload.conversationId,sessionId:payload.sessionId,
      destination:payload.destination,message:payload.message,idempotencyKey:payload.idempotencyKey,...(payload.replyTo?{replyTo:payload.replyTo}:{}),cancelRequested:false}});
  }
  const parts=path.split("/").filter(Boolean);const operationId=parts[1]??"";
  if(parts[0]==="operations"&&parts.length===2&&request.method==="GET"){
    const op=await store.getByCompanionOperationId(machineId,operationId);
    if(!op)return json({error:"Operation not found."},404);
    const withinWindow=op.firstAttemptAt!==null&&op.firstAttemptAt!==undefined&&op.firstAttemptAt>Date.now()-REASON_NETWORK_RECOVERY_WINDOW_MS;
    if(op.state==="claimed"&&!withinWindow){
      await store.expireClaim(machineId,operationId);
      return json({operationId,state:"unknown",cancelRequested:true,sendAllowed:false});
    }
    const payload=await getConsumedReasonNetworkPayload({AGENT_AUDIT:env.AGENT_AUDIT},op.scope.ownerId,op.approvalId??"",machineId);
    if(!payload)return json({operationId,state:"rejected",cancelRequested:true});
    const payloadMatches=payload.payloadDigest===op.payloadDigest&&payload.destination===op.destination&&payload.idempotencyKey===op.idempotencyKey&&
      payload.grantId===op.scope.grantId&&payload.conversationId===op.scope.conversationId&&payload.sessionId===op.scope.sessionId;
    const cancelRequested=op.cancelRequested===true||!payloadMatches;
    return json({operationId,state:op.state,cancelRequested,sendAllowed:op.state==="claimed"&&!cancelRequested&&withinWindow});
  }
  if(parts[0]==="result"&&request.method==="POST"){
    const body=await bodyObject(request);if(!body||typeof body.operationId!=="string"||typeof body.claimToken!=="string"||!(["accepted","unknown","rejected","cancelled"] as unknown[]).includes(body.state))return json({error:"Invalid companion result."},400);
    const op=await store.getByCompanionOperationId(machineId,body.operationId);if(!op)return json({error:"Operation not found."},404);
    // The paired claim token is the result-write capability. Preserve actual outcome
    // even if the owner revokes the grant after the send crossed the process boundary.
    const next=body.state as "accepted"|"unknown"|"rejected"|"cancelled";
    const changed=await store.settleClaim(machineId,body.operationId,body.claimToken,next,typeof body.messageId==="string"?body.messageId:undefined);
    return changed?json({operationId:body.operationId,state:next}):json({error:"Claim is no longer current."},409);
  }
  return json({error:"Reason Network companion v1 route not found."},404);
}
