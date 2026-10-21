import {
  type AcpAuthMode,
  type AcpProviderCapabilities,
  type AcpProviderCard,
  type AcpProviderConnection,
  type AcpProviderId,
  type AcpProvidersSnapshot,
  isAcpProviderId,
} from "@shiba/shared";
import type { Env } from "./env.js";
import { ACP_LANES, HARNESS_DEFAULT_MODELS, HARNESSES } from "./harness/index.js";
import type { AgentHarnessName } from "./harness/types.js";
import type { LoginFinish, LoginStart, ProviderLogin } from "./provider-login.js";
import { ProviderLoginError } from "./provider-login.js";
import { InputError } from "./security.js";

const DEVICE_TTL_MS = 15 * 60 * 1000;
const RECORD_PREFIX = "acp_provider:";
const DEFAULT_PREFIX = "acp_provider_default:";

export class ProviderFlowError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ProviderFlowError";
  }
}

interface ProviderDefinition {
  id: AcpProviderId;
  label: string;
  blurb: string;
  adapter: string;
  packageName: string;
  license: string;
  harness: AgentHarnessName;
  protocol: "acp" | "cli";
  spawn: readonly string[];
  docsUrl: string;
  oauth: boolean;
  subscription: "claude-subscription" | "codex-subscription" | null;
  credentialEnv: readonly string[];
  verificationUri: string | null;
}

interface StoredConnection {
  phase: "waiting" | "connected" | "failed";
  authMode: AcpAuthMode;
  message?: string;
  userCode?: string;
  verificationUri?: string;
  expiresAt?: number;
  testedAt?: number;
  testOk?: boolean;
  updatedAt: number;
}

const DISCONNECTED: AcpProviderConnection = {
  phase: "disconnected",
  authMode: null,
  message: null,
  userCode: null,
  verificationUri: null,
  expiresAt: null,
  testedAt: null,
  testOk: null,
};

function capabilities(
  harness: AgentHarnessName,
  extra: Pick<AcpProviderCapabilities, "oauth" | "apiKey" | "acp" | "permissions" | "setModel">,
): AcpProviderCapabilities {
  const harnessImpl = HARNESSES[harness];
  if (harnessImpl === undefined) {
    throw new Error(`ACP provider registry references unknown harness ${harness}.`);
  }
  const declared = harnessImpl.capabilities();
  return {
    streamsText: declared.streamsText,
    toolCalls: declared.emitsToolCalls,
    permissions: extra.permissions,
    setModel: extra.setModel,
    oauth: extra.oauth,
    apiKey: extra.apiKey,
    acp: extra.acp,
  };
}

