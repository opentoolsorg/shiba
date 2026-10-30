import type {
  ReasonNetworkApprovalBinding,
  ReasonNetworkApprovalReceipt,
  ReasonNetworkApprovalService,
  ReasonNetworkTrustedScope,
} from "./adapter.js";

export interface ReasonNetworkApprovalEnv { AGENT_AUDIT: D1Database }
export interface ReasonNetworkGrant {
  grantId: string; ownerId: string; conversationId: string; sessionId: string;
  status: "active" | "revoked"; createdAt: number; revokedAt: number | null;
}
export interface ReasonNetworkPendingApproval extends ReasonNetworkApprovalBinding {
  approvalId: string; status: "pending" | "approved" | "denied" | "consumed" | "expired";
  createdAt: number; expiresAt: number; decidedBy?: string; decidedAt?: number;
}
const SQL = [
  `CREATE TABLE IF NOT EXISTS reason_network_grants (
    grant_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, conversation_id TEXT NOT NULL, session_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active','revoked')), created_at INTEGER NOT NULL, revoked_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS reason_network_grants_owner ON reason_network_grants(owner_id,status,conversation_id,session_id)`,
  `CREATE TABLE IF NOT EXISTS reason_network_approvals (
    approval_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, grant_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
    session_id TEXT NOT NULL, destination TEXT NOT NULL, message TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    reply_to TEXT, payload_digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','consumed','expired')),
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decided_by TEXT, decided_at INTEGER,
    FOREIGN KEY(grant_id) REFERENCES reason_network_grants(grant_id)
  )`,
  `CREATE INDEX IF NOT EXISTS reason_network_approvals_pending ON reason_network_approvals(owner_id,status,created_at DESC)`,
] as const;
const initialized = new WeakSet<D1Database>();

async function ensure(env: ReasonNetworkApprovalEnv): Promise<void> {
  if (!env.AGENT_AUDIT) throw new Error("Reason Network approval storage is unavailable.");
  if (initialized.has(env.AGENT_AUDIT)) return;
  for (const sql of SQL) await env.AGENT_AUDIT.prepare(sql).run();
  initialized.add(env.AGENT_AUDIT);
}
const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
async function payloadDigest(value: Pick<ReasonNetworkApprovalBinding,"destination"|"message"|"replyTo">): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({ to: value.destination, message: value.message, replyTo: value.replyTo ?? null }));
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}
function bindingFromRow(row: Record<string, unknown>): ReasonNetworkApprovalBinding {
  return {
    ownerId: String(row.owner_id), grantId: String(row.grant_id), conversationId: String(row.conversation_id), sessionId: String(row.session_id),
    destination: String(row.destination), message: String(row.message), idempotencyKey: String(row.idempotency_key),
    ...(typeof row.reply_to === "string" ? { replyTo: row.reply_to } : {}), payloadDigest: String(row.payload_digest),
  };
}

export async function createReasonNetworkGrant(env: ReasonNetworkApprovalEnv, input: { grantId: string; ownerId: string; conversationId: string; sessionId: string; now?: number }): Promise<ReasonNetworkGrant> {
  await ensure(env);
  if (!input.grantId || !input.ownerId || !input.conversationId || !input.sessionId) throw new Error("A specific owner, conversation, and session are required.");
  const createdAt = input.now ?? Date.now();
  await env.AGENT_AUDIT.prepare(`INSERT INTO reason_network_grants(grant_id,owner_id,conversation_id,session_id,status,created_at,revoked_at) VALUES(?,?,?,?,'active',?,NULL)`)
    .bind(input.grantId,input.ownerId,input.conversationId,input.sessionId,createdAt).run();
  return { grantId: input.grantId, ownerId: input.ownerId, conversationId: input.conversationId, sessionId: input.sessionId, status: "active", createdAt, revokedAt: null };
}

export async function listReasonNetworkGrants(env: ReasonNetworkApprovalEnv, ownerId: string): Promise<ReasonNetworkGrant[]> {
  await ensure(env);
  const rows=await env.AGENT_AUDIT.prepare(`SELECT grant_id,owner_id,conversation_id,session_id,status,created_at,revoked_at FROM reason_network_grants WHERE owner_id=? ORDER BY created_at DESC LIMIT 50`).bind(ownerId).all<Record<string,unknown>>();
  return (rows.results??[]).map((row)=>({grantId:String(row.grant_id),ownerId:String(row.owner_id),conversationId:String(row.conversation_id),sessionId:String(row.session_id),status:row.status as "active"|"revoked",createdAt:Number(row.created_at),revokedAt:row.revoked_at===null?null:Number(row.revoked_at)}));
}

export async function revokeReasonNetworkGrant(env: ReasonNetworkApprovalEnv, ownerId: string, grantId: string, now = Date.now()): Promise<boolean> {
  await ensure(env);
  const result = await env.AGENT_AUDIT.prepare(`UPDATE reason_network_grants SET status='revoked',revoked_at=? WHERE owner_id=? AND grant_id=? AND status='active'`).bind(now,ownerId,grantId).run();
  return result.meta?.changes === 1;
}

export async function reasonNetworkApprovalSetup(env: ReasonNetworkApprovalEnv, ownerId: string): Promise<{ activeGrants: number; pendingApprovals: number }> {
  await ensure(env);
  const [grants, approvals] = await Promise.all([
    env.AGENT_AUDIT.prepare(`SELECT COUNT(*) AS count FROM reason_network_grants WHERE owner_id=? AND status='active'`).bind(ownerId).first<{count:number}>(),
    env.AGENT_AUDIT.prepare(`SELECT COUNT(*) AS count FROM reason_network_approvals WHERE owner_id=? AND status='pending' AND expires_at>?`).bind(ownerId,Date.now()).first<{count:number}>(),
  ]);
  return { activeGrants:Number(grants?.count??0), pendingApprovals:Number(approvals?.count??0) };
}

