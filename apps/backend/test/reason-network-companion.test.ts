import { beforeEach, describe, expect, it, vi } from "vitest";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import type { Env } from "../src/env.js";

const auth=vi.hoisted(()=>({authorized:true,userId:"companion-owner"}));
vi.mock("../src/request-auth.js",()=>({isAuthorizedRequest:vi.fn(async()=>auth.authorized),resolveUserId:vi.fn(async()=>auth.userId)}));

import { handleReasonNetwork } from "../src/reason-network/routes.js";
import { handleReasonNetworkCompanion } from "../src/reason-network/companion-routes.js";
import { handleLocalAdapter } from "../src/local-routes.js";
import { createReasonNetworkCompanion } from "../../../scripts/reason-network-companion.mjs";

const MACHINE="paired-machine-1";
function fixture(){
  const {database}=customAgentD1();
  const env={AGENT_AUDIT:database,REASON_NETWORK_ENABLED:"1",SHIBA_LOCAL_RUNTIME:"1",PAIRING_SECRET:"configured",LocalDispatch:{idFromName:()=>"local",get:()=>({fetch:async(request:Request)=>new URL(request.url).pathname.endsWith("/authorize")?Response.json({machineId:MACHINE}):Response.json({computers:[{machineId:MACHINE,pairedAt:1,status:"idle",reasonNetworkCompanion:true}]})})}} as unknown as Env;
  const app=async(path:string,method="GET",body?:unknown)=>handleReasonNetwork(new Request(`https://worker.test/api/reason-network${path}`,{method,headers:{...(method==="GET"?{}:{origin:"https://worker.test","content-type":"application/json"})},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
  const companion=async(path:string,method="POST",body?:unknown,machine=MACHINE)=>handleReasonNetworkCompanion(new Request(`https://worker.test/api/local/reason-network/v1/${path}`,{method,headers:{"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})}),env,machine);
  const daemon=async(path:string,method="POST",body?:unknown)=>handleLocalAdapter(new Request(`https://worker.test/api/local/reason-network/v1/${path}`,{method,headers:{authorization:"Bearer paired-device-token","content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
  return {env,app,companion,daemon};
}
const read=async<T>(r:Response|null)=>{if(!r)throw new Error("route was not handled");return await r.json() as T;};
beforeEach(()=>{auth.authorized=true;auth.userId="companion-owner";});

describe("Reason Network paired companion queue v1",()=>{
  it("moves exact approved payload Worker→queue→paired daemon claim→MCP result→owner status",async()=>{
    const f=fixture();
    const grant=await read<{grant:{grantId:string}}>(await f.app("/grants","POST",{conversationId:"conv-1",sessionId:"session-1",companionMachineId:MACHINE}));
    const approval=await read<{approvalId:string}>(await f.app("/approvals","POST",{grantId:grant.grant.grantId,conversationId:"conv-1",sessionId:"session-1",destination:"peer-one",message:"approved exact body",idempotencyKey:"send-100"}));
    expect((await f.app("/v1/operations","POST",{approvalId:approval.approvalId}))?.status).toBe(409);
    expect((await f.app(`/approvals/${approval.approvalId}`,"POST",{approved:true}))?.status).toBe(200);
    const queued=await read<{operationId:string;state:string}>(await f.app("/v1/operations","POST",{approvalId:approval.approvalId,destination:"forged-peer",message:"forged body"}));
    expect(queued.state).toBe("queued");
    expect(await read(await f.companion("claim","POST",undefined,"other-paired-machine"))).toEqual({operation:null});
    const claimed=await read<{operation:{operationId:string;claimToken:string;sessionId:string;destination:string;message:string;idempotencyKey:string}}>(await f.daemon("claim"));
    expect(claimed.operation).toMatchObject({operationId:queued.operationId,sessionId:"session-1",destination:"peer-one",message:"approved exact body",idempotencyKey:"send-100"});
    // Deterministic fake companion exercises the same MCP argument and session contract as the local stdio client.
    const mcpCall=vi.fn(async(input:{name:string;arguments:Record<string,unknown>;_meta:{sessionId:string}})=>({isError:false,content:[{type:"text",text:"sent message id peer-message-1"}]}));
    const companion=createReasonNetworkCompanion({connect:async()=>({listTools:async()=>({tools:[{name:"send_message"}]}),callTool:mcpCall,close:async()=>{}})});
    const response=await companion(claimed.operation);
    expect(response).toEqual({state:"accepted",messageId:"peer-message-1"});expect(mcpCall).toHaveBeenCalledWith({name:"send_message",arguments:{to:"peer-one",message:"approved exact body",idempotency_key:"send-100"},_meta:{sessionId:"session-1"}});
    expect((await f.daemon("result","POST",{operationId:queued.operationId,claimToken:claimed.operation.claimToken,state:"accepted",messageId:"peer-message-1"})).status).toBe(200);
    expect(await read(await f.app(`/v1/operations/${queued.operationId}`))).toMatchObject({operationId:queued.operationId,state:"accepted",remoteMessageId:"peer-message-1"});
    expect((await f.daemon("result","POST",{operationId:queued.operationId,claimToken:claimed.operation.claimToken,state:"accepted"})).status).toBe(409);
  });

  it("recovers uncertain delivery with the same approved payload and idempotency key",async()=>{
    const f=fixture();
    const grant=await read<{grant:{grantId:string}}>(await f.app("/grants","POST",{conversationId:"conv-r",sessionId:"session-r",companionMachineId:MACHINE}));
    const approval=await read<{approvalId:string}>(await f.app("/approvals","POST",{grantId:grant.grant.grantId,conversationId:"conv-r",sessionId:"session-r",destination:"peer-r",message:"same body",idempotencyKey:"same-key"}));
    await f.app(`/approvals/${approval.approvalId}`,"POST",{approved:true});
    const queued=await read<{operationId:string}>(await f.app("/v1/operations","POST",{approvalId:approval.approvalId}));
    const first=await read<{operation:{claimToken:string;idempotencyKey:string}}>(await f.daemon("claim"));
    await f.daemon("result","POST",{operationId:queued.operationId,claimToken:first.operation.claimToken,state:"unknown"});
    expect(await read<{state:string}>(await f.app(`/v1/operations/${queued.operationId}`))).toMatchObject({state:"unknown"});
    expect((await f.app(`/v1/operations/${queued.operationId}/recover`,"POST",{}))?.status).toBe(200);
    const recovered=await read<{operation:{claimToken:string;idempotencyKey:string;message:string}}>(await f.daemon("claim"));
    expect(recovered.operation).toMatchObject({idempotencyKey:"same-key",message:"same body"});
    await f.daemon("result","POST",{operationId:queued.operationId,claimToken:recovered.operation.claimToken,state:"accepted",messageId:"recovered-id"});
    expect(await read(await f.app(`/v1/operations/${queued.operationId}`))).toMatchObject({state:"accepted",remoteMessageId:"recovered-id"});
  });

  it("cancels queued work, blocks revoked grants, and refuses shared-token claims",async()=>{
    const f=fixture();
    const grant=await read<{grant:{grantId:string}}>(await f.app("/grants","POST",{conversationId:"conv-c",sessionId:"session-c",companionMachineId:MACHINE}));
    const approval=await read<{approvalId:string}>(await f.app("/approvals","POST",{grantId:grant.grant.grantId,conversationId:"conv-c",sessionId:"session-c",destination:"peer-c",message:"cancel this",idempotencyKey:"cancel-1"}));
    await f.app(`/approvals/${approval.approvalId}`,"POST",{approved:true});
    const operation=await read<{operationId:string}>(await f.app("/v1/operations","POST",{approvalId:approval.approvalId}));
    expect(await read(await f.app(`/v1/operations/${operation.operationId}`,"DELETE"))).toMatchObject({state:"cancelled"});
    expect(await read(await f.daemon("claim"))).toEqual({operation:null});
    const sharedTokenEnv={...f.env,LOCAL_ADAPTER_TOKEN:"shared-deployment-token"} as Env;
    expect((await handleLocalAdapter(new Request("https://worker.test/api/local/reason-network/v1/claim",{method:"POST",headers:{authorization:"Bearer shared-deployment-token"}}),sharedTokenEnv)).status).toBe(403);
    const secondApproval=await read<{approvalId:string}>(await f.app("/approvals","POST",{grantId:grant.grant.grantId,conversationId:"conv-c",sessionId:"session-c",destination:"peer-c",message:"queued before revoke",idempotencyKey:"cancel-2"}));
    await f.app(`/approvals/${secondApproval.approvalId}`,"POST",{approved:true});
    const secondOperation=await read<{operationId:string}>(await f.app("/v1/operations","POST",{approvalId:secondApproval.approvalId}));
    await f.app(`/grants/${grant.grant.grantId}`,"DELETE");
    expect(await read(await f.app(`/v1/operations/${secondOperation.operationId}`))).toMatchObject({state:"cancelled"});
    expect(await read(await f.daemon("claim"))).toEqual({operation:null});
  });

  it("signals cancellation to a claimed daemon and records its acknowledgement",async()=>{
    const f=fixture();
    const grant=await read<{grant:{grantId:string}}>(await f.app("/grants","POST",{conversationId:"conv-cancel-running",sessionId:"session-cancel-running",companionMachineId:MACHINE}));
    const approval=await read<{approvalId:string}>(await f.app("/approvals","POST",{grantId:grant.grant.grantId,conversationId:"conv-cancel-running",sessionId:"session-cancel-running",destination:"peer-c",message:"cancel while claimed",idempotencyKey:"cancel-running"}));
    await f.app(`/approvals/${approval.approvalId}`,"POST",{approved:true});
    const operation=await read<{operationId:string}>(await f.app("/v1/operations","POST",{approvalId:approval.approvalId}));
    const claimed=await read<{operation:{claimToken:string}}>(await f.daemon("claim"));
    expect(await read(await f.app(`/v1/operations/${operation.operationId}`,"DELETE"))).toMatchObject({state:"cancel_requested"});
    expect(await read(await f.daemon(`operations/${operation.operationId}`,"GET"))).toMatchObject({state:"claimed",cancelRequested:true});
    expect((await f.daemon("result","POST",{operationId:operation.operationId,claimToken:claimed.operation.claimToken,state:"cancelled"})).status).toBe(200);
    expect(await read(await f.app(`/v1/operations/${operation.operationId}`))).toMatchObject({state:"cancelled"});
  });

  it("rechecks cancellation after MCP discovery and immediately before the send call",async()=>{
    const f=fixture();
    const grant=await read<{grant:{grantId:string}}>(await f.app("/grants","POST",{conversationId:"conv-late-cancel",sessionId:"session-late-cancel",companionMachineId:MACHINE}));
    const approval=await read<{approvalId:string}>(await f.app("/approvals","POST",{grantId:grant.grant.grantId,conversationId:"conv-late-cancel",sessionId:"session-late-cancel",destination:"peer-late",message:"must not send after cancel",idempotencyKey:"late-cancel-key"}));
    await f.app(`/approvals/${approval.approvalId}`,"POST",{approved:true});
    const operation=await read<{operationId:string}>(await f.app("/v1/operations","POST",{approvalId:approval.approvalId}));
    const claim=await read<{operation:{operationId:string;claimToken:string;sessionId:string;destination:string;message:string;idempotencyKey:string}}>(await f.daemon("claim"));
    let finishDiscovery!:()=>void;
    const listTools=new Promise<{tools:Array<{name:string}>}>((resolve)=>{finishDiscovery=()=>resolve({tools:[{name:"send_message"}]});});
    const callTool=vi.fn(async()=>({isError:false,content:[{type:"text",text:"sent message id should-not-exist"}]}));
    const companion=createReasonNetworkCompanion({
      connect:async()=>({listTools:async()=>listTools,callTool,close:async()=>{}}),
      beforeSend:async(current)=>{
        const status=await read<{state:string;cancelRequested:boolean}>(await f.daemon(`operations/${current.operationId}`,"GET"));
        return status.state==="claimed"&&!status.cancelRequested;
      },
    });
    const pending=companion(claim.operation);
    expect(await read(await f.app(`/v1/operations/${operation.operationId}`,"DELETE"))).toMatchObject({state:"cancel_requested"});
    finishDiscovery();
    await expect(pending).resolves.toEqual({state:"cancelled"});
    expect(callTool).not.toHaveBeenCalled();
  });
});
