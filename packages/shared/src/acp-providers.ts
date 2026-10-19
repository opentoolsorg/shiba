/**
 * Wire contract for the dashboard Providers page.
 *
 * Each entry is an agent the sandbox can launch. `capabilities.acp` means
 * the child speaks the Agent Client Protocol (JSON-RPC 2.0 over stdio):
 * initialize, session/new, session/prompt, session/update, and
 * session/request_permission. Adapters that do not speak ACP stay on
 * their CLI harness and say so — the card must not claim a protocol the
 * pinned binary does not implement.
 *
 * Connection records carry no credential material. OAuth completion reuses
 * the deployment's Claude and Codex subscription probes; API-key mode only
 * records which Worker secret or gateway token is present.
 */
export const ACP_PROVIDER_IDS = ["claude", "codex", "gemini", "grok", "opencode"] as const;
export type AcpProviderId = (typeof ACP_PROVIDER_IDS)[number];

export interface AcpProviderCapabilities {
  streamsText: boolean;
  toolCalls: boolean;
  /** session/request_permission is answered by the sandbox driver. */
  permissions: boolean;
  /** session/set_model. Adapters may answer -32601 and keep their default. */
  setModel: boolean;
  /** Device-code sign-in that redeems the Claude or Codex subscription lane. */
  oauth: boolean;
  /** Presence of a named Worker secret or AI_GATEWAY_TOKEN. Never a pasted key. */
  apiKey: boolean;
  /** The sandbox child is an ACP server. */
  acp: boolean;
}

export type AcpConnectionPhase = "disconnected" | "waiting" | "connected" | "failed";
export type AcpAuthMode = "oauth" | "api-key";

export interface AcpProviderConnection {
  phase: AcpConnectionPhase;
  authMode: AcpAuthMode | null;
  message: string | null;
  /** Device-flow confirmation code. Not a vendor token. */
  userCode: string | null;
  verificationUri: string | null;
  expiresAt: number | null;
  testedAt: number | null;
  testOk: boolean | null;
}

export interface AcpProviderCard {
  id: AcpProviderId;
  label: string;
  blurb: string;
  adapter: string;
  packageName: string;
  license: string;
  /** Harness id a run passes to execute this provider in the sandbox. */
  harness: string;
  protocol: "acp" | "cli";
  spawn: string[];
  defaultModel: string;
  docsUrl: string;
  capabilities: AcpProviderCapabilities;
  /** Env names whose presence satisfies API-key mode, in preference order. */
  credentialEnv: string[];
  connection: AcpProviderConnection;
  isDefault: boolean;
}

export interface AcpProvidersSnapshot {
  org: string;
  defaultProviderId: AcpProviderId | null;
  providers: AcpProviderCard[];
}

export function isAcpProviderId(value: string): value is AcpProviderId {
  return (ACP_PROVIDER_IDS as readonly string[]).includes(value);
}
