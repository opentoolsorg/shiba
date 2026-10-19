/**
 * Idempotent thread create (`requestId`) — KV mapping in AGENT_TOKENS.
 */
import { sha256Hex, type AgentTokensEnv } from "./agent-tokens.js";
import { redactSecrets } from "./security.js";

const PREFIX = "v1req_";

export interface ThreadCreateReceipt {
  approvalId: string;
  threadId?: string;
  deduped?: boolean;
  at: number;
}

function key(orgId: string, requestId: string): string {
  return `${PREFIX}${orgId}:${requestId.trim().slice(0, 191)}`;
}

export async function readThreadCreateReceipt(
  env: AgentTokensEnv,
  orgId: string,
  requestId: string,
): Promise<ThreadCreateReceipt | null> {
  if (!requestId.trim()) return null;
  try {
    const raw = await env.AGENT_TOKENS.get(key(orgId, requestId), { type: "text" });
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ThreadCreateReceipt;
    if (typeof parsed.approvalId !== "string" || typeof parsed.at !== "number") return null;
    return parsed;
  } catch (error: unknown) {
    console.warn(
      `v1-idempotency: KV get failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
    );
    return null;
  }
}

export async function writeThreadCreateReceipt(
  env: AgentTokensEnv,
  orgId: string,
  requestId: string,
  receipt: ThreadCreateReceipt,
): Promise<void> {
  if (!requestId.trim()) return;
  try {
    await env.AGENT_TOKENS.put(key(orgId, requestId), JSON.stringify(receipt));
  } catch (error: unknown) {
    console.warn(
      `v1-idempotency: KV put failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
    );
  }
}

/** Stable command id for orchestrator queue dedupe. */
export async function threadCreateCommandId(orgId: string, requestId: string): Promise<string> {
  const digest = await sha256Hex(`${orgId}:${requestId.trim().slice(0, 191)}`);
  return `v1:thread:${digest.slice(0, 40)}`;
}
