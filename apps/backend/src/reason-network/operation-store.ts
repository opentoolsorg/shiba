/** Durable ledger for Reason Network sends. Never store message bodies here. */
export type ReasonOperationState = "pending_approval" | "approved" | "queued" | "claimed" | "accepted" | "unknown" | "rejected" | "cancelled";

export interface ReasonOperationScope {
  ownerId: string;
  grantId: string;
  conversationId: string;
  sessionId: string;
}

export interface ReasonOperation {
  operationId?: string;
  approvalId?: string;
  companionMachineId?: string;
  claimToken?: string;
  cancelRequested?: boolean;
  scope: ReasonOperationScope;
  idempotencyKey: string;
  payloadDigest: string;
  destination: string;
  state: ReasonOperationState;
  remoteMessageId?: string;
  updatedAt: number;
}

export type ReserveResult = { kind: "created" } | { kind: "replay"; operation: ReasonOperation } | { kind: "conflict" };

export interface ReasonNetworkOperationStore {
  reserve(operation: ReasonOperation): Promise<ReserveResult>;
  get(scope: ReasonOperationScope, key: string): Promise<ReasonOperation | null>;
  transition(scope: ReasonOperationScope, key: string, expected: readonly ReasonOperationState[], next: ReasonOperationState, remoteMessageId?: string, now?: number): Promise<boolean>;
  getByOperationId(ownerId: string, operationId: string): Promise<ReasonOperation | null>;
  listByOwner(ownerId:string,limit?:number):Promise<ReasonOperation[]>;
  claimNext(machineId: string, claimToken: string, now?: number): Promise<ReasonOperation | null>;
  settleClaim(machineId: string, operationId: string, claimToken: string, state: "accepted" | "unknown" | "rejected" | "cancelled", remoteMessageId?: string, now?: number): Promise<boolean>;
  cancelOperation(ownerId: string, operationId: string, now?: number): Promise<"cancelled" | "cancel_requested" | "not_cancellable" | "not_found">;
  cancelGrant(ownerId:string,grantId:string,now?:number):Promise<void>;
  recover(ownerId: string, operationId: string, now?: number): Promise<boolean>;
}

export interface ReasonNetworkOperationEnv { AGENT_AUDIT: D1Database }

export const REASON_NETWORK_OPERATION_SQL = [
  `CREATE TABLE IF NOT EXISTS reason_network_operations (
    owner_id TEXT NOT NULL, grant_id TEXT NOT NULL, conversation_id TEXT NOT NULL, session_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL, payload_digest TEXT NOT NULL, destination TEXT NOT NULL,
    operation_id TEXT NOT NULL UNIQUE, approval_id TEXT, companion_machine_id TEXT, claim_token TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL CHECK (state IN ('pending_approval','approved','queued','claimed','accepted','unknown','rejected','cancelled')), remote_message_id TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(owner_id, grant_id, conversation_id, session_id, idempotency_key)
  )`,
] as const;

interface DbRow {
  owner_id: string; grant_id: string; conversation_id: string; session_id: string;
  operation_id:string;approval_id:string|null;companion_machine_id:string|null;claim_token:string|null;cancel_requested:number;
  idempotency_key: string; payload_digest: string; destination: string; state: ReasonOperationState;
  remote_message_id: string | null; updated_at: number;
}

const initialized = new WeakSet<D1Database>();
async function ensure(env: ReasonNetworkOperationEnv): Promise<void> {
  if (initialized.has(env.AGENT_AUDIT)) return;
  for (const sql of REASON_NETWORK_OPERATION_SQL) await env.AGENT_AUDIT.prepare(sql).run();
  initialized.add(env.AGENT_AUDIT);
}
function fromRow(row: DbRow): ReasonOperation {
  return {
    scope: { ownerId: row.owner_id, grantId: row.grant_id, conversationId: row.conversation_id, sessionId: row.session_id },
    operationId:row.operation_id,...(row.approval_id?{approvalId:row.approval_id}:{}),...(row.companion_machine_id?{companionMachineId:row.companion_machine_id}:{}),...(row.claim_token?{claimToken:row.claim_token}:{}),...(row.cancel_requested?{cancelRequested:true}:{}),
    idempotencyKey: row.idempotency_key, payloadDigest: row.payload_digest, destination: row.destination,
    state: row.state, ...(row.remote_message_id ? { remoteMessageId: row.remote_message_id } : {}), updatedAt: row.updated_at,
  };
}
const SELECT = `SELECT operation_id,approval_id,companion_machine_id,claim_token,cancel_requested,owner_id,grant_id,conversation_id,session_id,idempotency_key,payload_digest,destination,state,remote_message_id,updated_at FROM reason_network_operations`;

