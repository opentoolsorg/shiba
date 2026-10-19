/**
 * Linear webhook verification and AgentSessionEvent parsing.
 * @see apps/web/src/content/docs/docs/linear-agent-session.md
 */
import { timingSafeEqual } from "../slack.js";

export interface LinearAgentSessionEvent {
  action: "created" | "prompted" | string;
  agentSession?: {
    id?: string;
    issue?: { id?: string; identifier?: string; title?: string; team?: { key?: string } };
  };
  promptContext?: string;
  agentActivity?: { body?: string };
}

export async function verifyLinearWebhook(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!secret || !signatureHeader) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return timingSafeEqual(signatureHeader, expected);
}

export function parseLinearAgentSessionPayload(body: unknown): LinearAgentSessionEvent | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const action = typeof record.action === "string" ? record.action : "";
  if (!action) return null;
  const agentSession =
    typeof record.agentSession === "object" && record.agentSession !== null
      ? (record.agentSession as LinearAgentSessionEvent["agentSession"])
      : undefined;
  return {
    action,
    agentSession,
    promptContext: typeof record.promptContext === "string" ? record.promptContext : undefined,
    agentActivity:
      typeof record.agentActivity === "object" && record.agentActivity !== null
        ? (record.agentActivity as { body?: string })
        : undefined,
  };
}

export function linearSessionThreadKey(sessionId: string): string {
  return `linear:session:${sessionId}`;
}

export function linearAutomationTask(event: LinearAgentSessionEvent): string {
  const issue = event.agentSession?.issue;
  const id = issue?.identifier ?? issue?.id ?? "issue";
  const title = issue?.title ?? "Linear issue";
  const header = `Linear ${id}: ${title}`;
  if (event.action === "prompted" && event.agentActivity?.body) {
    return `${header}\n\nFollow-up:\n${event.agentActivity.body}`;
  }
  if (event.promptContext?.trim()) {
    return `${header}\n\n${event.promptContext.trim()}`;
  }
  return header;
}
