/** Wire helpers for ChatGPT subscription settings — safe to unit test without DOM. */

export type SubscriptionStatus = {
  connected: boolean;
  accountEmailHash?: string;
  expiresAt?: number;
  savedAt?: number;
};

export function parseSubscriptionStatus(body: unknown): SubscriptionStatus {
  if (typeof body !== "object" || body === null) return { connected: false };
  const record = body as Record<string, unknown>;
  return {
    connected: record.connected === true,
    ...(typeof record.accountEmailHash === "string" ? { accountEmailHash: record.accountEmailHash } : {}),
    ...(typeof record.expiresAt === "number" ? { expiresAt: record.expiresAt } : {}),
    ...(typeof record.savedAt === "number" ? { savedAt: record.savedAt } : {}),
  };
}

export function pasteRequestBody(authJson: string): string {
  return JSON.stringify({ authJson });
}

/** UI must clear the paste field after a successful connect — never echo secrets. */
export function pasteFieldAfterSuccessfulConnect(_savedAuthJson: string): string {
  return "";
}
