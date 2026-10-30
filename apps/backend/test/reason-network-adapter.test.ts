import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { ReasonNetworkAdapter, reasonNetworkReadiness, type ReasonNetworkApprovalBinding, type ReasonNetworkApprovalReceipt, type ReasonNetworkMcpClient, type ReasonNetworkTrustedScope } from "../src/reason-network/adapter.js";
import { D1ReasonNetworkOperationStore, type ReasonOperation, type ReasonNetworkOperationStore, type ReasonOperationScope, type ReserveResult, type ReasonOperationState } from "../src/reason-network/operation-store.js";
import { connectReasonNetworkStdio } from "../src/reason-network/stdio-client.js";
import { createReasonNetworkGrant, listReasonNetworkGrants } from "../src/reason-network/approval-store.js";
import { REASON_NETWORK_RECOVERY_WINDOW_MS } from "../src/reason-network/operation-store.js";

function sqliteD1(sqlite:DatabaseSync):D1Database{
  return {prepare(sql:string){let params:unknown[]=[];return {
    bind(...values:unknown[]){params=values;return this;},
    async run(){const result=sqlite.prepare(sql).run(...params as (string|number|null)[]);return {success:true,meta:{changes:Number(result.changes)}};},
    async first<T>(){return sqlite.prepare(sql).get(...params as (string|number|null)[]) as T|undefined??null;},
    async all<T>(){return {results:sqlite.prepare(sql).all(...params as (string|number|null)[]) as T[]};},
  };}} as unknown as D1Database;
}

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
    this.rows.set(id,{...row,state,...(state==="unknown"?{firstAttemptAt:row.firstAttemptAt??now}:{}),...(remoteMessageId ? {remoteMessageId} : {}),updatedAt:now}); return true;
  }
  async getByOperationId(ownerId:string,operationId:string){return [...this.rows.values()].find((row)=>row.scope.ownerId===ownerId&&row.operationId===operationId)??null;}
  async getByCompanionOperationId(machineId:string,operationId:string){return [...this.rows.values()].find((row)=>row.companionMachineId===machineId&&row.operationId===operationId)??null;}
  async listByOwner(ownerId:string){return [...this.rows.values()].filter((row)=>row.scope.ownerId===ownerId);}
  async claimNext(machineId:string,claimToken:string,now=Date.now()){for(const [key,row] of this.rows)if(row.companionMachineId===machineId&&row.state==="queued"&&row.firstAttemptAt!==null&&row.firstAttemptAt!==undefined&&row.firstAttemptAt<=now-REASON_NETWORK_RECOVERY_WINDOW_MS)this.rows.set(key,{...row,state:"unknown",claimToken:undefined,updatedAt:now});const row=[...this.rows.values()].find((item)=>item.companionMachineId===machineId&&item.state==="queued"&&!item.cancelRequested&&(item.firstAttemptAt===null||item.firstAttemptAt===undefined||item.firstAttemptAt>now-REASON_NETWORK_RECOVERY_WINDOW_MS));if(!row)return null;const next={...row,state:"claimed" as const,claimToken,firstAttemptAt:row.firstAttemptAt??now,updatedAt:now};this.rows.set(this.id(row.scope,row.idempotencyKey),next);return structuredClone(next);}
  async expireClaim(machineId:string,operationId:string,now=Date.now()){const row=await this.getByOperationId("owner-1",operationId);if(!row||row.companionMachineId!==machineId||row.state!=="claimed"||row.firstAttemptAt===null||row.firstAttemptAt===undefined||row.firstAttemptAt>now-REASON_NETWORK_RECOVERY_WINDOW_MS)return false;this.rows.set(this.id(row.scope,row.idempotencyKey),{...row,state:"unknown",claimToken:undefined,updatedAt:now});return true;}
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
    const d1=sqliteD1(sqlite);
    const op: ReasonOperation = {scope:{ownerId:"o",grantId:"g",conversationId:"c",sessionId:"s"},idempotencyKey:"stable",payloadDigest:"d".repeat(64),destination:"peer",state:"unknown",updatedAt:1};
    expect(await new D1ReasonNetworkOperationStore({AGENT_AUDIT:d1}).reserve(op)).toEqual({kind:"created"});
    const afterRestart = new D1ReasonNetworkOperationStore({AGENT_AUDIT:d1});
    expect(await afterRestart.reserve(op)).toMatchObject({kind:"replay",operation:{state:"pending_approval",idempotencyKey:"stable"}});
    sqlite.close();
  });

  it("migrates the previous D1 schema without losing operation states or grant rows",async()=>{
    const sqlite=new DatabaseSync(":memory:");
    sqlite.exec(`CREATE TABLE reason_network_grants(grant_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,conversation_id TEXT NOT NULL,session_id TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,revoked_at INTEGER);
      INSERT INTO reason_network_grants VALUES('grant-old','owner-old','conv-old','session-old','active',123,NULL);
      CREATE TABLE reason_network_operations(owner_id TEXT NOT NULL,grant_id TEXT NOT NULL,conversation_id TEXT NOT NULL,session_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,payload_digest TEXT NOT NULL,destination TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending_approval','approved','accepted','unknown','rejected','cancelled')),remote_message_id TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(owner_id,grant_id,conversation_id,session_id,idempotency_key));
      INSERT INTO reason_network_operations VALUES('owner-old','grant-old','conv-old','session-old','key-unknown','digest-unknown','peer-old','unknown',NULL,456);
      INSERT INTO reason_network_operations VALUES('owner-old','grant-old','conv-old','session-old','key-accepted','digest-accepted','peer-old','accepted','remote-old',789);`);
    const db=sqliteD1(sqlite);const store=new D1ReasonNetworkOperationStore({AGENT_AUDIT:db});
    const scope={ownerId:"owner-old",grantId:"grant-old",conversationId:"conv-old",sessionId:"session-old"};
    const [unknown,accepted]=await Promise.all([store.get(scope,"key-unknown"),new D1ReasonNetworkOperationStore({AGENT_AUDIT:db}).get(scope,"key-accepted")]);
    expect(unknown).toMatchObject({state:"unknown",firstAttemptAt:0});
    expect(unknown?.operationId).toMatch(/^rno-legacy-/);
    expect(accepted).toMatchObject({state:"accepted",remoteMessageId:"remote-old"});
    expect(await listReasonNetworkGrants({AGENT_AUDIT:db},"owner-old")).toMatchObject([{grantId:"grant-old",companionMachineId:null,status:"active"}]);
    await db.prepare("UPDATE reason_network_grants SET companion_machine_id='machine-old' WHERE grant_id='grant-old'").run();
    expect(await store.recover("owner-old",unknown!.operationId!,Date.now())).toBe(false);
    sqlite.close();
  });

  it("retries an interrupted additive schema upgrade without rebuilding the operation ledger",async()=>{
    const sqlite=new DatabaseSync(":memory:");
    sqlite.exec(`CREATE TABLE reason_network_grants(grant_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,conversation_id TEXT NOT NULL,session_id TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,revoked_at INTEGER);
      CREATE TABLE reason_network_operations(owner_id TEXT NOT NULL,grant_id TEXT NOT NULL,conversation_id TEXT NOT NULL,session_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,payload_digest TEXT NOT NULL,destination TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending_approval','approved','accepted','unknown','rejected','cancelled')),remote_message_id TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(owner_id,grant_id,conversation_id,session_id,idempotency_key));
      INSERT INTO reason_network_operations VALUES('owner-partial','grant-partial','conv-partial','session-partial','key-partial','digest-partial','peer-partial','unknown',NULL,456);
      ALTER TABLE reason_network_operations ADD COLUMN operation_id TEXT;
      UPDATE reason_network_operations SET operation_id='rno-partial-upgrade';`);
    const db=sqliteD1(sqlite);const scope={ownerId:"owner-partial",grantId:"grant-partial",conversationId:"conv-partial",sessionId:"session-partial"};
    const migrated=await new D1ReasonNetworkOperationStore({AGENT_AUDIT:db}).get(scope,"key-partial");
    expect(migrated).toMatchObject({operationId:"rno-partial-upgrade",state:"unknown",firstAttemptAt:0});
    const columns=await db.prepare("PRAGMA table_info(reason_network_operations)").all<{name:string}>();
    expect(columns.results?.map((column)=>column.name)).toContain("dispatch_state");
    expect(await new D1ReasonNetworkOperationStore({AGENT_AUDIT:db}).get(scope,"key-partial")).toMatchObject({operationId:"rno-partial-upgrade",state:"unknown"});
    sqlite.close();
  });

  it("keeps unknown outcomes recoverable only inside upstream's conservative idempotency window",async()=>{
    const sqlite=new DatabaseSync(":memory:");const now=10_000_000;const db=sqliteD1(sqlite);
    await createReasonNetworkGrant({AGENT_AUDIT:db},{grantId:"grant-window",ownerId:"owner-window",conversationId:"conv-window",sessionId:"session-window",companionMachineId:"machine-window",now});
    const scope={ownerId:"owner-window",grantId:"grant-window",conversationId:"conv-window",sessionId:"session-window"};
    const store=new D1ReasonNetworkOperationStore({AGENT_AUDIT:db},()=>now);
    await store.reserve({operationId:"rno-window",approvalId:"approval-window",companionMachineId:"machine-window",scope,idempotencyKey:"stable-window",payloadDigest:"f".repeat(64),destination:"peer",state:"pending_approval",updatedAt:now});
    await store.transition(scope,"stable-window",["pending_approval"],"queued",undefined,now);
    const claimed=await store.claimNext("machine-window","claim-window",now);
    expect(claimed?.firstAttemptAt).toBe(now);
    await store.settleClaim("machine-window","rno-window","claim-window","unknown",undefined,now);
    expect(await store.recover("owner-window","rno-window",now+REASON_NETWORK_RECOVERY_WINDOW_MS-1)).toBe(true);
    expect(await store.claimNext("machine-window","claim-too-late",now+REASON_NETWORK_RECOVERY_WINDOW_MS)).toBeNull();
    expect((await store.get(scope,"stable-window"))?.state).toBe("unknown");
    expect(await store.recover("owner-window","rno-window",now+REASON_NETWORK_RECOVERY_WINDOW_MS)).toBe(false);
    expect((await store.get(scope,"stable-window"))?.state).toBe("unknown");
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
    const f = fixture({enabled:true,approve: (b) => new Promise((resolve) => { setTimeout(() => resolve({...b,approvalId:"a",expiresAt:Date.now()+30_000}),0); })});
    const input = {to:"peer-original",message:"body-original",idempotencyKey:"stable-1"};
    const pending = f.adapter.sendMessage(input);
    input.to = "peer-mutated"; input.message = "body-mutated";
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
