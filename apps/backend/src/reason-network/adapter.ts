import { type ReasonOperation, type ReasonNetworkOperationStore, type ReasonOperationScope } from "./operation-store.js";
import { REASON_NETWORK_RECOVERY_WINDOW_MS } from "./operation-store.js";

export const REASON_NETWORK_PIN = "0.12.17" as const;
export const REASON_NETWORK_MCP_COMMAND = "reason-network mcp" as const;
export const REASON_NETWORK_TOOLS = ["list_team", "send_message", "message_status"] as const;
export type ReasonNetworkTool = (typeof REASON_NETWORK_TOOLS)[number];

export interface ReasonNetworkMcpClient {
  readonly connected: boolean;
  readonly toolNames: readonly string[];
  /** MCP request metadata is the supported upstream session-routing surface. */
  callTool(name: ReasonNetworkTool, args: Record<string, unknown>, meta: { sessionId: string }): Promise<unknown>;
}

export interface ReasonNetworkTrustedScope extends ReasonOperationScope {
  runtime: "local-daemon" | "cloudflare-worker";
}

export interface ReasonNetworkApprovalBinding {
  readonly ownerId: string; readonly grantId: string; readonly conversationId: string; readonly sessionId: string;
  readonly destination: string; readonly message: string; readonly idempotencyKey: string; readonly replyTo?: string;
  readonly payloadDigest: string;
}
export interface ReasonNetworkApprovalReceipt extends ReasonNetworkApprovalBinding {
  readonly approvalId: string; readonly expiresAt: number;
}

/** Implement with the trusted Shiba persistent approval/policy service. */
export interface ReasonNetworkApprovalService {
  isCurrent(scope: ReasonNetworkTrustedScope): Promise<boolean>;
  consume(binding: ReasonNetworkApprovalBinding): Promise<ReasonNetworkApprovalReceipt | null>;
}

export interface ReasonNetworkAdapterConfig { readonly enabled?: boolean; readonly scope: ReasonNetworkTrustedScope }
export interface ReasonNetworkReadiness {
  provider: "reason-network-oss"; enabled: boolean;
  state: "disabled" | "unsupported_runtime" | "mcp_disconnected" | "mcp_tools_missing" | "connected_unverified";
  defaultEnabled: false; upstreamVersion: typeof REASON_NETWORK_PIN; transport: "local-stdio-mcp";
  networkMembership: "not_checked"; inbox: "unavailable_manual_ack_not_supported";
  sendMayWakeRecipient: true; automaticInstall: false; automaticJoin: false;
}

export class ReasonNetworkUnavailableError extends Error { constructor(readonly state: ReasonNetworkReadiness["state"]) { super(`Reason Network unavailable: ${state}`); } }
export class ReasonNetworkSendDeniedError extends Error { constructor(message = "A current one-use approval for this exact message is required.") { super(message); } }

export function reasonNetworkReadiness(config: ReasonNetworkAdapterConfig, client?: ReasonNetworkMcpClient): ReasonNetworkReadiness {
  const enabled = config.enabled === true;
  const state = !enabled ? "disabled" : config.scope.runtime !== "local-daemon" ? "unsupported_runtime" : !client?.connected ? "mcp_disconnected" :
    REASON_NETWORK_TOOLS.some((name) => !client.toolNames.includes(name)) ? "mcp_tools_missing" : "connected_unverified";
  return { provider: "reason-network-oss", enabled, state, defaultEnabled: false, upstreamVersion: REASON_NETWORK_PIN,
    transport: "local-stdio-mcp", networkMembership: "not_checked", inbox: "unavailable_manual_ack_not_supported",
    sendMayWakeRecipient: true, automaticInstall: false, automaticJoin: false };
}

function validRecipient(to: string): boolean { return !!to.trim() && !/[\s*]/.test(to) && !to.startsWith("repo:") && !to.endsWith("/*"); }
async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function remoteId(result: unknown): string | undefined {
  const text = typeof result === "string" ? result : JSON.stringify(result);
  return text.match(/\bmessage id\s+([A-Za-z0-9._:-]+)\b/i)?.[1];
}

/**
 * Explicit-call adapter. Construction has no side effects; it never starts a process,
 * polls inboxes, installs software, joins a network, or exposes peer text as authority.
 */
export class ReasonNetworkAdapter {
  constructor(private readonly config: ReasonNetworkAdapterConfig, private readonly client?: ReasonNetworkMcpClient,
    private readonly approvals?: ReasonNetworkApprovalService, private readonly operations?: ReasonNetworkOperationStore,
    private readonly now: () => number = Date.now) {}

  readiness(): ReasonNetworkReadiness { return reasonNetworkReadiness(this.config, this.client); }

  async listTeam(filter?: string): Promise<unknown> {
    this.assertAvailable();
    return this.call("list_team", { ...(filter ? { filter } : {}) });
  }