export async function requestReasonNetworkApproval(env: ReasonNetworkApprovalEnv, input: Omit<ReasonNetworkApprovalBinding,"payloadDigest"> & { now?: number; expiresAt: number }): Promise<ReasonNetworkPendingApproval> {
  await ensure(env);
  const digest = await payloadDigest(input);
  const approvalId = `rna-${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
  const now = input.now ?? Date.now();
  if (input.expiresAt <= now || input.expiresAt > now + 24 * 60 * 60_000) throw new Error("Approval expiry must be within 24 hours.");
  const grant = await env.AGENT_AUDIT.prepare(`SELECT 1 FROM reason_network_grants WHERE owner_id=? AND grant_id=? AND conversation_id=? AND session_id=? AND status='active'`)
    .bind(input.ownerId,input.grantId,input.conversationId,input.sessionId).first();
  if (!grant) throw new Error("An active grant for this exact conversation and session is required.");
  await env.AGENT_AUDIT.prepare(`INSERT INTO reason_network_approvals(approval_id,owner_id,grant_id,conversation_id,session_id,destination,message,idempotency_key,reply_to,payload_digest,status,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).bind(approvalId,input.ownerId,input.grantId,input.conversationId,input.sessionId,input.destination,input.message,input.idempotencyKey,input.replyTo ?? null,digest,now,input.expiresAt).run();
  return { approvalId, ownerId: input.ownerId, grantId: input.grantId, conversationId: input.conversationId, sessionId: input.sessionId,
    destination: input.destination, message: input.message, idempotencyKey: input.idempotencyKey, ...(input.replyTo ? { replyTo: input.replyTo } : {}), payloadDigest: digest,
    status: "pending", createdAt: now, expiresAt: input.expiresAt };
}

export async function listReasonNetworkApprovals(env: ReasonNetworkApprovalEnv, ownerId: string, status: ReasonNetworkPendingApproval["status"] = "pending"): Promise<ReasonNetworkPendingApproval[]> {
  await ensure(env);
  const rows = await env.AGENT_AUDIT.prepare(`SELECT * FROM reason_network_approvals WHERE owner_id=? AND status=? ORDER BY created_at DESC LIMIT 50`).bind(ownerId,status).all<Record<string,unknown>>();
  return (rows.results ?? []).map((row) => ({ approvalId:String(row.approval_id), ...bindingFromRow(row), status:row.status as ReasonNetworkPendingApproval["status"], createdAt:Number(row.created_at), expiresAt:Number(row.expires_at), ...(typeof row.decided_by === "string" ? { decidedBy:row.decided_by } : {}), ...(typeof row.decided_at === "number" ? { decidedAt:row.decided_at } : {}) }));
}

export async function decideReasonNetworkApproval(env: ReasonNetworkApprovalEnv, input: { ownerId:string; approvalId:string; approved:boolean; decidedBy:string; now?:number }): Promise<boolean> {
  await ensure(env);
  const now=input.now ?? Date.now();
  const result=await env.AGENT_AUDIT.prepare(`UPDATE reason_network_approvals SET status=?,decided_by=?,decided_at=? WHERE owner_id=? AND approval_id=? AND status='pending' AND expires_at>?`)
    .bind(input.approved?"approved":"denied",input.decidedBy,now,input.ownerId,input.approvalId,now).run();
  return result.meta?.changes===1;
}

/** One-use, exact payload approval adapter. It does not start or call the native client. */
export class D1ReasonNetworkApprovalService implements ReasonNetworkApprovalService {
  constructor(private readonly env: ReasonNetworkApprovalEnv) {}
  async isCurrent(scope: ReasonNetworkTrustedScope): Promise<boolean> {
    await ensure(this.env);
    const row=await this.env.AGENT_AUDIT.prepare(`SELECT 1 FROM reason_network_grants WHERE owner_id=? AND grant_id=? AND conversation_id=? AND session_id=? AND status='active'`)
      .bind(scope.ownerId,scope.grantId,scope.conversationId,scope.sessionId).first();
    return !!row;
  }
  async consume(binding: ReasonNetworkApprovalBinding): Promise<ReasonNetworkApprovalReceipt|null> {
    await ensure(this.env);
    const digest=await payloadDigest(binding);
    if (digest!==binding.payloadDigest) return null;
    const now=Date.now();
    const result=await this.env.AGENT_AUDIT.prepare(`UPDATE reason_network_approvals SET status='consumed',decided_at=?
      WHERE approval_id=(SELECT a.approval_id FROM reason_network_approvals a JOIN reason_network_grants g ON g.grant_id=a.grant_id
        WHERE a.owner_id=? AND a.grant_id=? AND a.conversation_id=? AND a.session_id=? AND a.destination=? AND a.message=? AND a.idempotency_key=?
          AND a.reply_to IS ? AND a.payload_digest=? AND a.status='approved' AND a.expires_at>? AND g.status='active'
          AND g.owner_id=a.owner_id AND g.conversation_id=a.conversation_id AND g.session_id=a.session_id ORDER BY a.created_at DESC LIMIT 1)
      AND status='approved' RETURNING approval_id,expires_at`).bind(now,binding.ownerId,binding.grantId,binding.conversationId,binding.sessionId,binding.destination,binding.message,binding.idempotencyKey,binding.replyTo??null,binding.payloadDigest,now).first<{approval_id:string;expires_at:number}>();
    return result ? { ...binding, approvalId:result.approval_id, expiresAt:Number(result.expires_at) } : null;
  }
}
