import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { ReasonNetworkAdapter, reasonNetworkReadiness, type ReasonNetworkApprovalBinding, type ReasonNetworkApprovalReceipt, type ReasonNetworkMcpClient, type ReasonNetworkTrustedScope } from "../src/reason-network/adapter.js";
import { D1ReasonNetworkOperationStore, type ReasonOperation, type ReasonNetworkOperationStore, type ReasonOperationScope, type ReserveResult, type ReasonOperationState } from "../src/reason-network/operation-store.js";
import { connectReasonNetworkStdio } from "../src/reason-network/stdio-client.js";

const scope: ReasonNetworkTrustedScope = { ownerId: "owner-1", grantId: "grant-1", conversationId: "conv-1", sessionId: "session-1", runtime: "local-daemon" };
class MemoryStore implements ReasonNetworkOperationStore {
  rows = new Map<string, ReasonOperation>();
  private id(s: ReasonOperationScope, key: string) { return [s.ownerId,s.grantId,s.conversationId,s.sessionId,key].join("|"); }
  async reserve(op: ReasonOperation): Promise<ReserveResult> {
    const id = this.id(op.scope, op.idempotencyKey); const old = this.rows.get(id);
    if (old) return old.payloadDigest === op.payloadDigest && old.destination === op.destination ? { kind: "replay", operation: structuredClone(old) } : { kind: "conflict" };
    this.rows.set(id, structuredClone(op)); return { kind: "created" };
  }
  async get(s: ReasonOperationScope, key: string) { const v = this.rows.get(this.id(s,key)); return v ? structuredClone(v) : null; }
  async transition(s: ReasonOperationScope, key: string, expected: readonly ReasonOperationState[], state: ReasonOperationState, remoteMessageId?: string, now = Date.now()) {
    const id = this.id(s,key); const row = this.rows.get(id); if (!row || !expected.includes(row.state)) return false;
    this.rows.set(id,{...row,state,...(remoteMessageId ? {remoteMessageId} : {}),updatedAt:now}); return true;
  }
  async getByOperationId(ownerId:string,operationId:string){return [...this.rows.values()].find((row)=>row.scope.ownerId===ownerId&&row.operationId===operationId)??null;}
  async listByOwner(ownerId:string){return [...this.rows.values()].filter((row)=>row.scope.ownerId===ownerId);}
  async claimNext(machineId:string,claimToken:string,now=Date.now()){const row=[...this.rows.values()].find((item)=>item.companionMachineId===machineId&&item.state==="queued"&&!item.cancelRequested);if(!row)return null;const next={...row,state:"claimed" as const,claimToken,updatedAt:now};this.rows.set(this.id(row.scope,row.idempotencyKey),next);return structuredClone(next);}
  async settleClaim(machineId:string,operationId:string,claimToken:string,state:"accepted"|"unknown"|"rejected",remoteMessageId?:string,now=Date.now()){const row=await this.getByOperationId("owner-1",operationId);if(!row||row.state!=="claimed"||row.companionMachineId!==machineId||row.claimToken!==claimToken)return false;this.rows.set(this.id(row.scope,row.idempotencyKey),{...row,state,claimToken:undefined,...(remoteMessageId?{remoteMessageId}:{}),updatedAt:now});return true;}
  async cancelOperation(ownerId:string,operationId:string){const row=await this.getByOperationId(ownerId,operationId);if(!row)return "not_found" as const;if(["pending_approval","approved","queued"].includes(row.state)){this.rows.set(this.id(row.scope,row.idempotencyKey),{...row,state:"cancelled"});return "cancelled" as const;}if(row.state==="claimed"){this.rows.set(this.id(row.scope,row.idempotencyKey),{...row,cancelRequested:true});return "cancel_requested" as const;}return "not_cancellable" as const;}
  async cancelGrant(ownerId:string,grantId:string){for(const [key,row] of this.rows)if(row.scope.ownerId===ownerId&&row.scope.grantId===grantId){if(["pending_approval","approved","queued"].includes(row.state))this.rows.set(key,{...row,state:"cancelled"});else if(row.state==="claimed")this.rows.set(key,{...row,cancelRequested:true});}}
  async recover(ownerId:string,operationId:string){const row=await this.getByOperationId(ownerId,operationId);if(!row||row.state!=="unknown")return false;this.rows.set(this.id(row.scope,row.idempotencyKey),{...row,state:"queued"});return true;}
}

