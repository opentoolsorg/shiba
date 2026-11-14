import { encryptAuthJson, decryptAuthJson } from "../subscription-credentials.js";
import type { Env } from "../env.js";

function requireKey(env: Pick<Env, "MODEL_CREDENTIAL_KEY">): string {
  const key = env.MODEL_CREDENTIAL_KEY?.trim();
  if (!key || !/^[a-fA-F0-9]{64}$/.test(key)) {
    throw new Error("MODEL_CREDENTIAL_KEY is not configured.");
  }
  return key;
}

export async function sealWebhookSecret(
  env: Pick<Env, "MODEL_CREDENTIAL_KEY">,
  workspaceId: string,
  subscriptionId: string,
  secret: string,
): Promise<{ keyId: string; cipher: string }> {
  const key = requireKey(env);
  return {
    keyId: "webhook-v1",
    cipher: await encryptAuthJson(secret, key, workspaceId, subscriptionId, "webhook-subscription-secret"),
  };
}

export async function openWebhookSecret(
  env: Pick<Env, "MODEL_CREDENTIAL_KEY">,
  workspaceId: string,
  subscriptionId: string,
  stored: { keyId: string; cipher: string },
): Promise<string> {
  const key = requireKey(env);
  return decryptAuthJson(stored.cipher, key, workspaceId, subscriptionId, "webhook-subscription-secret");
}

export function generateWebhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `whsec_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}