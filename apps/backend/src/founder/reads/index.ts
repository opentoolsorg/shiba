import type { Env } from "../../env.js";
import { ADAPTERS, type ReadProvider } from "./adapter.js";
import { assertAvailable } from "./contract.js";
import { handleReads } from "./http.js";
import { tickReads } from "./tick.js";

export type FounderReadsEnv = Env;
export type { ReadProvider } from "./adapter.js";
export { digestJson as sha256Json } from "./contract.js";
export { pinGrant, grantFence, loadEvidence, completedReceipts } from "./evidence.js";
export type { GrantPin, Evidence, SqlFence } from "./evidence.js";

/** An unknown provider is a caller bug: fail loudly instead of acting for some other provider. */
function adapterOf(provider: ReadProvider) {
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new Error("read_provider_unknown");
  return adapter;
}

/** Throws 503 `<provider>_reads_unavailable` unless the provider's reads are switched on and its credential key is set. */
export function assertReadsAvailable(env: Env, provider: ReadProvider): void {
  assertAvailable(adapterOf(provider), env);
}

export function executorDigest(provider: ReadProvider): string {
  return adapterOf(provider).executorDigest;
}

/** Serves the three read-grant routes; any other path is not ours and returns null. */
export function handleFounderReads(request: Request, env: Env): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  const adapter = Object.values(ADAPTERS).find(({ wire }) => pathname === wire.route || pathname.startsWith(`${wire.route}/`));
  return adapter ? handleReads(request, env, adapter) : Promise.resolve(null);
}

export function tickFounderReads(env: Env, provider: ReadProvider) {
  return tickReads(env, adapterOf(provider));
}
