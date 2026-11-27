import type { Env } from "../../env.js";
import type { ReadHttpRequest } from "./dispatch.js";
import { stripe } from "./providers/stripe.js";
import { hubspot } from "./providers/hubspot.js";
import { meta } from "./providers/meta.js";

export type ReadProvider = "stripe" | "hubspot" | "meta";
/** Set at draft; part of the credential AAD, the contract and the exact-row predicate. */
export type ReadScopeColumn = "mode";
/** Set at verify from the provider's account response; rebinds the contract digest. */
export type ReadFactColumn = "currency" | "timezone_name";
export const SCOPE_VALUES = { mode: ["live", "test"] } as const satisfies Record<ReadScopeColumn, readonly string[]>;
/** The name each fact column carries in the contract, the public grant and `acceptVerification`'s result. */
export const FACT_KEYS = { currency: "currency", timezone_name: "timezoneName" } as const satisfies Record<ReadFactColumn, string>;

export interface SqlFence { sql: string; values: unknown[] }
export interface HumanSession { id: string; expiresAt: number }
export interface Parser<T> { parse(value: unknown): T }

export interface CredentialScope {
  workspaceId: string;
  ownerAccountId: string;
  credentialId: string;
  revision: number;
  accountId: string;
  mode?: "live" | "test";
  expiresAt: number;
}

export interface Grant {
  id: string;
  workspace_id: string;
  owner_id: string;
  owner_account_id: string;
  owner_json: string;
  account_id: string;
  revision: number;
  expires_at: number;
  ciphertext: string;
  fingerprint: string;
  selection_json: string;
  contract_digest: string;
  executor_digest: string;
  max_calls: number;
  used_calls: number;
  state: string;
  next_due_at: number | null;
  mode?: "live" | "test";
  currency?: string | null;
  timezone_name?: string | null;
}

export interface DraftInput {
  accessToken: string;
  accountId: string;
  expiresAt: number;
  maxCalls: number;
  selection: unknown;
  mode?: "live" | "test";
}

/**
 * Everything that varies between providers: closed data plus five pure functions.
 * An adapter holds no SQL, no session rule, no proof and no state transition; the engine owns all of those,
 * so an adapter cannot weaken a guard.
 */
export interface ReadAdapter<Sel = unknown, Report = unknown> {
  id: ReadProvider;
  /** The only origin the engine will dispatch to for this provider. */
  origin: string;
  executorDigest: string;
  wire: { route: string; grantPrefix: string; receiptPrefix: string };
  tables: { grants: `founder_${ReadProvider}_read_grants`; receipts: `founder_${ReadProvider}_read_receipts` };
  env: { enabled: `FOUNDER_${Uppercase<ReadProvider>}_READS_ENABLED`; key: `FOUNDER_${Uppercase<ReadProvider>}_CREDENTIAL_KEY` };
  /** Stored ciphertext opens only while these stay byte-identical. */
  seal: { aadDomain: string; salt: string; info: string; account: RegExp; token(scope: CredentialScope): RegExp };
  schemas: { draft: Parser<DraftInput>; decision: Parser<{ digest: string }>; report: Parser<Report> };
  scopeColumns: readonly ReadScopeColumn[];
  factColumns: readonly ReadFactColumn[];
  /** `ownerFirst` only records the key order existing contract digests were computed with. */
  contract: { format: string; apiVersion: string; upstreamPin?: string; attestation: Record<string, string>; ownerFirst?: true };
  /** Validates a stored or drafted selection and returns it; throws when it is not exactly this provider's shape. */
  selection(value: unknown): Sel;
  verifyRequest(grant: Grant, secret: string): ReadHttpRequest;
  /** Confirms the response describes the granted account and returns the facts, keyed by FACT_KEYS. */
  acceptVerification(grant: Grant, body: unknown): Record<string, string>;
  readRequest(selection: Sel, grant: Grant, secret: string): ReadHttpRequest;
  project(selection: Sel, body: unknown, grant: Grant): { capture: unknown; extras?: Record<string, unknown>; notice: string };
}

export type ReadsEnv = Env;

const registry = { stripe, hubspot, meta };
export const ADAPTERS: Record<ReadProvider, ReadAdapter> = registry;
/** What `selection()` and the report schema of provider P produce; evidence hands these to consumers already validated. */
type Shapes<P extends ReadProvider> = (typeof registry)[P] extends ReadAdapter<infer Sel, infer Report> ? { selection: Sel; report: Report } : never;
export type SelectionOf<P extends ReadProvider> = Shapes<P>["selection"];
export type ReportOf<P extends ReadProvider> = Shapes<P>["report"];
