import type { WorkspaceNativeMember } from "../../workspace-native-authority.js";
import { WorkspaceIntegrationError } from "../../workspace-integrations-store.js";
import { FACT_KEYS, type CredentialScope, type Grant, type ReadAdapter, type ReadsEnv } from "./adapter.js";

export async function digestJson(value: unknown) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)))), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function assertAvailable(adapter: ReadAdapter, env: ReadsEnv): void {
  if (env[adapter.env.enabled] !== "true" || !/^[a-f0-9]{64}$/i.test(env[adapter.env.key] ?? "")) throw new WorkspaceIntegrationError(`${adapter.id}_reads_unavailable`, 503);
}

/** The columns a contract covers. A draft supplies them before the row exists. */
type Terms = Pick<Grant, "id" | "workspace_id" | "owner_account_id" | "owner_json" | "account_id" | "revision" | "expires_at" | "fingerprint" | "selection_json" | "max_calls" | "mode" | "currency" | "timezone_name">;

export const ownerOf = (grant: Pick<Grant, "owner_json">) => JSON.parse(grant.owner_json) as WorkspaceNativeMember;

/** Key order is part of the credential AAD and of every stored contract digest. */
export function scopeOf(adapter: ReadAdapter, grant: Terms): CredentialScope {
  return { workspaceId: grant.workspace_id, ownerAccountId: grant.owner_account_id, credentialId: grant.id, revision: grant.revision, accountId: grant.account_id, ...Object.fromEntries(adapter.scopeColumns.map((column) => [column, grant[column]])), expiresAt: grant.expires_at };
}

const facts = (adapter: ReadAdapter, grant: Terms) => Object.fromEntries(adapter.factColumns.map((column) => [FACT_KEYS[column], grant[column] ?? null]));

export async function contractDigest(adapter: ReadAdapter, grant: Terms) {
  const member = ownerOf(grant);
  const owner = { userId: member.userId, accountId: member.accountId, workspaceId: member.workspaceId, role: member.role, version: member.version };
  const terms = adapter.contract;
  return digestJson({
    ...(terms.ownerFirst ? { owner, format: terms.format } : { format: terms.format, owner }),
    ...scopeOf(adapter, grant),
    fingerprint: grant.fingerprint,
    selection: adapter.selection(JSON.parse(grant.selection_json)),
    maxCalls: grant.max_calls,
    ...facts(adapter, grant),
    executorDigest: adapter.executorDigest,
    ...(terms.upstreamPin ? { upstreamPin: terms.upstreamPin } : {}),
    apiVersion: terms.apiVersion,
    schedule: "daily-fixed-interval",
    maxBytes: 32768,
    maxDurationMs: 5000,
    maxPages: 1,
    ...terms.attestation,
  });
}

/** True only when the row still is the contract its owner reviewed, under the executor that is running now. */
export async function validContract(adapter: ReadAdapter, grant: Grant) {
  try {
    const member = ownerOf(grant);
    if (!adapter.seal.account.test(grant.account_id) || member.workspaceId !== grant.workspace_id || member.accountId !== grant.owner_account_id || member.userId !== grant.owner_id) return false;
    return grant.executor_digest === adapter.executorDigest && await contractDigest(adapter, grant) === grant.contract_digest;
  } catch {
    return false;
  }
}

export function publicGrant(adapter: ReadAdapter, grant: Grant) {
  return {
    id: grant.id, accountId: grant.account_id, ...Object.fromEntries(adapter.scopeColumns.map((column) => [column, grant[column]])),
    revision: grant.revision, expiresAt: grant.expires_at, fingerprint: grant.fingerprint, digest: grant.contract_digest, selection: JSON.parse(grant.selection_json) as unknown,
    maxCalls: grant.max_calls, usedCalls: grant.used_calls, state: grant.state, nextDueAt: grant.next_due_at, executorDigest: grant.executor_digest,
    apiVersion: adapter.contract.apiVersion, schedule: "daily-fixed-interval", maxBytes: 32768, maxDurationMs: 5000, maxPages: 1,
    ...Object.fromEntries(adapter.factColumns.map((column) => [FACT_KEYS[column], grant[column]])),
  };
}
