import { isAuthorizedRequest, resolveUserId } from "../request-auth.js";
import type { Env } from "../env.js";
import { randomHex } from "../mailbox-store.js";
import { createReasonNetworkGrant, decideReasonNetworkApproval, listReasonNetworkApprovals, listReasonNetworkGrants, reasonNetworkApprovalSetup, requestReasonNetworkApproval, revokeReasonNetworkGrant } from "./approval-store.js";

const PREFIX="/api/reason-network";
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{"cache-control":"no-store"}});
async function objectBody(request:Request):Promise<Record<string,unknown>|null>{try{const value:unknown=await request.json();return typeof value==="object"&&value!==null&&!Array.isArray(value)?value as Record<string,unknown>:null;}catch{return null;}}

/** Authenticated approval setup only. This route never invokes the upstream MCP client. */
export async function handleReasonNetwork(request:Request,env:Env):Promise<Response|null>{
  const url=new URL(request.url); if(url.pathname!==PREFIX&&!url.pathname.startsWith(`${PREFIX}/`))return null;
  if(!env.AGENT_AUDIT)return json({error:"Reason Network approval storage is unavailable."},503);
  if(!(await isAuthorizedRequest(request,env)))return json({error:"Authentication required."},401);
  const ownerId=(await resolveUserId(request,env))?.trim(); if(!ownerId)return json({error:"Authenticated owner required."},401);
  if(request.method!=="GET"&&(request.headers.get("origin")!==url.origin||request.headers.get("sec-fetch-site")==="cross-site"))return json({error:"Same-origin request required."},403);
  const path=url.pathname.slice(PREFIX.length).split("/").filter(Boolean).map((part)=>{try{return decodeURIComponent(part);}catch{return "";}});
  if(path.some((part)=>!part))return json({error:"Invalid path."},400);
  try{
    if((path.length===0||path.length===1&&path[0]==="status")&&request.method==="GET"){
      const setup=await reasonNetworkApprovalSetup(env,ownerId);
      return json({provider:"reason-network-oss",state:"setup_required",enabled:false,defaultEnabled:false,transport:"local-stdio-mcp",activeGrants:setup.activeGrants,pendingApprovals:setup.pendingApprovals,networkMembership:"not_checked",automaticInstall:false,automaticJoin:false,dispatchConfigured:false});
    }
    if(path.length===1&&path[0]==="grants"&&request.method==="POST"){
      const body=await objectBody(request);
      if(!body||typeof body.conversationId!=="string"||!body.conversationId.trim()||body.conversationId.length>160||typeof body.sessionId!=="string"||!body.sessionId.trim()||body.sessionId.length>160)return json({error:"A specific conversation and session are required."},400);
      const grant=await createReasonNetworkGrant(env,{grantId:`rng-${randomHex(16)}`,ownerId,conversationId:body.conversationId.trim(),sessionId:body.sessionId.trim()});
      return json({grant},201);
    }
    if(path.length===1&&path[0]==="grants"&&request.method==="GET")return json({grants:await listReasonNetworkGrants(env,ownerId)});
    if(path.length===2&&path[0]==="grants"&&path[1]&&request.method==="DELETE"){
      const changed=await revokeReasonNetworkGrant(env,ownerId,path[1]);return changed?json({revoked:true}):json({error:"Active grant not found."},404);
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
    return json({error:"Reason Network setup route or method not found."},404);
  }catch(error){const message=error instanceof Error?error.message:"Reason Network operation failed.";return json({error:message},400);}
}
