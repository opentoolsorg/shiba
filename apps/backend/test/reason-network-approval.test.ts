import { beforeEach, describe, expect, it, vi } from "vitest";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import type { Env } from "../src/env.js";

const auth=vi.hoisted(()=>({authorized:true,userId:"owner@example.test"}));
vi.mock("../src/request-auth.js",()=>({isAuthorizedRequest:vi.fn(async()=>auth.authorized),resolveUserId:vi.fn(async()=>auth.userId)}));

import { handleReasonNetwork } from "../src/reason-network/routes.js";
import { D1ReasonNetworkApprovalService } from "../src/reason-network/approval-store.js";
import { createReasonNetworkAdapter } from "../src/reason-network/adapter.js";

function fixture(){
  const {database}=customAgentD1(); const env={AGENT_AUDIT:database} as unknown as Env;
  const send=async(path:string,method="GET",body?:unknown)=>handleReasonNetwork(new Request(`https://worker.test/api/reason-network${path}`,{method,headers:{...(method==="GET"?{}:{origin:"https://worker.test","content-type":"application/json"})},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
  return {env,send};
}
const read=async<T>(response:Response|null)=>{if(!response)throw new Error("route not handled");return await response.json() as T;};

beforeEach(()=>{auth.authorized=true;auth.userId="owner@example.test";});

describe("Reason Network authenticated approval setup",()=>{
  it("reports setup required and denies unauthenticated approval setup",async()=>{
    const f=fixture();
    expect(await read(await f.send("/status"))).toMatchObject({state:"disabled",enabled:false,dispatchConfigured:false,activeGrants:0});
    auth.authorized=false;
    expect((await f.send("/grants","POST",{conversationId:"c1",sessionId:"s1"}))?.status).toBe(401);
  });

  it("binds and consumes a persistent approval once for the exact conversation/session/payload",async()=>{
    const f=fixture();
    const created=await read<{grant:{grantId:string}}>(await f.send("/grants","POST",{conversationId:"conversation-1",sessionId:"session-1"}));
    const grantId=created.grant.grantId;
    const request={grantId,conversationId:"conversation-1",sessionId:"session-1",destination:"alice",message:"Exact approved text",idempotencyKey:"send-001"};
    const pending=await read<{approvalId:string;status:string}>(await f.send("/approvals","POST",request));
    expect(pending.status).toBe("pending");
    expect(await read<{approvals:Array<{message:string}>}>(await f.send("/approvals"))).toMatchObject({approvals:[{message:"Exact approved text"}]});
    expect((await f.send(`/approvals/${pending.approvalId}`,"POST",{approved:true}))?.status).toBe(200);
    const service=new D1ReasonNetworkApprovalService(f.env);
    const scope={ownerId:"owner@example.test",grantId,conversationId:"conversation-1",sessionId:"session-1",runtime:"local-daemon" as const};
    expect(await service.isCurrent(scope)).toBe(true);
    const binding=await (async()=>{
      // The stored approval is intentionally the only authority; the adapter recomputes this digest too.
      const response=await read<{approvals:Array<{destination:string;message:string;payloadDigest:string;idempotencyKey:string}>}>(await f.send("/approvals?status=approved"));
      const approval=response.approvals[0]!;
      return {ownerId:"owner@example.test",grantId,conversationId:"conversation-1",sessionId:"session-1",destination:approval.destination,message:approval.message,idempotencyKey:approval.idempotencyKey,payloadDigest:approval.payloadDigest};
    })();
    expect(await service.consume({...binding,message:"modified"})).toBeNull();
    expect(await service.consume(binding)).toMatchObject({approvalId:pending.approvalId,...binding});
    expect(await service.consume(binding)).toBeNull();
    expect((await f.send(`/grants/${grantId}`,"DELETE"))?.status).toBe(200);
    expect(await service.isCurrent(scope)).toBe(false);
  });

  it("prevents a grant from authorizing another owner's conversation",async()=>{
    const f=fixture();
    const created=await read<{grant:{grantId:string}}>(await f.send("/grants","POST",{conversationId:"c1",sessionId:"s1"}));
    auth.userId="other@example.test";
    const service=new D1ReasonNetworkApprovalService(f.env);
    expect(await service.isCurrent({ownerId:"other@example.test",grantId:created.grant.grantId,conversationId:"c1",sessionId:"s1",runtime:"local-daemon"})).toBe(false);
  });

  it("wires the authenticated one-use approval store and durable operation ledger to a trusted in-process companion",async()=>{
    const f=fixture();
    const created=await read<{grant:{grantId:string}}>(await f.send("/grants","POST",{conversationId:"conv-dispatch",sessionId:"session-dispatch"}));
    const grantId=created.grant.grantId;
    const request={grantId,conversationId:"conv-dispatch",sessionId:"session-dispatch",destination:"peer-dispatch",message:"approved body",idempotencyKey:"dispatch-001"};
    const approval=await read<{approvalId:string}>(await f.send("/approvals","POST",request));
    expect((await f.send(`/approvals/${approval.approvalId}`,"POST",{approved:true}))?.status).toBe(200);
    const calls:unknown[]=[];
    const adapter=createReasonNetworkAdapter({enabled:true,scope:{ownerId:"owner@example.test",grantId,conversationId:"conv-dispatch",sessionId:"session-dispatch",runtime:"local-daemon"}},
      {connected:true,toolNames:["list_team","send_message","message_status"],callTool:async(name,args,meta)=>{calls.push({name,args,meta});return [{type:"text",text:"sent message id dispatch-message"}];}},f.env);
    await expect(adapter.sendMessage({to:request.destination,message:request.message,idempotencyKey:request.idempotencyKey})).resolves.toMatchObject({state:"accepted",messageId:"dispatch-message"});
    await expect(adapter.operationStatus(request.idempotencyKey)).resolves.toMatchObject({state:"accepted",remoteMessageId:"dispatch-message"});
    expect(calls).toHaveLength(1);
    expect(await new D1ReasonNetworkApprovalService(f.env).consume({ownerId:"owner@example.test",grantId,conversationId:request.conversationId,sessionId:request.sessionId,destination:request.destination,message:request.message,idempotencyKey:request.idempotencyKey,payloadDigest:(await adapter.operationStatus(request.idempotencyKey))!.payloadDigest})).toBeNull();
  });
});