/** D1-backed store; the injected database is the durability boundary. */
export class D1ReasonNetworkOperationStore implements ReasonNetworkOperationStore {
  constructor(private readonly env: ReasonNetworkOperationEnv, private readonly now: () => number = Date.now) {}
  async reserve(op: ReasonOperation): Promise<ReserveResult> {
    await ensure(this.env);
    const s = op.scope;
    const inserted = await this.env.AGENT_AUDIT.prepare(`INSERT OR IGNORE INTO reason_network_operations
      (operation_id,approval_id,companion_machine_id,owner_id,grant_id,conversation_id,session_id,idempotency_key,payload_digest,destination,state,remote_message_id,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'pending_approval',NULL,?)`).bind(op.operationId??`rno-${crypto.randomUUID()}`,op.approvalId??null,op.companionMachineId??null,s.ownerId,s.grantId,s.conversationId,s.sessionId,op.idempotencyKey,op.payloadDigest,op.destination,op.updatedAt || this.now()).run();
    if (inserted.meta?.changes === 1) return { kind: "created" };
    const old = await this.get(s, op.idempotencyKey);
    return old && old.payloadDigest === op.payloadDigest && old.destination === op.destination
      ? { kind: "replay", operation: old } : { kind: "conflict" };
  }
  async get(scope: ReasonOperationScope, key: string): Promise<ReasonOperation | null> {
    await ensure(this.env); const row = await this.env.AGENT_AUDIT.prepare(`${SELECT} WHERE owner_id=? AND grant_id=? AND conversation_id=? AND session_id=? AND idempotency_key=?`)
      .bind(scope.ownerId,scope.grantId,scope.conversationId,scope.sessionId,key).first<DbRow>();
    return row ? fromRow(row) : null;
  }
  async transition(scope: ReasonOperationScope, key: string, expected: readonly ReasonOperationState[], next: ReasonOperationState, remoteMessageId?: string, now = this.now()): Promise<boolean> {
    if (!expected.length) return false;
    await ensure(this.env); const placeholders = expected.map(() => "?").join(",");
    const result = await this.env.AGENT_AUDIT.prepare(`UPDATE reason_network_operations SET state=?, remote_message_id=COALESCE(?,remote_message_id), updated_at=?
      WHERE owner_id=? AND grant_id=? AND conversation_id=? AND session_id=? AND idempotency_key=? AND state IN (${placeholders})`)
      .bind(next,remoteMessageId ?? null,now,scope.ownerId,scope.grantId,scope.conversationId,scope.sessionId,key,...expected).run();
    return result.meta?.changes === 1;
  }

