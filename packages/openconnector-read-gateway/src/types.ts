export const UPSTREAM_REVISION = "d89dc9f24f5a057bb500272d7dbf333837c77c68";
export const GATE_PREFIX = "/v1/shiba/read-gate/";
export type ReadOperationId = "figma.get_file_metadata" | "figma.list_comments" | "linear.list_issues_by_team_id" | "github.list_pull_requests" | "googleads.campaign_daily_metrics";
export interface ReadOperation {
  id: ReadOperationId; service: "figma" | "linear" | "github" | "googleads"; inputSchema: Record<string, unknown>;
  method: "GET" | "POST"; origin: string; inputSchemaHash: string; executorHash: string; queryHash: string | null;
  maxPages: 1; maxBytes: 32768;
}
export interface GatewayManifest { format: "shiba.read-gate.v1"; upstreamRevision: string; buildDigest: string; operations: ReadOperation[] }
export interface PlatformVersion { id: string; tag: string }
export interface ReadRequest {
  format: "shiba.scheduled-read.v1"; versionId: string; manifestDigest: string;
  grantId: string; grantVersion: number; occurrenceId: string; stepId: string; stepDigest: string;
  principal: { kind: "schedule"; id: string }; workspaceId: string; alias: string;
  connectionId: string; providerConnectionId: string; authorizationFingerprint: string;
  operationId: ReadOperationId; arguments: Record<string, unknown>; sourceFingerprint?: string; expiresAt: number;
  maxBytes: number; maxDurationMs: number;
  /** Worker-only opaque capabilities; the signing key stays exclusively in the parent. */
  capabilities: { claim: string; dispatch: string; complete: string };
}
/** Private Worker-only credential. Never serialize this object or store it in a receipt. */
export interface OAuthReadCredential { accessToken: string; rawConnectionId: string; revision: string; consentId: string; expiresAt: number | null; privateRedactions?: readonly string[]; developerToken?: string; sourceFingerprint?: string }
export interface GatewayReadReceipt {
  format: "shiba.scheduled-read.receipt.v1"; stepId: string; stepDigest: string; versionId: string; manifestDigest: string;
  operationId: ReadOperationId; state: "completed" | "failed" | "unknown"; capturedAt: number; bytes: number;
  resultJson: string | null; resultDigest: string | null; error: string | null;
  sourceKind: "bounded-fixed-read"; captureCompleteness: "bounded-response" | "unknown"; datasetCompleteness: "unknown"; businessSuccess: "unverified";
}
export interface GatewayAttemptStore {
  /** Persist a unique nonce before credential resolution; duplicates never issue a second provider read. */
  claim(input: ReadRequest, requestDigest: string): Promise<"claimed" | GatewayReadReceipt>;
  /** Final standing-grant/source/budget check and durable dispatch commitment, after all auth awaits. */
  commit(input: ReadRequest, requestDigest: string, credential: OAuthReadCredential): Promise<void>;
  settle(input: ReadRequest, requestDigest: string, receipt: GatewayReadReceipt): Promise<void>;
}
export interface GatewayDependencies {
  enabled: boolean; version: PlatformVersion | undefined; manifest: GatewayManifest;
  /** Existing upstream runtime key and action/connection policy; no new signing credential. */
  verifyRuntime(request: Request, operationId?: ReadOperationId, rawConnectionId?: string): Promise<void>;
  resolveOAuth(input: ReadRequest): Promise<OAuthReadCredential>;
  attempts: GatewayAttemptStore;
  providerFetch?: typeof fetch;
  /** Existing manual upstream entrypoint. It is never used for unknown read-gate paths. */
  manualFetch(request: Request): Promise<Response>;
}
export class ReadGateError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); this.name = "ReadGateError"; }
}
