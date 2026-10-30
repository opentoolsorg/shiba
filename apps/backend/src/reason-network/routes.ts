import { isAuthorizedRequest, resolveUserId } from "../request-auth.js";
import type { Env } from "../env.js";
import { randomHex } from "../mailbox-store.js";
import { consumeReasonNetworkApprovalById, createReasonNetworkGrant, decideReasonNetworkApproval, getReasonNetworkApprovalForDispatch, listReasonNetworkApprovals, listReasonNetworkGrants, reasonNetworkApprovalSetup, requestReasonNetworkApproval, revokeReasonNetworkGrant, D1ReasonNetworkApprovalService } from "./approval-store.js";
import { D1ReasonNetworkOperationStore } from "./operation-store.js";
import { localDispatchStub } from "../local-dispatch.js";

const PREFIX="/api/reason-network";
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{"cache-control":"no-store"}});
async function objectBody(request:Request):Promise<Record<string,unknown>|null>{try{const value:unknown=await request.json();return typeof value==="object"&&value!==null&&!Array.isArray(value)?value as Record<string,unknown>:null;}catch{return null;}}

/** Authenticated setup and owner operation API; native sends are claimed by the paired daemon only. */
export async function handleReasonNetwork(request:Request,env:Env):Promise<Response|null>{
  const url=new URL(request.url); if(url.pathname!==PREFIX&&!url.pathname.startsWith(`${PREFIX}/`))return null;
  if(!env.AGENT_AUDIT)return json({error:"Reason Network approval storage is unavailable."},503);
  if(!(await isAuthorizedRequest(request,env)))return json({error:"Authentication required."},401);
  const ownerId=(await resolveUserId(request,env))?.trim(); if(!ownerId)return json({error:"Authenticated owner required."},401);
  if(request.method!=="GET"&&(request.headers.get("origin")!==url.origin||request.headers.get("sec-fetch-site")==="cross-site"))return json({error:"Same-origin request required."},403);
  const path=url.pathname.slice(PREFIX.length).split("/").filter(Boolean).map((part)=>{try{return decodeURIComponent(part);}catch{return "";}});
  if(path.some((part)=>!part))return json({error:"Invalid path."},400);
  const apiVersion=path[0]==="v1"?(path.shift(),"v1"):"legacy";
  try{
    if((path.length===0||path.length===1&&path[0]==="status")&&request.method==="GET"){
      const setup=await reasonNetworkApprovalSetup(env,ownerId);
      const enabled=env.REASON_NETWORK_ENABLED==="1";
      let companionConfigured=false;
      if(enabled&&env.SHIBA_LOCAL_RUNTIME==="1"&&env.LocalDispatch&&env.PAIRING_SECRET){
        const response=await localDispatchStub(env).fetch(new Request("https://local-dispatch/computers"));
        const fleet=await response.json() as {computers?:Array<{pairedAt?:number;status?:string;reasonNetworkCompanion?:boolean}>};
        companionConfigured=!!fleet.computers?.some((computer)=>computer.pairedAt!==undefined&&computer.status!=="offline"&&computer.reasonNetworkCompanion===true);
      }
      return json({provider:"reason-network-oss",state:!enabled?"disabled":companionConfigured?"companion_configured":"setup_required",enabled,defaultEnabled:false,transport:"paired-local-stdio-mcp",activeGrants:setup.activeGrants,pendingApprovals:setup.pendingApprovals,networkMembership:"not_checked",automaticInstall:false,automaticJoin:false,dispatchConfigured:companionConfigured});
    }
    if(path.length===1&&path[0]==="grants"&&request.method==="POST"){
      const body=await objectBody(request);
      if(!body||typeof body.conversationId!=="string"||!body.conversationId.trim()||body.conversationId.length>160||typeof body.sessionId!=="string"||!body.sessionId.trim()||body.sessionId.length>160||(body.companionMachineId!==undefined&&typeof body.companionMachineId!=="string"))return json({error:"A specific conversation, session, and optional paired machine are required."},400);
      const companionMachineId=typeof body.companionMachineId==="string"?body.companionMachineId.trim():undefined;
      if(companionMachineId){
        if(env.REASON_NETWORK_ENABLED!=="1"||env.SHIBA_LOCAL_RUNTIME!=="1"||!env.LocalDispatch)return json({error:"Reason Network paired companion dispatch is disabled."},409);
        const computersResponse=await localDispatchStub(env).fetch(new Request("https://local-dispatch/computers"));
        const computers=await computersResponse.json() as {computers?:Array<{machineId?:string;pairedAt?:number;status?:string;reasonNetworkCompanion?:boolean}>};
        if(!computers.computers?.some((computer)=>computer.machineId===companionMachineId&&computer.pairedAt!==undefined&&computer.status!=="offline"&&computer.reasonNetworkCompanion===true))return json({error:"Select a paired, online daemon with its Reason Network companion explicitly enabled."},409);
      }
      const grant=await createReasonNetworkGrant(env,{grantId:`rng-${randomHex(16)}`,ownerId,conversationId:body.conversationId.trim(),sessionId:body.sessionId.trim(),...(companionMachineId?{companionMachineId}:{})});
      return json({grant},201);
    }
    if(path.length===1&&path[0]==="grants"&&request.method==="GET")return json({grants:await listReasonNetworkGrants(env,ownerId)});
    if(path.length===2&&path[0]==="grants"&&path[1]&&request.method==="DELETE"){
      const changed=await revokeReasonNetworkGrant(env,ownerId,path[1]);
      if(changed)await new D1ReasonNetworkOperationStore(env).cancelGrant(ownerId,path[1]);
      return changed?json({revoked:true}):json({error:"Active grant not found."},404);
    }
    if(path.length===1&&path[0]==="approvals"&&request.method==="GET"){
      const requested=url.searchParams.get("status")??"pending";
      if(!["pending","approved","denied","consumed","expired"].includes(requested))return json({error:"Invalid approval status."},400);
      return json({approvals:await listReasonNetworkApprovals(env,ownerId,requested as "pending"|"approved"|"denied"|"consumed"|"expired")});
    }
    if(path.length===1&&path[0]==="approvals"&&request.method==="POST"){
      const body=await objectBody(request);
      if(!body||typeof body.grantId!=="string"||typeof body.conversationId!=="string"||typeof body.sessionId!=="string"||typeof body.destination!=="string"||typeof body.message!=="string"||typeof body.idempotencyKey!=="string"||(body.replyTo!==undefined&&typeof body.replyTo!=="string"))return json({error:"Invalid exact-message approval request."},400);
      if(!body.destination.trim()||body.destination.length>200||!body.message.trim()||body.message.length>5000||! /^[A-Za-z0-9._:-]{1,128}$/.test(body.idempotencyKey))return json({error:"Destination, message, or idempotency key is invalid."},400);
      const approval=await requestReasonNetworkApproval(env,{ownerId,grantId:body.grantId,conversationId:body.conversationId,sessionId:body.sessionId,destination:body.destination,message:body.message,idempotencyKey:body.idempotencyKey,...(typeof body.replyTo==="string"?{replyTo:body.replyTo}:{}),expiresAt:Date.now()+15*60_000});
      return json({approvalId:approval.approvalId,status:approval.status,expiresAt:approval.expiresAt},202);
    }
    if(path.length===2&&path[0]==="approvals"&&path[1]&&request.method==="POST"){
      const body=await objectBody(request); if(!body||typeof body.approved!=="boolean")return json({error:"Approval decision is required."},400);
      const changed=await decideReasonNetworkApproval(env,{ownerId,approvalId:path[1],approved:body.approved,decidedBy:ownerId});
      return changed?json({approvalId:path[1],status:body.approved?"approved":"denied"}):json({error:"Pending approval not found, expired, or already decided."},409);
    }
    if(path.length===1&&path[0]==="operations"&&request.method==="POST"){
      if(apiVersion!=="v1")return json({error:"Reason Network operation API requires /v1/."},404);
      if(env.REASON_NETWORK_ENABLED!=="1"||env.SHIBA_LOCAL_RUNTIME!=="1"||!env.LocalDispatch||!env.PAIRING_SECRET)return json({error:"Reason Network paired dispatch is disabled or not configured."},409);
      const body=await objectBody(request);if(!body||typeof body.approvalId!=="string"||!body.approvalId)return json({error:"Approved approvalId is required."},400);
      const approval=await getReasonNetworkApprovalForDispatch(env,ownerId,body.approvalId);if(!approval)return json({error:"Approved message or active paired grant not found."},409);
      const scope={ownerId,grantId:approval.grantId,conversationId:approval.conversationId,sessionId:approval.sessionId};
      const store=new D1ReasonNetworkOperationStore(env);const operationId=`rno-${randomHex(16)}`;
      const reserved=await store.reserve({operationId,approvalId:approval.approvalId,companionMachineId:approval.companionMachineId,scope,idempotencyKey:approval.idempotencyKey,payloadDigest:approval.payloadDigest,destination:approval.destination,state:"pending_approval",updatedAt:Date.now()});
      if(reserved.kind==="conflict")return json({error:"Idempotency key conflicts with a different approved payload."},409);
      if(reserved.kind==="replay"&&["queued","claimed","accepted","unknown","cancelled","rejected"].includes(reserved.operation.state))return json({operationId:reserved.operation.operationId,state:reserved.operation.state},200);
      if(reserved.kind==="created"||reserved.operation.state==="pending_approval"){
        const consumed=await consumeReasonNetworkApprovalById(env,ownerId,approval.approvalId);
        const stillSame=await getReasonNetworkApprovalForDispatch(env,ownerId,approval.approvalId);
        if(!consumed&&stillSame?.approvalId!==approval.approvalId)return json({error:"Approval was already consumed or revoked."},409);
        await store.transition(scope,approval.idempotencyKey,["pending_approval"],"approved");
      }
      await store.transition(scope,approval.idempotencyKey,["approved"],"queued");
      const queued=await store.get(scope,approval.idempotencyKey);
      return json({operationId:queued?.operationId,state:queued?.state??"unknown"},202);
    }
    if(path.length===1&&path[0]==="operations"&&request.method==="GET"){
      if(apiVersion!=="v1")return json({error:"Reason Network operation API requires /v1/."},404);
      const rows=await new D1ReasonNetworkOperationStore(env).listByOwner(ownerId);
      return json({operations:rows.map((operation)=>({operationId:operation.operationId,approvalId:operation.approvalId,state:operation.state,updatedAt:operation.updatedAt,remoteMessageId:operation.remoteMessageId,cancelRequested:operation.cancelRequested===true}))});
    }
    if(path.length===2&&path[0]==="operations"&&path[1]&&request.method==="GET"){
      if(apiVersion!=="v1")return json({error:"Reason Network operation API requires /v1/."},404);
      const operation=await new D1ReasonNetworkOperationStore(env).getByOperationId(ownerId,path[1]);
      return operation?json({operationId:operation.operationId,state:operation.state,updatedAt:operation.updatedAt,remoteMessageId:operation.remoteMessageId,cancelRequested:operation.cancelRequested===true}):json({error:"Operation not found."},404);
    }
    if(path.length===2&&path[0]==="operations"&&path[1]&&request.method==="DELETE"){
      if(apiVersion!=="v1")return json({error:"Reason Network operation API requires /v1/."},404);
      const result=await new D1ReasonNetworkOperationStore(env).cancelOperation(ownerId,path[1]);
      return result==="not_found"?json({error:"Operation not found."},404):json({operationId:path[1],state:result});
    }
    if(path.length===3&&path[0]==="operations"&&path[2]==="recover"&&request.method==="POST"){
      if(apiVersion!=="v1")return json({error:"Reason Network operation API requires /v1/."},404);
      if(env.REASON_NETWORK_ENABLED!=="1"||env.SHIBA_LOCAL_RUNTIME!=="1"||!env.LocalDispatch||!env.PAIRING_SECRET)return json({error:"Reason Network paired dispatch is disabled or not configured."},409);
      const store=new D1ReasonNetworkOperationStore(env);const op=await store.getByOperationId(ownerId,path[1]!);
      if(!op)return json({error:"Operation not found."},404);
      if(!op.approvalId||!await getReasonNetworkApprovalForDispatch(env,ownerId,op.approvalId))return json({error:"Approved payload expired or grant was revoked; recovery is unavailable."},409);
      const current=await new D1ReasonNetworkApprovalService(env).isCurrent({...op.scope,runtime:"local-daemon"});
      if(!current)return json({error:"Grant was revoked; operation cannot be recovered."},409);
      const changed=await store.recover(ownerId,path[1]!);return changed?json({operationId:path[1],state:"queued",idempotencyKey:op.idempotencyKey}):json({error:"Only unknown operations can be recovered."},409);
    }
    return json({error:"Reason Network setup route or method not found."},404);
  }catch(error){const message=error instanceof Error?error.message:"Reason Network operation failed.";return json({error:message},400);}
}