  async getByOperationId(ownerId:string,operationId:string):Promise<ReasonOperation|null>{
    await ensure(this.env);const row=await this.env.AGENT_AUDIT.prepare(`${SELECT} WHERE owner_id=? AND operation_id=?`).bind(ownerId,operationId).first<DbRow>();return row?fromRow(row):null;
  }
  async listByOwner(ownerId:string,limit=50):Promise<ReasonOperation[]>{
    await ensure(this.env);const rows=await this.env.AGENT_AUDIT.prepare(`${SELECT} WHERE owner_id=? ORDER BY updated_at DESC LIMIT ?`).bind(ownerId,Math.max(1,Math.min(100,limit))).all<DbRow>();return (rows.results??[]).map(fromRow);
  }
  async claimNext(machineId:string,claimToken:string,now=this.now()):Promise<ReasonOperation|null>{
    await ensure(this.env);
    await this.env.AGENT_AUDIT.prepare(`UPDATE reason_network_operations SET state='unknown',claim_token=NULL,updated_at=? WHERE companion_machine_id=? AND state='claimed' AND updated_at<?`)
      .bind(now,machineId,now-60_000).run();
    const candidate=await this.env.AGENT_AUDIT.prepare(`${SELECT} WHERE companion_machine_id=? AND state='queued' AND cancel_requested=0
      AND EXISTS(SELECT 1 FROM reason_network_grants g WHERE g.owner_id=reason_network_operations.owner_id AND g.grant_id=reason_network_operations.grant_id
        AND g.conversation_id=reason_network_operations.conversation_id AND g.session_id=reason_network_operations.session_id
        AND g.companion_machine_id=reason_network_operations.companion_machine_id AND g.status='active') ORDER BY updated_at LIMIT 1`).bind(machineId).first<DbRow>();
    if(!candidate)return null;
    const result=await this.env.AGENT_AUDIT.prepare(`UPDATE reason_network_operations SET state='claimed',claim_token=?,updated_at=? WHERE operation_id=? AND companion_machine_id=? AND state='queued' AND cancel_requested=0`).bind(claimToken,now,candidate.operation_id,machineId).run();
    return result.meta?.changes===1?this.getByOperationId(candidate.owner_id,candidate.operation_id):null;
  }
  async settleClaim(machineId:string,operationId:string,claimToken:string,state:"accepted"|"unknown"|"rejected"|"cancelled",remoteMessageId?:string,now=this.now()):Promise<boolean>{
    await ensure(this.env);const result=await this.env.AGENT_AUDIT.prepare(`UPDATE reason_network_operations SET state=?,remote_message_id=COALESCE(?,remote_message_id),claim_token=NULL,updated_at=? WHERE operation_id=? AND companion_machine_id=? AND claim_token=? AND state='claimed'`).bind(state,remoteMessageId??null,now,operationId,machineId,claimToken).run();return result.meta?.changes===1;
  }
  async cancelOperation(ownerId:string,operationId:string,now=this.now()):Promise<"cancelled"|"cancel_requested"|"not_cancellable"|"not_found">{
    await ensure(this.env);const row=await this.getByOperationId(ownerId,operationId);if(!row)return "not_found";
    if(["pending_approval","approved","queued"].includes(row.state)){const result=await this.env.AGENT_AUDIT.prepare(`UPDATE reason_network_operations SET state='cancelled',updated_at=? WHERE owner_id=? AND operation_id=? AND state IN ('pending_approval','approved','queued')`).bind(now,ownerId,operationId).run();return result.meta?.changes===1?"cancelled":"not_cancellable";}
    if(row.state==="claimed"){await this.env.AGENT_AUDIT.prepare(`UPDATE reason_network_operations SET cancel_requested=1,updated_at=? WHERE owner_id=? AND operation_id=? AND state='claimed'`).bind(now,ownerId,operationId).run();return "cancel_requested";}
    return "not_cancellable";
  }
  async cancelGrant(ownerId:string,grantId:string,now=this.now()):Promise<void>{
    await ensure(this.env);
    await this.env.AGENT_AUDIT.prepare(`UPDATE reason_network_operations SET state='cancelled',updated_at=? WHERE owner_id=? AND grant_id=? AND state IN ('pending_approval','approved','queued')`).bind(now,ownerId,grantId).run();
    await this.env.AGENT_AUDIT.prepare(`UPDATE reason_network_operations SET cancel_requested=1,updated_at=? WHERE owner_id=? AND grant_id=? AND state='claimed'`).bind(now,ownerId,grantId).run();
  }
  async recover(ownerId:string,operationId:string,now=this.now()):Promise<boolean>{
    await ensure(this.env);const result=await this.env.AGENT_AUDIT.prepare(`UPDATE reason_network_operations SET state='queued',claim_token=NULL,cancel_requested=0,updated_at=? WHERE owner_id=? AND operation_id=? AND state='unknown' AND companion_machine_id IS NOT NULL
      AND EXISTS(SELECT 1 FROM reason_network_grants g WHERE g.owner_id=reason_network_operations.owner_id AND g.grant_id=reason_network_operations.grant_id AND g.status='active' AND g.companion_machine_id=reason_network_operations.companion_machine_id)`).bind(now,ownerId,operationId).run();return result.meta?.changes===1;
  }
}