export const ACP_PROVIDER_REGISTRY: readonly ProviderDefinition[] = [
  {
    id: "claude",
    label: "Claude Code",
    blurb:
      "Claude Code via claude-agent-acp. Sign in with your Claude account (paste the code Claude shows) or use an API credential. The sandbox only sees a dummy key.",
    adapter: "claude-agent-acp",
    packageName: "@agentclientprotocol/claude-agent-acp",
    license: "Apache-2.0",
    harness: "claude-acp",
    protocol: "acp",
    spawn: ACP_LANES["claude-acp"].spec.spawn,
    docsUrl: "https://agentclientprotocol.com",
    oauth: true,
    subscription: "claude-subscription",
    credentialEnv: ["AI_GATEWAY_TOKEN"],
    verificationUri: "https://claude.ai/login",
  },
  {
    id: "codex",
    label: "Codex",
    blurb:
      "Codex via codex-acp. Sign in with ChatGPT: open the device page, enter the code, then finish. Or use an API credential. The sandbox only sees a dummy key.",
    adapter: "codex-acp",
    packageName: "@agentclientprotocol/codex-acp",
    license: "Apache-2.0",
    harness: "codex-acp",
    protocol: "acp",
    spawn: ACP_LANES["codex-acp"].spec.spawn,
    docsUrl: "https://agentclientprotocol.com",
    oauth: true,
    subscription: "codex-subscription",
    credentialEnv: ["AI_GATEWAY_TOKEN"],
    verificationUri: "https://chatgpt.com/",
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    blurb: "Gemini CLI in ACP mode (`gemini --acp`). API-key mode uses the gateway credential.",
    adapter: "gemini",
    packageName: "@google/gemini-cli",
    license: "Apache-2.0",
    harness: "gemini-acp",
    protocol: "acp",
    spawn: ACP_LANES["gemini-acp"].spec.spawn,
    docsUrl: "https://github.com/google-gemini/gemini-cli",
    oauth: false,
    subscription: null,
    credentialEnv: ["AI_GATEWAY_TOKEN"],
    verificationUri: null,
  },
  {
    id: "grok",
    label: "Grok",
    blurb:
      "The pinned Grok CLI speaks streaming JSON, not ACP. Tasks use the grok harness. API-key mode uses the gateway credential.",
    adapter: "grok",
    packageName: "@xai-official/grok",
    license: "see package",
    harness: "grok",
    protocol: "cli",
    spawn: ["grok", "--single"],
    docsUrl: "https://docs.x.ai",
    oauth: false,
    subscription: null,
    credentialEnv: ["AI_GATEWAY_TOKEN"],
    verificationUri: null,
  },
  {
    id: "opencode",
    label: "OpenCode",
    blurb: "OpenCode's ACP server (`opencode acp`). API-key mode uses the gateway credential.",
    adapter: "opencode",
    packageName: "opencode-ai",
    license: "MIT",
    harness: "opencode-acp",
    protocol: "acp",
    spawn: ACP_LANES["opencode-acp"].spec.spawn,
    docsUrl: "https://opencode.ai/docs/",
    oauth: false,
    subscription: null,
    credentialEnv: ["AI_GATEWAY_TOKEN"],
    verificationUri: null,
  },
];

const BY_ID = new Map(ACP_PROVIDER_REGISTRY.map((provider) => [provider.id, provider]));

export function acpProvider(id: string): ProviderDefinition {
  if (!isAcpProviderId(id)) {
    throw new ProviderFlowError(`Unknown provider ${JSON.stringify(id)}.`, 404);
  }
  const provider = BY_ID.get(id);
  if (provider === undefined) {
    throw new ProviderFlowError(`Unknown provider ${JSON.stringify(id)}.`, 404);
  }
  return provider;
}

export function acpAdapterPlan(id: AcpProviderId): {
  providerId: AcpProviderId;
  harness: AgentHarnessName;
  model: string;
  spawn: readonly string[];
} {
  const provider = acpProvider(id);
  if (provider.protocol !== "acp") {
    throw new ProviderFlowError(
      `${provider.label} does not speak ACP in this image. Runs use the ${provider.harness} harness.`,
      400,
    );
  }
  return {
    providerId: id,
    harness: provider.harness,
    model: HARNESS_DEFAULT_MODELS[provider.harness] as string,
    spawn: provider.spawn,
  };
}

export type OauthConfirm = (
  env: Env,
  provider: ProviderDefinition,
  org: string,
) => Promise<{ ok: boolean; message: string }>;

export interface ProviderDeps {
  now?: () => number;
  confirmOauth?: OauthConfirm;
  inspectOauth?: OauthConfirm;
  /** Real vendor sign-in. When set, oauth connect/verify uses it instead of the local confirmation code. */
  login?: ProviderLogin;
}

function nowMs(deps: ProviderDeps): number {
  return deps.now?.() ?? Date.now();
}

function kvOf(env: Env): KVNamespace | null {
  return env.AGENT_TOKENS ?? null;
}

function recordKey(org: string, id: AcpProviderId): string {
  return `${RECORD_PREFIX}${encodeURIComponent(org)}:${id}`;
}

function defaultKey(org: string): string {
  return `${DEFAULT_PREFIX}${encodeURIComponent(org)}`;
}

