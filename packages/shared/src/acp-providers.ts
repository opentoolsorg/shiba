export const ACP_PROVIDER_IDS = ["claude", "codex", "gemini", "grok", "opencode"] as const;
export type AcpProviderId = (typeof ACP_PROVIDER_IDS)[number];

export interface AcpProviderCapabilities {
  streamsText: boolean;
  toolCalls: boolean;
  permissions: boolean;
  setModel: boolean;
  oauth: boolean;
  apiKey: boolean;
  acp: boolean;
}

export type AcpConnectionPhase = "disconnected" | "waiting" | "connected" | "failed";
export type AcpAuthMode = "oauth" | "api-key";

export interface AcpProviderConnection {
  phase: AcpConnectionPhase;
  authMode: AcpAuthMode | null;
  message: string | null;
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
  harness: string;
  protocol: "acp" | "cli";
  spawn: string[];
  defaultModel: string;
  docsUrl: string;
  capabilities: AcpProviderCapabilities;
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