  async sendMessage(input: { to: string; message: string; idempotencyKey: string; replyTo?: string }): Promise<{ state: "accepted" | "unknown" | "rejected"; messageId?: string; replayed?: boolean }> {
    // All caller data is copied before the first await and all later operations use this snapshot.
    const to = String(input.to); const message = String(input.message); const key = String(input.idempotencyKey);
    const replyTo = input.replyTo === undefined ? undefined : String(input.replyTo);
    if (!validRecipient(to) || !message.trim() || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new TypeError("A single exact recipient, message, and stable idempotency key are required.");
    this.assertAvailable();
    const scope = Object.freeze({ ...this.config.scope });
    if (!scope.ownerId || !scope.grantId || !scope.conversationId || !scope.sessionId) throw new ReasonNetworkSendDeniedError("Trusted owner, grant, conversation, and session scope are required.");
    if (!this.approvals || !this.operations) throw new ReasonNetworkSendDeniedError("Persistent approval and operation services are required.");
    const payloadDigest = await digest({ to, message, replyTo: replyTo ?? null });
    const binding: ReasonNetworkApprovalBinding = Object.freeze({ ownerId: scope.ownerId, grantId: scope.grantId,
      conversationId: scope.conversationId, sessionId: scope.sessionId, destination: to, message, idempotencyKey: key,
      ...(replyTo ? { replyTo } : {}), payloadDigest });
    const op: ReasonOperation = { scope, idempotencyKey: key, payloadDigest, destination: to, state: "pending_approval", updatedAt: this.now() };
    const reserved = await this.operations.reserve(op);
    if (reserved.kind === "conflict") throw new ReasonNetworkSendDeniedError("Idempotency key was already used with a different message or scope.");
    let recoveringApprovedOrUnknown = false;
    if (reserved.kind === "replay") {
      const existing = reserved.operation;
      if (existing.state === "rejected") return { state: "rejected", replayed: true };
      if (existing.state === "accepted") return { state: "accepted", ...(existing.remoteMessageId ? { messageId: existing.remoteMessageId } : {}), replayed: true };
      if (existing.state === "unknown" && (existing.firstAttemptAt === null || existing.firstAttemptAt === undefined || existing.firstAttemptAt <= this.now() - REASON_NETWORK_RECOVERY_WINDOW_MS))
        return { state: "unknown", replayed: true };
      if (existing.remoteMessageId) {
        await this.call("message_status", { ids: [existing.remoteMessageId] }, scope.sessionId);
        return { state: "unknown", messageId: existing.remoteMessageId, replayed: true };
      }
      recoveringApprovedOrUnknown = existing.state === "approved" || existing.state === "unknown";
    }
    // Recover only the exact durable operation, preserving its original idempotency key.
    // The original one-use approval was consumed before the first attempted dispatch.
    if (!await this.approvals.isCurrent(scope)) {
      await this.operations.transition(scope, key, ["pending_approval", "approved"], "rejected", undefined, this.now());
      throw new ReasonNetworkSendDeniedError("Grant or conversation is no longer current.");
    }
    if (!recoveringApprovedOrUnknown) {
      const receipt = await this.approvals.consume(binding);
      if (!this.receiptMatches(receipt, binding) || receipt!.expiresAt <= this.now()) {
        await this.operations.transition(scope, key, ["pending_approval"], "rejected", undefined, this.now());
        return { state: "rejected" };
      }
      if (!await this.operations.transition(scope, key, ["pending_approval"], "approved", undefined, this.now())) return { state: "rejected", replayed: true };
    }
    if (!await this.approvals.isCurrent(scope) || this.readiness().state !== "connected_unverified") {
      await this.operations.transition(scope, key, ["approved"], "rejected", undefined, this.now());
      throw new ReasonNetworkSendDeniedError("Scope or transport changed after approval.");
    }
    // Persist an uncertainty fence before the external side effect. Restart recovery
    // can safely replay only this exact operation with its original key.
    if (!await this.operations.transition(scope, key, ["approved", "unknown"], "unknown", undefined, this.now())) return { state: "unknown", replayed: true };
    try {
      const result = await this.call("send_message", { to, message, idempotency_key: key, ...(replyTo ? { reply_to: replyTo } : {}) }, scope.sessionId);
      const id = remoteId(result);
      if (id) { await this.operations.transition(scope, key, ["unknown"], "accepted", id, this.now()); return { state: "accepted", messageId: id }; }
      return { state: "unknown" };
    } catch {
      // Keep the same key/payload durable. A later call may only recover or retry this exact operation.
      return { state: "unknown" };
    }
  }

  private receiptMatches(receipt: ReasonNetworkApprovalReceipt | null, binding: ReasonNetworkApprovalBinding): receipt is ReasonNetworkApprovalReceipt {
    return !!receipt && !!receipt.approvalId && receipt.ownerId === binding.ownerId && receipt.grantId === binding.grantId &&
      receipt.conversationId === binding.conversationId && receipt.sessionId === binding.sessionId && receipt.destination === binding.destination &&
      receipt.message === binding.message && receipt.idempotencyKey === binding.idempotencyKey && receipt.replyTo === binding.replyTo && receipt.payloadDigest === binding.payloadDigest;
  }

  private assertAvailable(): void {
    const state = this.readiness().state; if (state !== "connected_unverified") throw new ReasonNetworkUnavailableError(state);
  }
  private async call(name: ReasonNetworkTool, args: Record<string, unknown>, sessionId = this.config.scope.sessionId): Promise<unknown> {
    this.assertAvailable(); return this.client!.callTool(name, args, { sessionId });
  }
}