async function readRecord(
  env: Env,
  org: string,
  id: AcpProviderId,
): Promise<StoredConnection | null> {
  const kv = kvOf(env);
  if (kv === null) return null;
  let raw: string | null;
  try {
    raw = await kv.get(recordKey(org, id), { type: "text" });
  } catch {
    throw new ProviderFlowError("Provider connection store is unreachable.", 503);
  }
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as StoredConnection;
    if (parsed.phase !== "waiting" && parsed.phase !== "connected" && parsed.phase !== "failed") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeRecord(
  env: Env,
  org: string,
  id: AcpProviderId,
  record: StoredConnection,
): Promise<void> {
  const kv = kvOf(env);
  if (kv === null) {
    throw new ProviderFlowError("Provider connection store is not configured.", 503);
  }
  try {
    await kv.put(recordKey(org, id), JSON.stringify(record));
  } catch {
    throw new ProviderFlowError("Provider connection store is unreachable.", 503);
  }
}

async function deleteRecord(env: Env, org: string, id: AcpProviderId): Promise<void> {
  const kv = kvOf(env);
  if (kv === null) return;
  try {
    await kv.delete(recordKey(org, id));
  } catch {
    throw new ProviderFlowError("Provider connection store is unreachable.", 503);
  }
}

async function readDefault(env: Env, org: string): Promise<AcpProviderId | null> {
  const kv = kvOf(env);
  if (kv === null) return null;
  let raw: string | null;
  try {
    raw = await kv.get(defaultKey(org), { type: "text" });
  } catch {
    throw new ProviderFlowError("Provider connection store is unreachable.", 503);
  }
  return raw !== null && isAcpProviderId(raw) ? raw : null;
}

async function writeDefault(env: Env, org: string, id: AcpProviderId | null): Promise<void> {
  const kv = kvOf(env);
  if (kv === null) {
    throw new ProviderFlowError("Provider connection store is not configured.", 503);
  }
  try {
    if (id === null) await kv.delete(defaultKey(org));
    else await kv.put(defaultKey(org), id);
  } catch {
    throw new ProviderFlowError("Provider connection store is unreachable.", 503);
  }
}

function presentCredential(env: Env, names: readonly string[]): string | null {
  const record = env as unknown as Record<string, unknown>;
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim() !== "") return name;
  }
  return null;
}

function deviceCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) {
    out += alphabet[byte % alphabet.length] ?? "A";
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

function publicConnection(record: StoredConnection | null, now: number): AcpProviderConnection {
  if (record === null) return DISCONNECTED;
  const expired =
    record.phase === "waiting" && record.expiresAt !== undefined && record.expiresAt <= now;
  return {
    phase: expired ? "failed" : record.phase,
    authMode: record.authMode,
    message: expired
      ? "The confirmation code expired. Start sign-in again."
      : (record.message ?? null),
    userCode: expired ? null : (record.userCode ?? null),
    verificationUri: expired ? null : (record.verificationUri ?? null),
    expiresAt: record.expiresAt ?? null,
    testedAt: record.testedAt ?? null,
    testOk: record.testOk ?? null,
  };
}

function toCard(
  provider: ProviderDefinition,
  record: StoredConnection | null,
  defaultId: AcpProviderId | null,
  now: number,
): AcpProviderCard {
  return {
    id: provider.id,
    label: provider.label,
    blurb: provider.blurb,
    adapter: provider.adapter,
    packageName: provider.packageName,
    license: provider.license,
    harness: provider.harness,
    protocol: provider.protocol,
    spawn: [...provider.spawn],
    defaultModel: HARNESS_DEFAULT_MODELS[provider.harness] as string,
    docsUrl: provider.docsUrl,
    capabilities: capabilities(provider.harness, {
      oauth: provider.oauth,
      apiKey: true,
      acp: provider.protocol === "acp",
      permissions: provider.protocol === "acp",
      setModel: provider.protocol === "acp",
    }),
    credentialEnv: [...provider.credentialEnv],
    connection: publicConnection(record, now),
    isDefault: defaultId === provider.id,
  };
}

export async function readProviderSnapshot(
  env: Env,
  org: string,
  deps: ProviderDeps = {},
): Promise<AcpProvidersSnapshot> {
  const now = nowMs(deps);
  const defaultId = await readDefault(env, org);
  const providers = await Promise.all(
    ACP_PROVIDER_REGISTRY.map(async (provider) =>
      toCard(provider, await readRecord(env, org, provider.id), defaultId, now),
    ),
  );
  return { org, defaultProviderId: defaultId, providers };
}

export async function connectProvider(
  env: Env,
  org: string,
  id: string,
  mode: unknown,
  deps: ProviderDeps = {},
): Promise<AcpProvidersSnapshot> {
  const provider = acpProvider(id);
  const now = nowMs(deps);
  if (mode === "oauth") {
    if (!provider.oauth || provider.verificationUri === null) {
      throw new InputError(
        `${provider.label} has no sign-in flow. Connect with the API credential instead.`,
      );
    }
    if (deps.login) {
      let started: LoginStart;
      try {
        started = await deps.login.start(env, provider.id, org, now);
      } catch (error) {
        if (error instanceof ProviderLoginError) {
          throw new ProviderFlowError(error.message, error.status);
        }
        throw error;
      }
      await writeRecord(env, org, provider.id, {
        phase: "waiting",
        authMode: "oauth",
        ...(started.userCode ? { userCode: started.userCode } : {}),
        verificationUri: started.verificationUri,
        expiresAt: started.expiresAt,
        message: started.message,
        updatedAt: now,
      });
      return readProviderSnapshot(env, org, deps);
    }
    const code = deviceCode();
    await writeRecord(env, org, provider.id, {
      phase: "waiting",
      authMode: "oauth",
      userCode: code,
      verificationUri: provider.verificationUri,
      expiresAt: now + DEVICE_TTL_MS,
      message:
        "This code only confirms this page. Finish sign-in checks the subscription lane and does not send the code to the vendor.",
      updatedAt: now,
    });
    return readProviderSnapshot(env, org, deps);
  }
  if (mode === "api-key") {
    const name = presentCredential(env, provider.credentialEnv);
    if (name === null) {
      await writeRecord(env, org, provider.id, {
        phase: "failed",
        authMode: "api-key",
        message: `No credential is provisioned. Set ${provider.credentialEnv.join(" or ")} with wrangler secret put. This API does not accept key material.`,
        updatedAt: now,
      });
      return readProviderSnapshot(env, org, deps);
    }
    await writeRecord(env, org, provider.id, {
      phase: "connected",
      authMode: "api-key",
      message: `Using ${name}. The sandbox adapter receives a dummy key; egress attaches this credential for the ${provider.harness} harness.`,
      updatedAt: now,
    });
    return readProviderSnapshot(env, org, deps);
  }
  throw new InputError('mode must be "oauth" or "api-key".');
}

export async function verifyProvider(
  env: Env,
  org: string,
  id: string,
  userCode: unknown,
  deps: ProviderDeps = {},
): Promise<AcpProvidersSnapshot> {
  const provider = acpProvider(id);
  const now = nowMs(deps);
  const record = await readRecord(env, org, provider.id);
  if (record === null || record.phase !== "waiting") {
    throw new ProviderFlowError("There is no sign-in in progress for this provider.", 409);
  }
  if (record.expiresAt !== undefined && record.expiresAt <= now) {
    await writeRecord(env, org, provider.id, {
      ...record,
      phase: "failed",
      message: "The confirmation code expired. Start sign-in again.",
      userCode: undefined,
      updatedAt: now,
    });
    return readProviderSnapshot(env, org, deps);
  }
  if (deps.login) {
    const pasted = typeof userCode === "string" ? userCode : "";
    let verdict: LoginFinish;
    try {
      verdict = await deps.login.finish(env, provider.id, org, pasted, now);
    } catch (error) {
      if (error instanceof ProviderLoginError) {
        if (error.status === 400) throw new InputError(error.message);
        throw new ProviderFlowError(error.message, error.status);
      }
      throw error;
    }
    const fresh = await readRecord(env, org, provider.id);
    // A disconnect during the vendor round-trip wins. A userCode mismatch
    // must not discard a finished grant: that left Finish looking idle.
    if (fresh === null || fresh.phase !== "waiting") {
      return readProviderSnapshot(env, org, deps);
    }
    await writeRecord(env, org, provider.id, {
      phase: verdict.phase,
      authMode: "oauth",
      message: verdict.message,
      ...(verdict.phase === "waiting"
        ? {
            ...(fresh.userCode ? { userCode: fresh.userCode } : {}),
            ...(fresh.verificationUri ? { verificationUri: fresh.verificationUri } : {}),
            ...(fresh.expiresAt !== undefined ? { expiresAt: fresh.expiresAt } : {}),
          }
        : {}),
      updatedAt: now,
    });
    return readProviderSnapshot(env, org, deps);
  }
  if (
    typeof userCode !== "string" ||
    userCode.trim() === "" ||
    userCode.trim() !== record.userCode
  ) {
    throw new InputError("The confirmation code does not match this sign-in.");
  }
  const confirm = deps.confirmOauth;
  if (confirm === undefined) {
    throw new ProviderFlowError("Sign-in confirmation is not configured.", 500);
  }
  const verdict = await confirm(env, provider, org);
  const fresh = await readRecord(env, org, provider.id);
  if (
    fresh === null ||
    fresh.phase !== "waiting" ||
    fresh.updatedAt !== record.updatedAt ||
    fresh.userCode !== record.userCode
  ) {
    return readProviderSnapshot(env, org, deps);
  }
  await writeRecord(env, org, provider.id, {
    phase: verdict.ok ? "connected" : "failed",
    authMode: "oauth",
    message: verdict.message,
    updatedAt: now,
  });
  return readProviderSnapshot(env, org, deps);
}

export async function testProvider(
  env: Env,
  org: string,
  id: string,
  deps: ProviderDeps = {},
): Promise<AcpProvidersSnapshot> {
  const provider = acpProvider(id);
  const now = nowMs(deps);
  const record = await readRecord(env, org, provider.id);
  if (record === null || record.phase !== "connected") {
    throw new ProviderFlowError("Connect the provider before testing it.", 409);
  }
  let ok = false;
  let message = record.message ?? "Test failed.";
  if (record.authMode === "api-key") {
    const name = presentCredential(env, provider.credentialEnv);
    ok = name !== null;
    message = ok
      ? `Credential ${name} is still present.`
      : `Credential missing. Set ${provider.credentialEnv.join(" or ")}.`;
  } else if (deps.login && record.authMode === "oauth") {
    const verdict = await deps.login.probe(env, provider.id, org, now);
    ok = verdict.ok;
    message = verdict.message;
  } else if (deps.inspectOauth !== undefined) {
    const verdict = await deps.inspectOauth(env, provider, org);
    const name = presentCredential(env, provider.credentialEnv);
    if (!verdict.ok) {
      message = verdict.message;
    } else if (name === null) {
      message = `Subscription lane is authenticated. Set ${provider.credentialEnv.join(" or ")} before the ${provider.harness} harness can run.`;
    } else {
      ok = true;
      message = `Subscription lane is authenticated. Credential ${name} is present for the ${provider.harness} harness.`;
    }
  }
  const fresh = await readRecord(env, org, provider.id);
  if (fresh === null || fresh.phase !== "connected" || fresh.updatedAt !== record.updatedAt) {
    return readProviderSnapshot(env, org, deps);
  }
  await writeRecord(env, org, provider.id, {
    ...fresh,
    message,
    testedAt: now,
    testOk: ok,
    updatedAt: now,
  });
  return readProviderSnapshot(env, org, deps);
}

export async function disconnectProvider(
  env: Env,
  org: string,
  id: string,
  deps: ProviderDeps = {},
): Promise<AcpProvidersSnapshot> {
  const provider = acpProvider(id);
  if (deps.login) await deps.login.forget(env, provider.id, org);
  await deleteRecord(env, org, provider.id);
  if ((await readDefault(env, org)) === provider.id) {
    await writeDefault(env, org, null);
  }
  return readProviderSnapshot(env, org, deps);
}

export async function setDefaultProvider(
  env: Env,
  org: string,
  id: string,
  deps: ProviderDeps = {},
): Promise<AcpProvidersSnapshot> {
  const provider = acpProvider(id);
  const record = await readRecord(env, org, provider.id);
  if (record === null || record.phase !== "connected") {
    throw new ProviderFlowError("Only a connected provider can be the org default.", 409);
  }
  await writeDefault(env, org, provider.id);
  return readProviderSnapshot(env, org, deps);
}

export type { ProviderDefinition };
