import { decryptAuthJson, encryptAuthJson } from "./subscription-credentials.js";

export class SlackInstallationError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); this.name = "SlackInstallationError"; }
}
export interface SlackKeyringEnv { SLACK_INSTALLATION_KEYRING?: string }
function keyring(env: SlackKeyringEnv): { activeKeyId: string; keys: Record<string, string> } {
  try {
    if (!env.SLACK_INSTALLATION_KEYRING || env.SLACK_INSTALLATION_KEYRING.length > 1_024) throw new Error();
    const value = JSON.parse(env.SLACK_INSTALLATION_KEYRING);
    if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "activeKeyId,keys" || typeof value.activeKeyId !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(value.activeKeyId) || !value.keys || typeof value.keys !== "object" || Array.isArray(value.keys)) throw new Error();
    const entries = Object.entries(value.keys);
    if (entries.length < 1 || entries.length > 3 || !entries.every(([id, key]) => /^[A-Za-z0-9_-]{1,40}$/.test(id) && typeof key === "string" && /^[a-fA-F0-9]{64}$/.test(key)) || !Object.hasOwn(value.keys, value.activeKeyId)) throw new Error();
    return value;
  } catch { throw new SlackInstallationError("slack_installation_keyring_unavailable", 503); }
}
export function slackKeyringConfigured(env: SlackKeyringEnv): boolean { try { keyring(env); return true; } catch { return false; } }
export async function sealSlackSecret(env: SlackKeyringEnv, scope: { workspaceId: string; subject: string; purpose: string }, plaintext: string): Promise<{ keyId: string; cipher: string }> {
  if (new TextEncoder().encode(plaintext).length > 32_768) throw new SlackInstallationError("slack_credential_too_large", 413);
  const keys = keyring(env);
  return { keyId: keys.activeKeyId, cipher: await encryptAuthJson(plaintext, keys.keys[keys.activeKeyId]!, scope.workspaceId, scope.subject, `slack-installation-v1:${scope.purpose}`) };
}
export async function openSlackSecret(env: SlackKeyringEnv, scope: { workspaceId: string; subject: string; purpose: string }, stored: { keyId: string; cipher: string }): Promise<string> {
  const keys = keyring(env), key = Object.hasOwn(keys.keys, stored.keyId) ? keys.keys[stored.keyId] : undefined;
  if (!key || stored.cipher.length > 65_536) throw new SlackInstallationError("slack_credential_unavailable", 503);
  try { return await decryptAuthJson(stored.cipher, key, scope.workspaceId, scope.subject, `slack-installation-v1:${scope.purpose}`); }
  catch { throw new SlackInstallationError("slack_credential_unavailable", 503); }
}
