import type { AcpProviderConnection } from "@shiba/shared";

/** A provider test is useful evidence, but it is not a permanent health lease. */
export const PROVIDER_TEST_FRESH_MS = 15 * 60_000;

export type ProviderLifecycleStatus =
  | "available"
  | "partiallyConfigured"
  | "configured"
  | "connected"
  | "authenticated"
  | "tested"
  | "stale"
  | "testFailed"
  | "waiting"
  | "disconnected"
  | "failed"
  | "revoked"
  | "error"
  | "unsupported"
  | "planned";

/** Project the persisted provider state without inferring authentication from a stored key. */
export function providerLifecycleStatus(
  connection: Pick<AcpProviderConnection, "phase" | "authMode" | "testOk" | "testedAt">,
  now = Date.now(),
): ProviderLifecycleStatus {
  if (connection.phase === "disconnected") return "disconnected";
  if (connection.phase === "waiting") return "waiting";
  if (connection.phase === "failed") return "failed";
  if (connection.testOk === false) return "testFailed";
  if (connection.testOk !== true || connection.testedAt === null) {
    if (connection.authMode === "oauth") return "authenticated";
    if (connection.authMode === "api-key") return "configured";
    return "connected";
  }
  const age = now - connection.testedAt;
  if (age < 0 || age > PROVIDER_TEST_FRESH_MS) return "stale";
  return "tested";
}

export function providerTestDescription(
  connection: Pick<AcpProviderConnection, "phase" | "authMode" | "testOk" | "testedAt" | "message" | "operatorSteps">,
  now = Date.now(),
): string {
  const guidance = [connection.message, ...(connection.operatorSteps ?? [])]
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .join(" ");
  let evidence: string;
  if (connection.phase === "disconnected") evidence = "No provider connection is stored. Configure it to connect.";
  else if (connection.phase === "waiting") evidence = "Provider sign-in is pending.";
  else if (connection.phase === "failed") evidence = "The connection attempt failed.";
  else if (connection.testOk === null || connection.testedAt === null) evidence = connection.authMode === "oauth"
    ? "OAuth sign-in completed and the connection is stored; no freshness check has been recorded."
    : connection.authMode === "api-key"
      ? "A credential is stored; no credential check has been recorded."
      : "A connection is stored; no health check has been recorded.";
  else if (connection.authMode === "api-key") evidence = connection.testOk
    ? "The saved credential is present; the provider API was not contacted."
    : "The saved credential check failed; the provider API was not contacted.";
  else evidence = connection.testOk ? "The stored sign-in was checked by Shiba." : "The stored sign-in check failed.";
  const stale = connection.testedAt !== null && connection.testedAt !== undefined &&
    (now - connection.testedAt < 0 || now - connection.testedAt > PROVIDER_TEST_FRESH_MS);
  return [stale ? "The prior test result is stale." : "", evidence, guidance].filter(Boolean).join(" ");
}
