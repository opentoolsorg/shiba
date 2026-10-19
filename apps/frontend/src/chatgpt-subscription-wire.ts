/** Wire helpers for ChatGPT SIWC settings — safe to unit test without DOM. */

export type SubscriptionStatus = {
  connected: boolean;
  planUsageEnabled?: boolean;
  accountEmailHash?: string;
  expiresAt?: number;
  savedAt?: number;
};

export type SignInBegin = {
  authorizeUrl: string;
  redirectUri: string;
  flowId: string;
};

export function parseSubscriptionStatus(body: unknown): SubscriptionStatus {
  if (typeof body !== "object" || body === null) return { connected: false };
  const record = body as Record<string, unknown>;
  return {
    connected: record.connected === true,
    ...(record.planUsageEnabled === false ? { planUsageEnabled: false } : {}),
    ...(typeof record.accountEmailHash === "string" ? { accountEmailHash: record.accountEmailHash } : {}),
    ...(typeof record.expiresAt === "number" ? { expiresAt: record.expiresAt } : {}),
    ...(typeof record.savedAt === "number" ? { savedAt: record.savedAt } : {}),
  };
}

export function parseSignInBegin(body: unknown): SignInBegin | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (
    typeof record.authorizeUrl === "string" &&
    typeof record.redirectUri === "string" &&
    typeof record.flowId === "string"
  ) {
    return { authorizeUrl: record.authorizeUrl, redirectUri: record.redirectUri, flowId: record.flowId };
  }
  return null;
}

export function completeRequestBody(callbackUrl: string): string {
  return JSON.stringify({ callbackUrl });
}

/** UI must clear the callback field after success — never echo secrets. */
export function callbackFieldAfterSuccess(_url: string): string {
  return "";
}
