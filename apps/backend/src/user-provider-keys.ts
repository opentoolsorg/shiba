/**
 * Per-user provider secrets (API keys and a Claude setup-token).
 * Ciphertext lives in AGENT_TOKENS. Egress reads it; responses never do.
 */
import type { Env } from "./env.js";
import { decryptAuthJson, encryptAuthJson, modelCredentialKeyConfigured } from "./subscription-credentials.js";

export const USER_SECRET_KINDS = ["google", "xai", "opencode", "claude-setup", "openai-api", "anthropic-api", "openrouter", "groq", "copilot"] as const;
export type UserSecretKind = (typeof USER_SECRET_KINDS)[number];

const SECRET_PREFIX = "user_provider_secret:";
const OWNER_PREFIX = "user_provider_owner:";
const WORKSPACE = "installation";

type KeyEnv = Pick<Env, "MODEL_CREDENTIAL_KEY"> & {
  AGENT_TOKENS?: Env["AGENT_TOKENS"];
};

function secretKey(userId: string, kind: UserSecretKind): string {
  return `${SECRET_PREFIX}${encodeURIComponent(userId)}:${kind}`;
}

function ownerKey(orgId: string, kind: UserSecretKind): string {
  return `${OWNER_PREFIX}${encodeURIComponent(orgId)}:${kind}`;
}

export function pasteProviderKind(id: string): UserSecretKind | null {
  if (id === "gemini") return "google";
  if (id === "grok") return "xai";
  if (id === "opencode") return "opencode";
  if (id === "openai") return "openai-api";
  if (id === "anthropic") return "anthropic-api";
  if (id === "openrouter" || id === "groq" || id === "copilot") return id;
  return null;
}

export function kindForHost(host: string): UserSecretKind | null {
  if (host === "generativelanguage.googleapis.com") return "google";
  if (host === "api.x.ai") return "xai";
  if (host === "opencode.ai" || host === "api.deepseek.com") return "opencode";
  if (host === "api.anthropic.com") return "anthropic-api";
  if (host === "api.openai.com") return "openai-api";
  if (host === "openrouter.ai") return "openrouter";
  if (host === "api.groq.com") return "groq";
  if (host === "api.githubcopilot.com") return "copilot";
  return null;
}

export function assertPastableSecret(value: string): string {
  const secret = value.trim();
  if (secret.length < 12 || secret.length > 4_000 || /\s/.test(secret)) {
    throw new Error("Paste the key from the provider. This page does not take a file or a sentence.");
  }
  return secret;
}

export async function putUserProviderSecret(
  env: KeyEnv,
  userId: string,
  kind: UserSecretKind,
  secret: string,
): Promise<void> {
  if (!env.AGENT_TOKENS || !modelCredentialKeyConfigured(env)) {
    throw new Error("Sign-in storage is not ready on this deployment.");
  }
  const cipher = await encryptAuthJson(secret, env.MODEL_CREDENTIAL_KEY!, WORKSPACE, userId, kind);
  await env.AGENT_TOKENS.put(secretKey(userId, kind), cipher);
  await env.AGENT_TOKENS.put(ownerKey(userId, kind), userId);
}

export async function readUserProviderSecret(
  env: KeyEnv,
  userId: string,
  kind: UserSecretKind,
): Promise<string | null> {
  if (!env.AGENT_TOKENS || !modelCredentialKeyConfigured(env) || userId.trim() === "") return null;
  const cipher = await env.AGENT_TOKENS.get(secretKey(userId, kind), { type: "text" });
  if (!cipher) return null;
  try {
    const plain = await decryptAuthJson(cipher, env.MODEL_CREDENTIAL_KEY!, WORKSPACE, userId, kind);
    return plain.trim() === "" ? null : plain;
  } catch {
    return null;
  }
}

export async function readProviderSecretForOrg(
  env: KeyEnv,
  orgId: string | undefined,
  kind: UserSecretKind,
  credentialUserId?: string,
): Promise<string | null> {
  const org = orgId?.trim() || "self-hosted";
  if (credentialUserId?.trim()) {
    return readUserProviderSecret(env, credentialUserId.trim(), kind);
  }
  const direct = await readUserProviderSecret(env, org, kind);
  if (direct) return direct;
  if (!env.AGENT_TOKENS) return null;
  const owner = await env.AGENT_TOKENS.get(ownerKey(org, kind), { type: "text" });
  if (!owner || owner === org) return null;
  if (credentialUserId !== undefined && credentialUserId.trim() !== "" && owner !== credentialUserId.trim()) {
    return null;
  }
  return readUserProviderSecret(env, owner, kind);
}

export async function deleteUserProviderSecret(env: KeyEnv, userId: string, kind: UserSecretKind): Promise<void> {
  if (!env.AGENT_TOKENS) return;
  await env.AGENT_TOKENS.delete(secretKey(userId, kind));
}
