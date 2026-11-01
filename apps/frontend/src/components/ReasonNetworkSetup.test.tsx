// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReasonNetworkSetup } from "./ReasonNetworkSetup";

afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const json=(value:unknown,status=200)=>Response.json(value,{status});

describe("Reason Network setup-only surface",()=>{
  it("shows disabled/unverified readiness and persists scoped grant plus exact approval decisions",async()=>{
    const calls:Array<{url:string;method:string;body?:Record<string,unknown>}>=[];
    let grants:Array<{grantId:string;conversationId:string;sessionId:string;companionMachineId?:string;status:"active"|"revoked"}> = [];
    let approvals:Array<{approvalId:string;grantId:string;conversationId:string;sessionId:string;destination:string;message:string;status:string;expiresAt:number}> = [];
    vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const url=String(input);const method=init?.method??"GET";const body=typeof init?.body==="string"?JSON.parse(init.body) as Record<string,unknown>:undefined;
      calls.push({url,method,body});
      if(url.endsWith("/status"))return json({state:"setup_required",enabled:false,dispatchConfigured:false,networkMembership:"not_checked",activeGrants:grants.filter(x=>x.status==="active").length,pendingApprovals:approvals.filter(x=>x.status==="pending").length});
      if(url.endsWith("/grants")&&method==="GET")return json({grants});
      if(url.includes("/approvals")&&method==="GET")return json({approvals:approvals.filter(x=>x.status===(url.includes("status=approved")?"approved":url.includes("status=consumed")?"consumed":"pending"))});
      if(url.endsWith("/operations")&&method==="GET")return json({operations:[]});
      if(url.endsWith("/grants")&&method==="POST") {const record={grantId:"grant-1",conversationId:String(body?.conversationId),sessionId:String(body?.sessionId),companionMachineId:String(body?.companionMachineId),status:"active" as const};grants=[record,...grants];return json({grant:record},201);}
      if(url.endsWith("/approvals")&&method==="POST") {const record={approvalId:"approval-1",grantId:String(body?.grantId),conversationId:String(body?.conversationId),sessionId:String(body?.sessionId),destination:String(body?.destination),message:String(body?.message),status:"pending",expiresAt:Date.now()+60000};approvals=[record,...approvals];return json({approvalId:record.approvalId,status:record.status,expiresAt:record.expiresAt},202);}
      if(url.includes("/approvals/")){approvals=approvals.map(x=>x.approvalId==="approval-1"?{...x,status:body?.approved?"approved":"denied"}:x);return json({status:body?.approved?"approved":"denied"});}
      if(url.includes("/grants/")&&method==="DELETE"){grants=grants.map(x=>({...x,status:"revoked"}));return json({revoked:true});}
      return json({},404);
    }));
    render(<ReasonNetworkSetup/>);
    expect(await screen.findByText(/Enabled: no · Dispatch: not connected · Network membership: not checked/)).toBeTruthy();
    expect(screen.getByText(/never installs or starts the upstream process/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Reason conversation ID"),{target:{value:"conversation-7"}});
    fireEvent.change(screen.getByLabelText("Reason session ID"),{target:{value:"session-2"}});
    fireEvent.change(screen.getByLabelText("Paired companion machine ID"),{target:{value:"paired-machine-1"}});
    fireEvent.click(screen.getByRole("button",{name:"Create local grant"}));
    await screen.findByText(/conversation-7 · session-2 · machine paired-machine-1 · active/);
    fireEvent.change(screen.getByLabelText("Exact peer destination"),{target:{value:"peer:alice"}});
    fireEvent.change(screen.getByLabelText("Exact message for approval"),{target:{value:"Exact approved text"}});
    fireEvent.click(screen.getByRole("button",{name:"Request approval record"}));
    expect(await screen.findByText("Exact approved text")).toBeTruthy();
    expect(calls.find(x=>x.method==="POST"&&x.url.endsWith("/approvals"))?.body).toMatchObject({conversationId:"conversation-7",sessionId:"session-2",destination:"peer:alice",message:"Exact approved text"});
    fireEvent.click(screen.getByRole("button",{name:"Approve record"}));
    await waitFor(()=>expect(approvals[0]?.status).toBe("approved"));
    expect(calls.find(x=>x.method==="POST"&&x.url.includes("/approvals/"))?.body).toEqual({approved:true});
  });
});