function fixture(options: { enabled?: boolean; connected?: boolean; toolNames?: string[]; approve?: (b: ReasonNetworkApprovalBinding) => Promise<ReasonNetworkApprovalReceipt | null>; current?: () => Promise<boolean>; call?: ReasonNetworkMcpClient["callTool"] } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown>; meta: {sessionId:string} }> = [];
  const client: ReasonNetworkMcpClient = { connected: options.connected ?? true, toolNames: options.toolNames ?? ["list_team","send_message","message_status"],
    callTool: options.call ?? (async (name,args,meta) => { calls.push({name,args,meta}); return [{type:"text",text:"sent message id msg-123"}]; }) };
  const store = new MemoryStore(); const approve = vi.fn(options.approve ?? (async (b) => ({...b,approvalId:"approval-1",expiresAt:Date.now()+60_000})));
  const current = vi.fn(options.current ?? (async () => true));
  const adapter = new ReasonNetworkAdapter({ enabled: options.enabled, scope }, client, { isCurrent: current, consume: approve }, store);
  return { adapter, calls, store, approve, current };
}

describe("Reason Network OSS adapter", () => {
  it("does not start a native process without explicit local opt-in", async () => {
    await expect(connectReasonNetworkStdio({executablePath:"/usr/local/bin/reason-network"})).rejects.toThrow("disabled");
  });

  it("persists operation state across store instances and replays the same idempotency key", async () => {
    const sqlite = new DatabaseSync(":memory:");
    const d1 = { prepare(sql: string) {
      let params: unknown[] = [];
      return {
        bind(...values: unknown[]) { params = values; return this; },
        async run() { const result = sqlite.prepare(sql).run(...params as (string | number | null)[]); return { success:true, meta:{changes:Number(result.changes)} }; },
        async first<T>() { return sqlite.prepare(sql).get(...params as (string | number | null)[]) as T | undefined ?? null; },
      };
    } } as unknown as D1Database;
    const op: ReasonOperation = {scope:{ownerId:"o",grantId:"g",conversationId:"c",sessionId:"s"},idempotencyKey:"stable",payloadDigest:"d".repeat(64),destination:"peer",state:"unknown",updatedAt:1};
    expect(await new D1ReasonNetworkOperationStore({AGENT_AUDIT:d1}).reserve(op)).toEqual({kind:"created"});
    const afterRestart = new D1ReasonNetworkOperationStore({AGENT_AUDIT:d1});
    expect(await afterRestart.reserve(op)).toMatchObject({kind:"replay",operation:{state:"pending_approval",idempotencyKey:"stable"}});
    sqlite.close();
  });

  it("exposes scoped status and cancellation only before the external send fence", async () => {
    const f = fixture({enabled:true});
    const operation: ReasonOperation = {scope,idempotencyKey:"cancel-me",payloadDigest:"a".repeat(64),destination:"peer-1",state:"pending_approval",updatedAt:1};
    await f.store.reserve(operation);
    expect(await f.adapter.operationStatus("cancel-me")).toMatchObject({state:"pending_approval"});
    expect(await f.adapter.cancelOperation("cancel-me")).toBe(true);
    expect(await f.adapter.operationStatus("cancel-me")).toMatchObject({state:"cancelled"});
    expect(f.calls).toHaveLength(0);
  });

  it("is disabled by default and never invokes approval while unavailable", async () => {
    expect(reasonNetworkReadiness({scope}).state).toBe("disabled");
    const f = fixture();
    await expect(f.adapter.sendMessage({to:"peer-1",message:"hello",idempotencyKey:"k1"})).rejects.toThrow("unavailable");
    expect(f.approve).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(0);
  });

  it("routes every operation through trusted MCP metadata and records accepted delivery", async () => {
    const f = fixture({enabled:true});
    const result = await f.adapter.sendMessage({to:"peer-1",message:"hello",idempotencyKey:"key-1",replyTo:"msg-parent"});
    expect(result).toEqual({state:"accepted",messageId:"msg-123"});
    expect(f.calls[0]?.meta).toEqual({sessionId:"session-1"});
    expect(f.calls[0]?.args).toEqual({to:"peer-1",message:"hello",idempotency_key:"key-1",reply_to:"msg-parent"});
    expect(await f.store.get(scope,"key-1")).toMatchObject({state:"accepted",remoteMessageId:"msg-123",destination:"peer-1"});
  });

  it("freezes exact message values before approval waits", async () => {
    let release!: (value: ReasonNetworkApprovalReceipt | null) => void;
    const f = fixture({enabled:true,approve: (b) => new Promise((resolve) => { release = resolve; setTimeout(() => resolve({...b,approvalId:"a",expiresAt:Date.now()+30_000}),0); })});
    const input = {to:"peer-original",message:"body-original",idempotencyKey:"stable-1"};
    const pending = f.adapter.sendMessage(input);
    input.to = "peer-mutated"; input.message = "body-mutated";
    release = release; // approval is asynchronous; the adapter dispatches its captured snapshot.
    await expect(pending).resolves.toMatchObject({state:"accepted"});
    expect(f.calls[0]?.args).toMatchObject({to:"peer-original",message:"body-original",idempotency_key:"stable-1"});
  });

  it("rejects stale scope after approval and does not dispatch", async () => {
    let checks = 0; const f = fixture({enabled:true,current:async () => ++checks === 1});
    await expect(f.adapter.sendMessage({to:"peer-1",message:"hello",idempotencyKey:"k-stale"})).rejects.toThrow("changed after approval");
    expect(f.calls).toHaveLength(0); expect(await f.store.get(scope,"k-stale")).toMatchObject({state:"rejected"});
  });

  it("checks the persistent grant before asking for approval", async () => {
    const f = fixture({enabled:true,current:async () => false});
    await expect(f.adapter.sendMessage({to:"peer-1",message:"hello",idempotencyKey:"k-revoked"})).rejects.toThrow("no longer current");
    expect(f.approve).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(0);
    expect(await f.store.get(scope,"k-revoked")).toMatchObject({state:"rejected"});
  });

  it("recovers an uncertain send only with the same key and without consuming a second approval", async () => {
    let fail = true; const f = fixture({enabled:true,call:async (name,args,meta) => { f.calls.push({name,args,meta}); if (fail) {fail=false; throw new Error("connection lost");} return [{type:"text",text:"sent message id recovered-1"}]; }});
    await expect(f.adapter.sendMessage({to:"peer-1",message:"hello",idempotencyKey:"same-key"})).resolves.toEqual({state:"unknown"});
    await expect(f.adapter.sendMessage({to:"peer-1",message:"hello",idempotencyKey:"same-key"})).resolves.toEqual({state:"accepted",messageId:"recovered-1"});
    expect(f.approve).toHaveBeenCalledTimes(1); expect(f.calls.map((c) => c.args.idempotency_key)).toEqual(["same-key","same-key"]);
  });

  it("denies payload replay with a different destination or body", async () => {
    const f = fixture({enabled:true});
    await f.adapter.sendMessage({to:"peer-1",message:"hello",idempotencyKey:"same"});
    await expect(f.adapter.sendMessage({to:"peer-2",message:"hello",idempotencyKey:"same"})).rejects.toThrow("different message");
  });

  it("does not expose upstream check_inbox because it auto-acknowledges", () => {
    expect(reasonNetworkReadiness({enabled:true,scope}, {connected:true,toolNames:["list_team","send_message","message_status"],callTool:async () => null}).inbox).toBe("unavailable_manual_ack_not_supported");
  });
});
